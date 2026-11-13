import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { hashPassword, signToken, verifyPassword, verifyToken } from '../src/services/auth.js';
import { purgeLegacySeed } from '../src/services/testAccounts.js';
import { Db } from '../src/store/db.js';

const SECRET = 'test-secret';
let server;
let base;

before(async () => {
  const app = createApp({ db: await Db.open(null), secret: SECRET });
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** Minimal SSE reader: `next(type)` resolves with the data of the next event of that type. */
async function openEvents(token) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/v1/events`, { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal });
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  return {
    async next(type) {
      for (;;) {
        const end = buf.indexOf('\n\n');
        if (end >= 0) {
          const frame = buf.slice(0, end);
          buf = buf.slice(end + 2);
          const ev = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (ev === type) return JSON.parse(data);
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream closed');
        buf += value;
      }
    },
    close: () => ctrl.abort(),
  };
}

const QUESTIONS = [
  { question: 'What is a stack?', options: ['LIFO', 'FIFO', 'Tree', 'Graph'], answerIndex: 0, explanation: 'Said in class.', topic: 'Stacks' },
  { question: 'What is a queue?', options: ['LIFO', 'FIFO', 'Heap', 'Trie'], answerIndex: 1, explanation: 'Said in class.', topic: 'queues' },
];

test('professor publishes, student receives it live, submits, professor sees results', { timeout: 10_000 }, async () => {
  const prof = await call('POST', '/v1/auth/register', {
    body: { role: 'professor', name: 'Dr. Rao', email: 'Rao@Uni.edu', password: 'password1' },
  });
  assert.equal(prof.status, 201);
  assert.equal(prof.body.user.email, 'rao@uni.edu');
  const P = prof.body.token;

  const course = await call('POST', '/v1/courses', { token: P, body: { name: 'Data Structures' } });
  assert.equal(course.status, 201);
  assert.match(course.body.course.code, /^[A-Z2-9]{6}$/);

  const stu = await call('POST', '/v1/auth/register', {
    body: { role: 'student', name: 'Asha', email: 'asha@uni.edu', password: 'password2' },
  });
  const S = stu.body.token;

  const profEvents = await openEvents(P);
  await profEvents.next('ready');
  const messyCode = ` ${course.body.course.code.slice(0, 3).toLowerCase()}-${course.body.course.code.slice(3)} `;
  const joined = await call('POST', '/v1/courses/join', { token: S, body: { code: messyCode } });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.course.professorName, 'Dr. Rao');
  assert.equal((await profEvents.next('course.joined')).student.name, 'Asha');

  // Student is connected before publish: the quiz must arrive over the stream, answer-free.
  const stuEvents = await openEvents(S);
  await stuEvents.next('ready');
  const pub = await call('POST', '/v1/assignments', {
    token: P,
    body: { courseId: course.body.course.id, title: 'Week 1', lectureId: 'lec1', questions: QUESTIONS },
  });
  assert.equal(pub.status, 201);
  const { assignment: live } = await stuEvents.next('assignment.published');
  assert.equal(live.id, pub.body.assignment.id);
  assert.equal(live.courseName, 'Data Structures');
  assert.ok(live.questions.every((q) => !('answerIndex' in q) && !('explanation' in q)));

  const bad = await call('POST', `/v1/assignments/${live.id}/submit`, { token: S, body: { answers: [0] } });
  assert.equal(bad.status, 400);

  const sub = await call('POST', `/v1/assignments/${live.id}/submit`, {
    token: S,
    body: { answers: [0, 0], durationMs: 42_000 },
  });
  assert.equal(sub.status, 201);
  assert.equal(sub.body.assignment.submission.score, 1);
  assert.equal(sub.body.assignment.questions[1].answerIndex, 1); // answers revealed after submitting
  assert.deepEqual(await profEvents.next('submission.created'), {
    assignmentId: live.id,
    title: 'Week 1',
    student: { id: stu.body.user.id, name: 'Asha' },
    score: 1,
    total: 2,
  });

  const again = await call('POST', `/v1/assignments/${live.id}/submit`, { token: S, body: { answers: [0, 1] } });
  assert.equal(again.status, 409);

  const results = await call('GET', `/v1/assignments/${live.id}/results`, { token: P });
  assert.equal(results.body.results.average, 0.5);
  assert.deepEqual(results.body.results.questions.map((q) => q.accuracy), [1, 0]);
  assert.deepEqual(results.body.results.questions[1].optionCounts, [1, 0, 0, 0]);
  assert.deepEqual(results.body.results.distribution, [0, 0, 1, 0, 0]);
  assert.equal(results.body.results.topics[0].topic, 'queues'); // weakest first

  const overview = await call('GET', '/v1/analytics/overview', { token: P });
  assert.equal(overview.body.totals.completion, 1);
  assert.equal(overview.body.totals.average, 0.5);
  assert.equal(overview.body.students[0].name, 'Asha');

  const removed = await call('DELETE', `/v1/assignments/${live.id}`, { token: P });
  assert.equal(removed.status, 200);
  assert.equal((await stuEvents.next('assignment.removed')).id, live.id);

  profEvents.close();
  stuEvents.close();
});

test('rejects bad credentials, missing sessions and wrong roles', async () => {
  await call('POST', '/v1/auth/register', {
    body: { role: 'student', name: 'Ben', email: 'ben@uni.edu', password: 'password3' },
  });
  const wrong = await call('POST', '/v1/auth/login', { body: { email: 'ben@uni.edu', password: 'nope-nope' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, 'credentials');

  const login = await call('POST', '/v1/auth/login', { body: { email: 'BEN@uni.edu', password: 'password3' } });
  assert.equal(login.status, 200);

  const dup = await call('POST', '/v1/auth/register', {
    body: { role: 'student', name: 'Ben', email: 'ben@uni.edu', password: 'password3' },
  });
  assert.equal(dup.status, 409);

  const anon = await call('GET', '/v1/courses');
  assert.equal(anon.status, 401);
  assert.equal(anon.body.code, 'auth');

  const asStudent = await call('POST', '/v1/courses', { token: login.body.token, body: { name: 'X' } });
  assert.equal(asStudent.status, 403);

  const short = await call('POST', '/v1/auth/register', {
    body: { role: 'student', name: 'C', email: 'c@uni.edu', password: 'short' },
  });
  assert.equal(short.status, 400);
});

test('test sign-in gives real, empty accounts that work end to end', { timeout: 10_000 }, async () => {
  const [s1, s2] = await Promise.all([
    call('POST', '/v1/auth/demo', { body: { role: 'student' } }),
    call('POST', '/v1/auth/demo', { body: { role: 'student' } }),
  ]);
  assert.equal(s1.status, 200);
  assert.equal(s1.body.user.id, s2.body.user.id); // concurrent first sign-ins create one account
  assert.equal(s1.body.user.name, 'Test Student');
  const prof = await call('POST', '/v1/auth/demo', { body: { role: 'professor' } });
  assert.equal(prof.body.user.role, 'professor');

  // Nothing pre-made: no classes, quizzes or results.
  assert.deepEqual((await call('GET', '/v1/courses', { token: s1.body.token })).body.courses, []);
  assert.deepEqual((await call('GET', '/v1/assignments', { token: s1.body.token })).body.assignments, []);
  assert.equal((await call('GET', '/v1/analytics/overview', { token: prof.body.token })).body.totals.assignments, 0);

  // The real flow: create a class, join by code, publish, receive live.
  const course = (await call('POST', '/v1/courses', { token: prof.body.token, body: { name: 'Test class' } })).body.course;
  assert.equal((await call('POST', '/v1/courses/join', { token: s1.body.token, body: { code: course.code } })).status, 200);
  const events = await openEvents(s1.body.token);
  await events.next('ready');
  await call('POST', '/v1/assignments', { token: prof.body.token, body: { courseId: course.id, title: 'Live', questions: QUESTIONS } });
  assert.equal((await events.next('assignment.published')).assignment.title, 'Live');
  events.close();

  assert.equal((await call('POST', '/v1/auth/demo', { body: { role: 'admin' } })).status, 400);
  assert.equal((await call('POST', '/v1/auth/demo', { body: { role: '__proto__' } })).status, 400);
});

test('old demo seed data is purged; real data is kept', async () => {
  const db = await Db.open(null);
  const d = db.data;
  d.users.push(
    { id: 'fakeProf', email: 'professor@demo.lectureiq', role: 'professor' },
    { id: 'fakeStu', email: 'student1@demo.lectureiq', role: 'student' },
    { id: 'realProf', email: 'prof@uni.edu', role: 'professor' },
    { id: 'realStu', email: 'stu@uni.edu', role: 'student' },
  );
  d.courses.push(
    { id: 'fakeCourse', professorId: 'fakeProf', studentIds: ['fakeStu', 'realStu'] },
    { id: 'realCourse', professorId: 'realProf', studentIds: ['realStu', 'fakeStu'] },
  );
  d.assignments.push({ id: 'fakeQuiz', courseId: 'fakeCourse', professorId: 'fakeProf' }, { id: 'realQuiz', courseId: 'realCourse', professorId: 'realProf' });
  d.submissions.push(
    { id: 's1', assignmentId: 'fakeQuiz', studentId: 'realStu' },
    { id: 's2', assignmentId: 'realQuiz', studentId: 'fakeStu' },
    { id: 's3', assignmentId: 'realQuiz', studentId: 'realStu' },
  );

  assert.deepEqual(purgeLegacySeed(db), { users: 2, courses: 1, assignments: 1, submissions: 2 });
  assert.deepEqual(d.users.map((u) => u.id), ['realProf', 'realStu']);
  assert.deepEqual(d.courses, [{ id: 'realCourse', professorId: 'realProf', studentIds: ['realStu'] }]);
  assert.deepEqual(d.submissions.map((s) => s.id), ['s3']);
  assert.equal(purgeLegacySeed(db), null); // idempotent
});

test('tokens: forged or expired tokens are rejected', () => {
  const token = signToken('u1', SECRET, 60_000);
  assert.equal(verifyToken(token, SECRET), 'u1');
  assert.equal(verifyToken(token, 'other-secret'), null);
  assert.equal(verifyToken(`${token.split('.')[0]}x.${token.split('.')[1]}`, SECRET), null);
  assert.equal(verifyToken(signToken('u1', SECRET, -1), SECRET), null);
  assert.equal(verifyToken('garbage', SECRET), null);
});

test('passwords: hash round-trips and rejects wrong input', async () => {
  const hash = await hashPassword('correct horse');
  assert.ok(await verifyPassword('correct horse', hash));
  assert.ok(!(await verifyPassword('wrong horse', hash)));
  assert.ok(!(await verifyPassword('x', 'not-a-hash')));
});

test('professor student analytics: list, profile, weak topics, privacy', { timeout: 10_000 }, async () => {
  const reg = async (role, name, email) =>
    (await call('POST', '/v1/auth/register', { body: { role, name, email, password: 'password1' } })).body;
  const profA = await reg('professor', 'Prof A', 'a@prof.edu');
  const profB = await reg('professor', 'Prof B', 'b@prof.edu');
  const ria = await reg('student', 'Ria', 'ria@uni.edu');
  const sam = await reg('student', 'Sam', 'sam@uni.edu');

  const courseA = (await call('POST', '/v1/courses', { token: profA.token, body: { name: 'Algorithms' } })).body.course;
  const courseB = (await call('POST', '/v1/courses', { token: profB.token, body: { name: 'Other class' } })).body.course;
  for (const s of [ria, sam]) await call('POST', '/v1/courses/join', { token: s.token, body: { code: courseA.code } });
  await call('POST', '/v1/courses/join', { token: ria.token, body: { code: courseB.code } });

  let n = 0;
  const q = (topic, answerIndex = 0) => ({ question: `About ${topic} #${++n}?`, options: ['w', 'x', 'y', 'z'], answerIndex, explanation: 'e', topic });
  const publish = async (token, courseId, title, questions) =>
    (await call('POST', '/v1/assignments', { token, body: { courseId, title, questions } })).body.assignment;
  const quiz1 = await publish(profA.token, courseA.id, 'Q1', [q('Sorting'), q('Graphs'), q('Graphs')]);
  const quiz2 = await publish(profA.token, courseA.id, 'Q2', [q('Sorting'), q('Graphs')]);
  await publish(profA.token, courseA.id, 'Q3 (nobody took it)', [q('Hashing')]);
  const other = await publish(profB.token, courseB.id, 'Secret', [q('Private')]);
  const submit = (s, a, answers) => call('POST', `/v1/assignments/${a.id}/submit`, { token: s.token, body: { answers, durationMs: 60_000 } });

  await submit(ria, quiz1, [0, 1, 1]); // Sorting right, Graphs wrong twice
  await submit(ria, quiz2, [0, 1]);
  await submit(sam, quiz1, [0, 0, 0]);
  await submit(ria, other, [0]); // Prof A must never see this

  const list = (await call('GET', '/v1/students', { token: profA.token })).body;
  assert.deepEqual(list.students.map((s) => s.name), ['Ria', 'Sam']);
  const [riaRow, samRow] = list.students;
  assert.equal(samRow.rank, 1);
  assert.equal(riaRow.rank, 2);
  assert.equal(riaRow.assigned, 3);
  assert.equal(riaRow.completed, 2);
  assert.equal(riaRow.missed, 1);
  assert.equal(riaRow.weakTopics[0].topic, 'Graphs');
  assert.equal(riaRow.weakTopics[0].accuracy, 0);
  assert.ok(riaRow.joinedAt === undefined && riaRow.courses[0].joinedAt); // join date recorded per class

  const profile = (await call('GET', `/v1/students/${ria.user.id}`, { token: profA.token })).body;
  assert.equal(profile.student.email, 'ria@uni.edu');
  assert.deepEqual(profile.courses.map((c) => c.name), ['Algorithms']); // not Prof B's class
  assert.ok(profile.history.every((h) => h.title !== 'Secret'));
  assert.ok(profile.topics.every((t) => t.topic !== 'Private'));
  assert.deepEqual(profile.history.map((h) => h.title), ['Q3 (nobody took it)', 'Q2', 'Q1']); // newest first
  const h1 = profile.history.find((h) => h.title === 'Q1');
  assert.equal(h1.score, 1);
  assert.equal(h1.placement, 2); // Sam scored higher on Q1
  assert.equal(h1.classSubmitted, 2);
  assert.equal(profile.history[0].submitted, false);
  assert.equal(profile.stats.average, (1 / 3 + 1 / 2) / 2);
  assert.equal(profile.rank, 2);
  assert.equal(profile.rankedCount, 2);
  assert.equal(profile.mistakes.length, 3);
  assert.deepEqual(profile.mistakes[0], { ...profile.mistakes[0], topic: 'Graphs', chosen: 'x', correct: 'w' });
  assert.equal(profile.strongTopics[0].topic, 'Sorting');

  // Who took a quiz, on the professor's quiz list.
  const listed = (await call('GET', '/v1/assignments', { token: profA.token })).body.assignments.find((a) => a.id === quiz1.id);
  assert.deepEqual(listed.submittedBy.map((s) => s.name).sort(), ['Ria', 'Sam']);

  // Privacy: another professor can't open Sam (not in their classes); students can't use this at all.
  assert.equal((await call('GET', `/v1/students/${sam.user.id}`, { token: profB.token })).status, 404);
  assert.equal((await call('GET', '/v1/students', { token: ria.token })).status, 403);
});
