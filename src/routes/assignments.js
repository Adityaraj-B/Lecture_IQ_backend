import { Router } from 'express';
import { requireRole } from '../middleware/session.js';
import { assignmentResults, grade, summarize } from '../services/analytics.js';
import { sanitizeQuestions } from '../services/mcq.js';
import { layoutFor, questionsFor, toCanonical, toStudentOrder } from '../services/shuffle.js';
import { newId } from '../store/db.js';

const MAX_QUESTIONS = 50;
const MAX_DURATION_MS = 6 * 60 * 60 * 1000;
const MAX_TIME_LIMIT_MIN = 180;
/** Slack for slow networks: a submission sent just before the deadline still counts. */
const GRACE_MS = 2 * 60 * 1000;

const isClosed = (a, now = Date.now()) => Boolean(a.dueAt) && now > Date.parse(a.dueAt);

/** When this student's attempt must end: the due date or their time limit, whichever is first. */
function deadlineFor(a, startedAt) {
  const limit = a.timeLimitMin && startedAt ? Date.parse(startedAt) + a.timeLimitMin * 60_000 : null;
  const due = a.dueAt ? Date.parse(a.dueAt) : null;
  const end = [limit, due].filter((x) => x != null);
  return end.length ? new Date(Math.min(...end)).toISOString() : null;
}

function baseView(db, a) {
  return {
    id: a.id,
    courseId: a.courseId,
    courseName: db.course(a.courseId)?.name ?? '',
    professorName: db.user(a.professorId)?.name ?? '',
    title: a.title,
    subject: a.subject,
    difficulty: a.difficulty,
    publishedAt: a.publishedAt,
    questionCount: a.questions.length,
    dueAt: a.dueAt ?? null,
    timeLimitMin: a.timeLimitMin ?? null,
    closed: isClosed(a),
  };
}

/**
 * A student's view: their own question/option order; no answers or explanations until
 * they've submitted.
 */
export function studentView(db, a, studentId) {
  const sub = db.submission(a.id, studentId);
  const layout = layoutFor(a, studentId);
  const startedAt = a.starts?.[studentId] ?? null;
  const base = { ...baseView(db, a), startedAt, deadline: deadlineFor(a, startedAt) };
  if (!sub) return { ...base, questions: questionsFor(a, layout, { withAnswers: false }) };

  const { submitted, average } = summarize(db.submissionsFor(a.id), 0);
  return {
    ...base,
    questions: questionsFor(a, layout, { withAnswers: true }),
    submission: {
      answers: toStudentOrder(sub.answers, layout),
      score: sub.score,
      total: sub.total,
      durationMs: sub.durationMs,
      submittedAt: sub.submittedAt,
    },
    classStats: { submitted, average },
  };
}

function professorView(db, a) {
  const enrolled = db.course(a.courseId)?.studentIds.length ?? 0;
  const subs = db.submissionsFor(a.id);
  return {
    ...baseView(db, a),
    lectureId: a.lectureId,
    shuffle: Boolean(a.shuffle),
    questions: a.questions,
    stats: summarize(subs, enrolled),
    // Who has taken it, most recent first.
    submittedBy: [...subs]
      .sort((x, y) => y.submittedAt.localeCompare(x.submittedAt))
      .map((x) => ({ id: x.studentId, name: db.user(x.studentId)?.name ?? 'Unknown' })),
  };
}

/** Optional ISO date in the future (a past due date would publish an already-closed quiz). */
function parseDue(v) {
  if (v == null || v === '') return { ok: true, value: null };
  const t = Date.parse(v);
  if (Number.isNaN(t) || t <= Date.now()) return { ok: false };
  return { ok: true, value: new Date(t).toISOString() };
}

