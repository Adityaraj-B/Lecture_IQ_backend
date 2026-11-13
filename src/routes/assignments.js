import { Router } from 'express';
import { requireRole } from '../middleware/session.js';
import { assignmentResults, grade, summarize } from '../services/analytics.js';
import { sanitizeQuestions } from '../services/mcq.js';
import { newId } from '../store/db.js';

const MAX_QUESTIONS = 50;
const MAX_DURATION_MS = 6 * 60 * 60 * 1000;

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
  };
}

/** Students never see answers or explanations until they've submitted. */
export function studentView(db, a, studentId) {
  const sub = db.submission(a.id, studentId);
  if (!sub) {
    return { ...baseView(db, a), questions: a.questions.map(({ question, options, topic }) => ({ question, options, topic })) };
  }
  const { submitted, average } = summarize(db.submissionsFor(a.id), 0);
  return {
    ...baseView(db, a),
    questions: a.questions,
    submission: { answers: sub.answers, score: sub.score, total: sub.total, durationMs: sub.durationMs, submittedAt: sub.submittedAt },
    classStats: { submitted, average },
  };
}

function professorView(db, a) {
  const enrolled = db.course(a.courseId)?.studentIds.length ?? 0;
  const subs = db.submissionsFor(a.id);
  return {
    ...baseView(db, a),
    lectureId: a.lectureId,
    questions: a.questions,
    stats: summarize(subs, enrolled),
    // Who has taken it, most recent first.
    submittedBy: [...subs]
      .sort((x, y) => y.submittedAt.localeCompare(x.submittedAt))
      .map((x) => ({ id: x.studentId, name: db.user(x.studentId)?.name ?? 'Unknown' })),
  };
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

  /** POST /v1/assignments { courseId, title, subject?, lectureId?, difficulty?, questions }  (professor) */
  router.post('/', requireRole('professor'), (req, res) => {
    const course = db.course(req.body?.courseId);
    if (!course || course.professorId !== req.user.id) return res.status(404).json({ error: 'Class not found' });

    const raw = Array.isArray(req.body?.questions) ? req.body.questions.slice(0, MAX_QUESTIONS + 1) : [];
    if (raw.length === 0 || raw.length > MAX_QUESTIONS) {
      return res.status(400).json({ error: `A quiz needs 1-${MAX_QUESTIONS} questions` });
    }
    const questions = sanitizeQuestions(raw, { shuffle: false });
    if (questions.length !== raw.length) return res.status(400).json({ error: 'Some questions are malformed' });

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
      publishedAt: new Date().toISOString(),
    };
    db.data.assignments.push(a);
    db.save();

    // Push to every enrolled student right away; each gets their own answer-free view.
    for (const studentId of course.studentIds) {
      hub.send([studentId], 'assignment.published', { assignment: studentView(db, a, studentId) });
    }
    res.status(201).json({ assignment: professorView(db, a) });
  });

  /** POST /v1/assignments/:id/submit { answers: (0-3|null)[], durationMs }  (student) */
  router.post('/:id/submit', requireRole('student'), (req, res) => {
    const a = db.assignment(req.params.id);
    if (!visibleTo(req.user, a)) return res.status(404).json({ error: 'Quiz not found' });
    if (db.submission(a.id, req.user.id)) {
      return res.status(409).json({ error: 'You already submitted this quiz', code: 'already_submitted' });
    }

    const answers = req.body?.answers;
    const valid =
      Array.isArray(answers) &&
      answers.length === a.questions.length &&
      answers.every((x, i) => x === null || (Number.isInteger(x) && x >= 0 && x < a.questions[i].options.length));
    if (!valid) return res.status(400).json({ error: 'Answers do not match the quiz' });

    const sub = {
      id: newId(),
      assignmentId: a.id,
      studentId: req.user.id,
      answers,
      score: grade(a.questions, answers),
      total: a.questions.length,
      durationMs: Math.min(MAX_DURATION_MS, Math.max(0, Math.round(Number(req.body.durationMs) || 0))),
      submittedAt: new Date().toISOString(),
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
