import { Router } from 'express';
import { config } from '../config.js';
import { dailyQuota } from '../middleware/quota.js';
import { requireRole } from '../middleware/session.js';
import * as notesAi from '../services/notes.js';
import { newId } from '../store/db.js';

const LANGUAGES = ['en', 'hi', 'hinglish'];
const MAX_SECTIONS = 60; // 5 hours of 5-minute chunks

/** List view: everything but the transcript, which can be tens of KB. */
function summaryView(db, n) {
  return {
    id: n.id,
    courseId: n.courseId,
    courseName: db.course(n.courseId)?.name ?? '',
    professorName: db.user(n.professorId)?.name ?? '',
    lectureId: n.lectureId,
    title: n.title,
    subject: n.subject,
    language: n.language,
    recordedAt: n.recordedAt,
    durationMs: n.durationMs,
    summary: n.summary,
    keyPoints: n.keyPoints,
    topics: n.topics,
    flashcardCount: n.flashcards.length,
    publishedAt: n.publishedAt,
  };
}

/** Full view. The transcript is only included for English lectures: the app shows English only. */
function detailView(db, n) {
  return {
    ...summaryView(db, n),
    flashcards: n.flashcards,
    sections: n.language === 'en' ? n.sections : null,
  };
}

/** ai: the notes/ask generators; injectable so tests run without calling a real model. */
export function notesRouter({ db, hub, ai = notesAi }) {
  const router = Router();

  const visibleTo = (user, n) => {
    const course = n && db.course(n.courseId);
    if (!course) return false;
    return user.role === 'professor' ? course.professorId === user.id : course.studentIds.includes(user.id);
  };

  router.get('/', (req, res) => {
    const courseIds = db.coursesOf(req.user).map((c) => c.id);
    const list = db.notesInCourses(courseIds).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    res.json({ notes: list.map((n) => summaryView(db, n)) });
  });

  router.get('/:id', (req, res) => {
    const n = db.note(req.params.id);
    if (!visibleTo(req.user, n)) return res.status(404).json({ error: 'Notes not found' });
    res.json({ note: detailView(db, n) });
  });

  /**
   * POST /v1/notes  (professor): shares a lecture with a class. One AI call writes the
   * summary, key points and flashcards; sharing the same lecture again replaces them.
   * { courseId, lectureId, title, subject?, language, recordedAt?, durationMs?, sections: [{ startMs, text }] }
   */
  router.post('/', requireRole('professor'), dailyQuota('sharing lecture notes', 40), async (req, res, next) => {
    try {
      const course = db.course(req.body?.courseId);
      if (!course || course.professorId !== req.user.id) return res.status(404).json({ error: 'Class not found' });

      const sections = (Array.isArray(req.body.sections) ? req.body.sections : [])
        .slice(0, MAX_SECTIONS)
        .map((s) => ({ startMs: Math.max(0, Math.round(Number(s?.startMs) || 0)), text: String(s?.text ?? '').trim() }))
        .filter((s) => s.text);
      const transcript = sections.map((s) => s.text).join('\n\n');
      if (transcript.split(/\s+/).length < 60) return res.status(400).json({ error: 'The lecture is too short to make notes from' });
      if (transcript.length > config.limits.maxTranscriptChars) return res.status(413).json({ error: 'Lecture too long' });

      const lectureId = String(req.body.lectureId ?? '').slice(0, 64) || null;
      const subject = String(req.body.subject ?? '').trim().slice(0, 120);
      const generated = await ai.buildNotes({ transcript, subject });

      const existing = lectureId && db.data.notes.find((n) => n.courseId === course.id && n.lectureId === lectureId);
      const n = {
        id: existing?.id ?? newId(),
        courseId: course.id,
        professorId: req.user.id,
        lectureId,
        title: String(req.body.title ?? '').trim().slice(0, 120) || subject || 'Lecture notes',
        subject,
        language: LANGUAGES.includes(req.body.language) ? req.body.language : 'en',
        recordedAt: req.body.recordedAt ? new Date(req.body.recordedAt).toISOString() : null,
        durationMs: Math.max(0, Math.round(Number(req.body.durationMs) || 0)),
        sections,
        summary: generated.summary,
        keyPoints: generated.keyPoints,
        topics: generated.topics,
        flashcards: generated.flashcards,
        publishedAt: new Date().toISOString(),
      };
      db.data.notes = [...db.data.notes.filter((x) => x.id !== n.id), n];
      db.save();

      hub.send(course.studentIds, 'notes.published', { note: summaryView(db, n) });
      res.status(existing ? 200 : 201).json({ note: detailView(db, n), provider: generated.provider });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', requireRole('professor'), (req, res) => {
    const n = db.note(req.params.id);
    if (!visibleTo(req.user, n)) return res.status(404).json({ error: 'Notes not found' });
    db.data.notes = db.data.notes.filter((x) => x.id !== n.id);
    db.save();
    hub.send(db.course(n.courseId).studentIds, 'notes.removed', { id: n.id });
    res.json({ ok: true });
  });

  /** POST /v1/notes/:id/ask { question }: answered from this lecture only. */
  router.post('/:id/ask', dailyQuota('questions to lectures', 30), async (req, res, next) => {
    try {
      const n = db.note(req.params.id);
      if (!visibleTo(req.user, n)) return res.status(404).json({ error: 'Notes not found' });
      const question = String(req.body?.question ?? '').trim().slice(0, 500);
      if (question.length < 3) return res.status(400).json({ error: 'Type a question' });
      res.json(await ai.askLecture({ sections: n.sections, question, subject: n.subject }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
