import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { hashPassword, signToken, verifyPassword, verifyToken } from '../src/services/auth.js';
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

test('demo sign-in seeds a shared class with history, once', async () => {
  const [s1, s2] = await Promise.all([
    call('POST', '/v1/auth/demo', { body: { role: 'student' } }),
    call('POST', '/v1/auth/demo', { body: { role: 'student' } }),
  ]);
  assert.equal(s1.status, 200);
  assert.equal(s1.body.user.id, s2.body.user.id);
  const prof = await call('POST', '/v1/auth/demo', { body: { role: 'professor' } });
  assert.equal(prof.body.user.role, 'professor');

  const list = await call('GET', '/v1/assignments', { token: s1.body.token });
  const done = list.body.assignments.filter((a) => a.submission);
  const pending = list.body.assignments.filter((a) => !a.submission);
  assert.equal(done.length, 4);
  assert.equal(pending.length, 1);
  assert.ok(pending[0].questions.every((q) => !('answerIndex' in q)));
  assert.ok(done.every((a) => new Date(a.submission.submittedAt) <= new Date()));

  const overview = await call('GET', '/v1/analytics/overview', { token: prof.body.token });
  assert.equal(overview.body.totals.students, 8);
  assert.equal(overview.body.totals.assignments, 5);
  assert.ok(overview.body.totals.completion < 1); // the newest quiz is still open

  // Publishing as the demo professor reaches the demo student live.
  const events = await openEvents(s1.body.token);
  await events.next('ready');
  const course = (await call('GET', '/v1/courses', { token: prof.body.token })).body.courses.find((c) => c.code === 'DEMO42');
  await call('POST', '/v1/assignments', { token: prof.body.token, body: { courseId: course.id, title: 'Live', questions: QUESTIONS } });
  assert.equal((await events.next('assignment.published')).assignment.title, 'Live');
  events.close();

  assert.equal((await call('POST', '/v1/auth/demo', { body: { role: 'admin' } })).status, 400);
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