export function assignmentsRouter({ db, hub }) {
  const router = Router();

  const visibleTo = (user, a) => {
    const course = a && db.course(a.courseId);
    if (!course) return false;
    return user.role === 'professor' ? course.professorId === user.id : course.studentIds.includes(user.id);
  };

  router.get('/', (req, res) => {
    const courseIds = db.coursesOf(req.user).map((c) => c.id);
    const list = db.assignmentsInCourses(courseIds).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    res.json({
      assignments: list.map((a) => (req.user.role === 'professor' ? professorView(db, a) : studentView(db, a, req.user.id))),
    });
  });

  /**
   * POST /v1/assignments  (professor)
   * { courseId, title, subject?, lectureId?, difficulty?, questions, dueAt?, timeLimitMin?, shuffle? }
   */
  router.post('/', requireRole('professor'), (req, res) => {
    const course = db.course(req.body?.courseId);
    if (!course || course.professorId !== req.user.id) return res.status(404).json({ error: 'Class not found' });

    const raw = Array.isArray(req.body?.questions) ? req.body.questions.slice(0, MAX_QUESTIONS + 1) : [];
    if (raw.length === 0 || raw.length > MAX_QUESTIONS) {
      return res.status(400).json({ error: `A quiz needs 1-${MAX_QUESTIONS} questions` });
    }
    const questions = sanitizeQuestions(raw, { shuffle: false });
    if (questions.length !== raw.length) return res.status(400).json({ error: 'Some questions are malformed or repeated' });

    const due = parseDue(req.body.dueAt);
    if (!due.ok) return res.status(400).json({ error: 'The due date must be in the future' });
    const limit = req.body.timeLimitMin == null ? null : Number(req.body.timeLimitMin);
    if (limit != null && !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_TIME_LIMIT_MIN)) {
      return res.status(400).json({ error: `Time limit must be 1-${MAX_TIME_LIMIT_MIN} minutes` });
    }

    const title = String(req.body.title ?? '').trim().slice(0, 120) || 'Quiz';
    const a = {
      id: newId(),
      courseId: course.id,
      professorId: req.user.id,
      title,
      subject: String(req.body.subject ?? '').trim().slice(0, 120) || title,
      lectureId: req.body.lectureId ? String(req.body.lectureId).slice(0, 64) : null,
      difficulty: ['easy', 'medium', 'hard'].includes(req.body.difficulty) ? req.body.difficulty : 'medium',
      questions,
      dueAt: due.value,
      timeLimitMin: limit,
      shuffle: req.body.shuffle !== false,
      starts: {},
      publishedAt: new Date().toISOString(),
    };
    db.data.assignments.push(a);
    db.save();

    // Push to every enrolled student right away; each gets their own answer-free, shuffled view.
    for (const studentId of course.studentIds) {
      hub.send([studentId], 'assignment.published', { assignment: studentView(db, a, studentId) });
    }
    res.status(201).json({ assignment: professorView(db, a) });
  });

  /** POST /v1/assignments/:id/start  (student): starts the clock once; returns their view with the deadline. */
  router.post('/:id/start', requireRole('student'), (req, res) => {
    const a = db.assignment(req.params.id);
    if (!visibleTo(req.user, a)) return res.status(404).json({ error: 'Quiz not found' });
    if (db.submission(a.id, req.user.id)) {
      return res.status(409).json({ error: 'You already submitted this quiz', code: 'already_submitted' });
    }
    if (isClosed(a)) return res.status(403).json({ error: 'This quiz is closed', code: 'closed' });
    if (!a.starts?.[req.user.id]) {
      a.starts = { ...a.starts, [req.user.id]: new Date().toISOString() };
      db.save();
    }
    res.json({ assignment: studentView(db, a, req.user.id) });
  });

  /** POST /v1/assignments/:id/submit { answers (in the student's order): (index|null)[], durationMs }  (student) */
  router.post('/:id/submit', requireRole('student'), (req, res) => {
    const a = db.assignment(req.params.id);
    if (!visibleTo(req.user, a)) return res.status(404).json({ error: 'Quiz not found' });
    if (db.submission(a.id, req.user.id)) {
      return res.status(409).json({ error: 'You already submitted this quiz', code: 'already_submitted' });
    }

    const now = Date.now();
    const startedAt = a.starts?.[req.user.id];
    const deadline = deadlineFor(a, startedAt);
    if (deadline && now > Date.parse(deadline) + GRACE_MS) {
      const timeUp = a.timeLimitMin && (!a.dueAt || Date.parse(deadline) < Date.parse(a.dueAt));
      return res.status(403).json({
        error: timeUp ? 'Time is up for this quiz' : 'This quiz is closed',
        code: timeUp ? 'time_up' : 'closed',
      });
    }

    const layout = layoutFor(a, req.user.id);
    const shown = req.body?.answers;
    const valid =
      Array.isArray(shown) &&
      shown.length === a.questions.length &&
      shown.every(
        (x, i) => x === null || (Number.isInteger(x) && x >= 0 && x < a.questions[layout.order[i]].options.length),
      );
    if (!valid) return res.status(400).json({ error: 'Answers do not match the quiz' });

    const answers = toCanonical(shown, layout);
    // Trust the server's clock when the attempt was started through /start.
    const durationMs = startedAt ? now - Date.parse(startedAt) : Number(req.body.durationMs) || 0;
    const sub = {
      id: newId(),
      assignmentId: a.id,
      studentId: req.user.id,
      answers,
      score: grade(a.questions, answers),
      total: a.questions.length,
      durationMs: Math.min(MAX_DURATION_MS, Math.max(0, Math.round(durationMs))),
      submittedAt: new Date(now).toISOString(),
    };
    db.data.submissions.push(sub);
    db.save();

    hub.send([a.professorId], 'submission.created', {
      assignmentId: a.id,
      title: a.title,
      student: { id: req.user.id, name: req.user.name },
      score: sub.score,
      total: sub.total,
    });
    res.status(201).json({ assignment: studentView(db, a, req.user.id) });
  });

  /** GET /v1/assignments/:id/results  (professor) */
  router.get('/:id/results', requireRole('professor'), (req, res) => {
    const a = db.assignment(req.params.id);
    if (!visibleTo(req.user, a)) return res.status(404).json({ error: 'Quiz not found' });
    const subs = db.submissionsFor(a.id);
    // Current members plus anyone who submitted and later left the class.
    const ids = new Set([...db.course(a.courseId).studentIds, ...subs.map((s) => s.studentId)]);
    const students = [...ids].map((id) => ({ id, name: db.user(id)?.name ?? 'Unknown' }));
    res.json({ assignment: professorView(db, a), results: assignmentResults(a, subs, students) });
  });

  /** DELETE /v1/assignments/:id  (professor) */
  router.delete('/:id', requireRole('professor'), (req, res) => {
    const a = db.assignment(req.params.id);
    if (!visibleTo(req.user, a)) return res.status(404).json({ error: 'Quiz not found' });
    db.data.assignments = db.data.assignments.filter((x) => x.id !== a.id);
    db.data.submissions = db.data.submissions.filter((s) => s.assignmentId !== a.id);
    db.save();
    hub.send(db.course(a.courseId).studentIds, 'assignment.removed', { id: a.id });
    res.json({ ok: true });
  });

  return router;
}
