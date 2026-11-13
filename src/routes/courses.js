import { randomInt } from 'node:crypto';
import { Router } from 'express';
import { requireRole } from '../middleware/session.js';
import { newId } from '../store/db.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L

export function courseView(db, course, viewer) {
  const base = {
    id: course.id,
    name: course.name,
    code: course.code,
    professorName: db.user(course.professorId)?.name ?? '',
    studentCount: course.studentIds.length,
    createdAt: course.createdAt,
  };
  if (viewer.role !== 'professor') return base;
  return {
    ...base,
    students: course.studentIds.map((id) => ({ id, name: db.user(id)?.name ?? 'Unknown' })),
  };
}

export function coursesRouter({ db, hub }) {
  const router = Router();

  const uniqueCode = () => {
    for (;;) {
      const code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      if (!db.courseByCode(code)) return code;
    }
  };

  router.get('/', (req, res) => {
    const courses = db.coursesOf(req.user).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({ courses: courses.map((c) => courseView(db, c, req.user)) });
  });

  /** POST /v1/courses { name }  (professor) */
  router.post('/', requireRole('professor'), (req, res) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'Give the class a name' });
    const course = {
      id: newId(),
      name,
      code: uniqueCode(),
      professorId: req.user.id,
      studentIds: [],
      createdAt: new Date().toISOString(),
    };
    db.data.courses.push(course);
    db.save();
    res.status(201).json({ course: courseView(db, course, req.user) });
  });

  /** POST /v1/courses/join { code }  (student) */
  router.post('/join', requireRole('student'), (req, res) => {
    const code = String(req.body?.code ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const course = db.courseByCode(code);
    if (!course) return res.status(404).json({ error: 'No class found with that code' });
    if (!course.studentIds.includes(req.user.id)) {
      course.studentIds.push(req.user.id);
      course.joinedAt = { ...course.joinedAt, [req.user.id]: new Date().toISOString() };
      db.save();
      hub.send([course.professorId], 'course.joined', {
        courseId: course.id,
        courseName: course.name,
        student: { id: req.user.id, name: req.user.name },
      });
    }
    res.json({ course: courseView(db, course, req.user) });
  });

  /** DELETE /v1/courses/:id/membership  (student leaves a class) */
  router.delete('/:id/membership', requireRole('student'), (req, res) => {
    const course = db.course(req.params.id);
    if (!course || !course.studentIds.includes(req.user.id)) return res.status(404).json({ error: 'Class not found' });
    course.studentIds = course.studentIds.filter((id) => id !== req.user.id);
    db.save();
    hub.send([course.professorId], 'course.left', { courseId: course.id, studentId: req.user.id });
    res.json({ ok: true });
  });

  /**
   * GET /v1/courses/:id/gradebook.csv  (professor): one row per student, one column per
   * quiz (score %, "missed" after the due date, blank while still open), then totals.
   */
  router.get('/:id/gradebook.csv', requireRole('professor'), (req, res) => {
    const course = db.course(req.params.id);
    if (!course || course.professorId !== req.user.id) return res.status(404).json({ error: 'Class not found' });

    const quizzes = db.assignmentsInCourses([course.id]).sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
    const students = course.studentIds
      .map((id) => db.user(id))
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
    const now = Date.now();

    const rows = [['Student', 'Email', ...quizzes.map((q) => q.title), 'Quizzes taken', 'Average %']];
    for (const s of students) {
      const cells = quizzes.map((q) => {
        const sub = db.submission(q.id, s.id);
        if (sub) return Math.round((sub.score / sub.total) * 100);
        return q.dueAt && Date.parse(q.dueAt) < now ? 'missed' : '';
      });
      const scores = cells.filter((c) => typeof c === 'number');
      const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : '';
      rows.push([s.name, s.email, ...cells, scores.length, avg]);
    }

    const safeName = course.name.replace(/[^\w-]+/g, '_').slice(0, 60) || 'class';
    res.set({
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${safeName}_gradebook.csv"`,
    });
    // BOM so Excel opens UTF-8 names correctly.
    res.send('﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n'));
  });

  return router;
}

/** Quotes a CSV cell when needed, and neutralises spreadsheet formulas (CSV injection). */
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
