import { randomBytes } from 'node:crypto';
import { newId } from '../store/db.js';
import { hashPassword } from './auth.js';

/**
 * One-tap test accounts: real, empty accounts for trying the app. They start with no
 * classes, quizzes or results; everything they show is created through the app itself.
 */
export const TEST_ACCOUNTS = {
  professor: { name: 'Test Professor', email: 'professor@test.lectureiq' },
  student: { name: 'Test Student', email: 'student@test.lectureiq' },
};

const creating = new WeakMap(); // db -> Map(email -> Promise), so concurrent first sign-ins create one account

export function testAccount(db, role) {
  const { name, email } = TEST_ACCOUNTS[role];
  const existing = db.userByEmail(email);
  if (existing) return Promise.resolve(existing);

  if (!creating.has(db)) creating.set(db, new Map());
  const pending = creating.get(db);
  if (!pending.has(email)) {
    pending.set(
      email,
      (async () => {
        // No usable password: these accounts are only reachable through the test sign-in.
        const user = { id: newId(), role, name, email, passwordHash: await hashPassword(randomBytes(24).toString('hex')), createdAt: new Date().toISOString() };
        db.data.users.push(user);
        db.save();
        return user;
      })().finally(() => pending.delete(email)),
    );
  }
  return pending.get(email);
}

/** Domain of the fake accounts an earlier version seeded (fake professor, students, quizzes, results). */
const LEGACY_SEED = '@demo.lectureiq';

/**
 * Deletes everything the old demo seed created: its users, their classes, quizzes in
 * those classes, and all related submissions. Idempotent; returns counts, or null if
 * there was nothing to remove.
 */
export function purgeLegacySeed(db) {
  const d = db.data;
  const users = new Set(d.users.filter((u) => u.email.endsWith(LEGACY_SEED)).map((u) => u.id));
  if (users.size === 0) return null;

  const courses = new Set(d.courses.filter((c) => users.has(c.professorId)).map((c) => c.id));
  const assignments = new Set(d.assignments.filter((a) => courses.has(a.courseId) || users.has(a.professorId)).map((a) => a.id));
  const before = { users: d.users.length, courses: d.courses.length, assignments: d.assignments.length, submissions: d.submissions.length };

  d.submissions = d.submissions.filter((s) => !assignments.has(s.assignmentId) && !users.has(s.studentId));
  d.assignments = d.assignments.filter((a) => !assignments.has(a.id));
  d.courses = d.courses.filter((c) => !courses.has(c.id));
  for (const c of d.courses) c.studentIds = c.studentIds.filter((id) => !users.has(id));
  d.users = d.users.filter((u) => !users.has(u.id));
  db.save();

  return Object.fromEntries(Object.entries(before).map(([k, n]) => [k, n - d[k].length]));
}
