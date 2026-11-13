import { Router } from 'express';
import { dailyQuota } from '../middleware/quota.js';
import { requireRole } from '../middleware/session.js';
import { studentReport } from '../services/analytics.js';
import { generateJson, passagesOf, relevantPassages } from '../services/llm.js';
import { GEMINI_SCHEMA, SYSTEM_PROMPT, sanitizeQuestions, userPrompt } from '../services/mcq.js';

const DEFAULT_COUNT = 6;

/**
 * POST /v1/practice { count? }  (student)
 * A private, ungraded quiz on the student's weakest topics. Nothing is stored.
 * Fresh AI questions when the professor has shared notes for those topics; otherwise
 * (or if the AI is unavailable) the student's own past questions on those topics,
 * missed ones first, with options reshuffled.
 */
export function practiceRouter({ db }) {
  const router = Router();

  router.post('/', requireRole('student'), dailyQuota('practice quizzes', 15), async (req, res, next) => {
    try {
      const count = Math.min(10, Math.max(3, Number(req.body?.count) || DEFAULT_COUNT));
      const courses = db.coursesOf(req.user);
      const assignments = db.assignmentsInCourses(courses.map((c) => c.id));
      const report = studentReport({
        studentId: req.user.id,
        courses,
        assignments,
        submissionsOf: (id) => db.submissionsFor(id),
      });
      if (report.stats.completed === 0) {
        return res.status(400).json({ error: 'Take a quiz first, then practice your weak spots here', code: 'no_history' });
      }
      // Weak topics if there are any, else the lowest-scoring ones.
      const topics = (report.weakTopics.length ? report.weakTopics : report.topics.slice(0, 2)).slice(0, 3).map((t) => t.topic);

      const passages = relevantPassages(
        db.notesInCourses(courses.map((c) => c.id)).flatMap((n) => passagesOf(n.sections)),
        topics.join(' '),
        5,
      );
      if (passages.length) {
        try {
          const { json, provider } = await generateJson({
            label: 'practice',
            system: SYSTEM_PROMPT,
            schema: GEMINI_SCHEMA,
            prompt: () =>
              userPrompt({
                transcript: passages.map((p) => p.text).join('\n\n'),
                count,
                difficulty: 'medium',
                subject: `Practice focused on: ${topics.join(', ')}`,
              }),
          });
          const questions = sanitizeQuestions(json).slice(0, count);
          if (questions.length >= 3) return res.json({ topics, source: 'ai', provider, questions });
        } catch (err) {
          console.warn('[practice] AI unavailable, reusing past questions:', err.message);
        }
      }

      const questions = sanitizeQuestions(reviewPool(assignments, db, req.user.id, topics)).slice(0, count);
      if (questions.length === 0) return res.status(404).json({ error: 'Nothing to practice yet for those topics' });
      res.json({ topics, source: 'review', questions });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** The student's past questions on these topics: the ones they missed first. */
function reviewPool(assignments, db, studentId, topics) {
  const wanted = new Set(topics.map((t) => t.toLowerCase()));
  const missed = [];
  const rest = [];
  for (const a of assignments) {
    const sub = db.submission(a.id, studentId);
    if (!sub) continue; // never reveal answers to quizzes they haven't taken
    a.questions.forEach((q, i) => {
      if (!wanted.has(String(q.topic).toLowerCase())) return;
      (sub.answers[i] === q.answerIndex ? rest : missed).push(q);
    });
  }
  return [...missed, ...rest];
}
