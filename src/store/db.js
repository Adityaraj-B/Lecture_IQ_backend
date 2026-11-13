import { randomBytes } from 'node:crypto';

export const COLLECTIONS = ['users', 'courses', 'assignments', 'submissions'];
const empty = () => Object.fromEntries(COLLECTIONS.map((c) => [c, []]));

export const newId = () => randomBytes(9).toString('base64url');

/**
 * The app's working set, held in memory so every read is instant. Changes are
 * written through a pluggable store (MongoDB in production, a JSON file locally,
 * nothing in tests); bursts of changes collapse into one write.
 *
 * One server instance owns the data: fine for Render's single free instance.
 */
export class Db {
  constructor(store) {
    this.store = store;
    this.data = empty();
    this._dirty = false;
    this._saving = null;
  }

  /** @param store {load(): Promise<object>, write(data): Promise<void>, close?(): Promise<void>} | null */
  static async open(store) {
    const db = new Db(store);
    if (store) db.data = { ...empty(), ...(await store.load()) };
    return db;
  }

  /** Schedules a write; bursts of changes collapse into one. */
  save() {
    if (!this.store) return Promise.resolve();
    this._dirty = true;
    this._saving ??= this._flushLoop();
    return this._saving;
  }

  flush() {
    return this._saving ?? Promise.resolve();
  }

  async close() {
    await this.flush();
    await this.store?.close?.();
  }

  async _flushLoop() {
    try {
      await new Promise((r) => setTimeout(r, 50));
      while (this._dirty) {
        this._dirty = false;
        await this.store.write(this.data);
      }
    } catch (err) {
      // Keep the change pending and try again shortly (e.g. a brief network blip to Atlas).
      console.error('[db] write failed, retrying:', err.message);
      this._dirty = true;
      setTimeout(() => this.save(), 2000).unref();
    } finally {
      this._saving = null;
    }
  }

  // ---- queries (linear scans are fine at class scale) ----

  user(id) {
    return id ? this.data.users.find((u) => u.id === id) : undefined;
  }

  userByEmail(email) {
    return this.data.users.find((u) => u.email === email);
  }

  course(id) {
    return this.data.courses.find((c) => c.id === id);
  }

  courseByCode(code) {
    return this.data.courses.find((c) => c.code === code);
  }

  coursesOf(user) {
    return user.role === 'professor'
      ? this.data.courses.filter((c) => c.professorId === user.id)
      : this.data.courses.filter((c) => c.studentIds.includes(user.id));
  }

  assignment(id) {
    return this.data.assignments.find((a) => a.id === id);
  }

  assignmentsInCourses(courseIds) {
    const ids = new Set(courseIds);
    return this.data.assignments.filter((a) => ids.has(a.courseId));
  }

  submissionsFor(assignmentId) {
    return this.data.submissions.filter((s) => s.assignmentId === assignmentId);
  }

  submission(assignmentId, studentId) {
    return this.data.submissions.find((s) => s.assignmentId === assignmentId && s.studentId === studentId);
  }
}
