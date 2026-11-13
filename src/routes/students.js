import { Router } from 'express';
import { requireRole } from '../middleware/session.js';
import { studentReport } from '../services/analytics.js';

/**
 * Professor-only student analytics. A professor sees a student only if the student
 * is in one of their classes, and only results from quizzes in those classes.
 */
export function studentsRouter({ db }) {
  const router = Router();
  router.use(requireRole('professor'));

  const reportFor = (professor, studentId) => {
    const courses = db.coursesOf(professor).filter((c) => c.studentIds.includes(studentId));
    if (courses.length === 0) return null;
    const report = studentReport({
      studentId,
      courses,
      assignments: db.assignmentsInCourses(courses.map((c) => c.id)),
      submissionsOf: (id) => db.submissionsFor(id),
    });
    return { courses, report };
  };

  const identity = (user) => ({ id: user.id, name: user.name, email: user.email, memberSince: user.createdAt });
  const courseRef = (c, studentId) => ({ id: c.id, name: c.name, code: c.code, joinedAt: c.joinedAt?.[studentId] ?? null });

  /** Every student across the professor's classes, ranked by average (1 = best). */
  const summaries = (professor) => {
    const ids = [...new Set(db.coursesOf(professor).flatMap((c) => c.studentIds))];
    const rows = ids
      .map((id) => {
        const user = db.user(id);
        const r = user && reportFor(professor, id);
        if (!r) return null;
        const { stats, weakTopics } = r.report;
        return {
          ...identity(user),
          courses: r.courses.map((c) => courseRef(c, id)),
          ...stats,
          weakTopics,
        };
      })
      .filter(Boolean);

    const ranked = rows.filter((r) => r.average != null).sort((a, b) => b.average - a.average);
    for (const r of rows) r.rank = r.average == null ? null : ranked.indexOf(r) + 1;
    return { rows, rankedCount: ranked.length };
  };

  /** GET /v1/students */
  router.get('/', (req, res) => {
    const { rows, rankedCount } = summaries(req.user);
    res.json({ students: rows.sort((a, b) => a.name.localeCompare(b.name)), rankedCount });
  });

  /** GET /v1/students/:id */
  router.get('/:id', (req, res) => {
    const user = db.user(req.params.id);
    const r = user?.role === 'student' ? reportFor(req.user, user.id) : null;
    if (!r) return res.status(404).json({ error: 'Student not found in your classes' });
    const { rows, rankedCount } = summaries(req.user);
    res.json({
      student: identity(user),
      courses: r.courses.map((c) => courseRef(c, user.id)),
      rank: rows.find((x) => x.id === user.id)?.rank ?? null,
      rankedCount,
      ...r.report,
    });
  });

  return router;
}
