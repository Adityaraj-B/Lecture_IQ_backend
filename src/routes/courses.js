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

  return router;
}
