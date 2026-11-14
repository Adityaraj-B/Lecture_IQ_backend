import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { dailyQuota } from '../src/middleware/quota.js';
import { UpstreamError, publicMessage } from '../src/services/errors.js';
import { Db } from '../src/store/db.js';

const ai = {
  buildNotes: async () => ({
    summary: 'About deadlocks.',
    keyPoints: ['Four conditions'],
    topics: ['Deadlocks'],
    flashcards: [
      { front: 'Circular wait?', back: 'A cycle.' },
      { front: 'Mutual exclusion?', back: 'One at a time.' },
    ],
    provider: 'stub',
  }),
  askLecture: async () => ({ answer: 'From the lecture.', moments: [], provider: 'stub' }),
};

let server;
let base;
let db;
before(async () => {
  db = await Db.open(null);
  const app = createApp({ db, secret: 's', ai });
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

let n = 0;
async function account(role) {
  const r = await call('POST', '/v1/auth/register', {
    body: { role, name: `${role} ${++n}`, email: `${role}${n}@essentials.test`, password: 'password1' },
  });
  assert.equal(r.status, 201);
  return r.body.token;
}

test('transcription and quiz generation need a signed-in professor', async () => {
  const S = await account('student');
  const P = await account('professor');
  for (const path of ['/v1/quiz', '/v1/transcribe']) {
    assert.equal((await call('POST', path, { body: {} })).status, 401, `${path} without sign-in`);
    assert.equal((await call('POST', path, { token: S, body: {} })).status, 403, `${path} as a student`);
  }
  // A professor gets past auth to the normal validation.
  const q = await call('POST', '/v1/quiz', { token: P, body: { transcript: 'too short' } });
  assert.equal(q.status, 400);
  assert.match(q.body.error, /too short/i);
});

test('daily quotas are counted per user in the database and survive a restart', () => {
  const store = { data: { usage: [] }, save() {} };
  const run = (mw, userId) => {
    let status = 200;
    let nexted = false;
    const res = { status: (s) => ((status = s), res), json: () => res };
    mw({ user: { id: userId } }, res, () => (nexted = true));
    return nexted ? 200 : status;
  };

  const first = dailyQuota({ db: store, key: 'ask', label: 'questions', limit: 2 });
  assert.equal(run(first, 'a'), 200);
  assert.equal(run(first, 'a'), 200);
  assert.equal(run(first, 'a'), 429);
  assert.equal(run(first, 'b'), 200, 'another user has their own allowance');

  // A new middleware instance (as after a server restart) reads the same counters.
  const restarted = dailyQuota({ db: store, key: 'ask', label: 'questions', limit: 2 });
  assert.equal(run(restarted, 'a'), 429);
  assert.equal(store.data.usage.find((r) => r.userId === 'a').count, 2);

  // Counters from earlier days are cleared and don't count against today.
  const loaded = { data: { usage: [{ id: 'c:ask:2000-01-01', userId: 'c', key: 'ask', day: '2000-01-01', count: 9 }] }, save() {} };
  assert.equal(run(dailyQuota({ db: loaded, key: 'ask', label: 'questions', limit: 2 }), 'c'), 200);
  assert.equal(loaded.data.usage.some((r) => r.day === '2000-01-01'), false);
});

test('lecture backup: owner only, upsert, delete', async () => {
  const P = await account('professor');
  const other = await account('professor');
  const S = await account('student');
  const lecture = { id: 'abc123', subject: 'Deadlocks', createdAt: new Date().toISOString(), segments: [] };

  assert.equal((await call('PUT', '/v1/lectures/abc123', { token: S, body: { lecture } })).status, 403);
  assert.equal((await call('PUT', '/v1/lectures/abc123', { token: P, body: { lecture: { ...lecture, id: 'x' } } })).status, 400);
  assert.equal((await call('PUT', '/v1/lectures/abc123', { token: P, body: { lecture } })).status, 200);
  assert.equal((await call('PUT', '/v1/lectures/abc123', { token: P, body: { lecture: { ...lecture, subject: 'OS' } } })).status, 200);

  const mine = await call('GET', '/v1/lectures', { token: P });
  assert.deepEqual(mine.body.lectures.map((l) => l.subject), ['OS']);
  assert.deepEqual((await call('GET', '/v1/lectures', { token: other })).body.lectures, []);

  assert.equal((await call('DELETE', '/v1/lectures/abc123', { token: other })).status, 200);
  assert.equal((await call('GET', '/v1/lectures', { token: P })).body.lectures.length, 1, "another professor can't delete it");
  assert.equal((await call('DELETE', '/v1/lectures/abc123', { token: P })).status, 200);
  assert.equal((await call('GET', '/v1/lectures', { token: P })).body.lectures.length, 0);
});

test('flashcard progress syncs and keeps the latest review of each card', async () => {
  const P = await account('professor');
  const S = await account('student');
  const outsider = await account('student');
  const course = (await call('POST', '/v1/courses', { token: P, body: { name: 'OS' } })).body.course;
  await call('POST', '/v1/courses/join', { token: S, body: { code: course.code } });
  const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
  const note = (
    await call('POST', '/v1/notes', {
      token: P,
      body: { courseId: course.id, lectureId: 'l1', title: 'Deadlocks', sections: [{ startMs: 0, text: words }] },
    })
  ).body.note;

  const put = (token, cards) => call('PUT', `/v1/flashcards/${note.id}`, { token, body: { cards } });
  assert.equal((await put(outsider, { 0: { box: 1, due: 1, at: 1 } })).status, 404);

  await put(S, { 0: { box: 2, due: 500, at: 200 }, 1: { box: 1, due: 100, at: 100 } });
  // An older review of card 0 from another device doesn't overwrite the newer one; card 1 is newer.
  const merged = await put(S, { 0: { box: 0, due: 50, at: 150 }, 1: { box: 3, due: 900, at: 300 }, junk: { box: 1 } });
  assert.deepEqual(merged.body.cards, { 0: { box: 2, due: 500, at: 200 }, 1: { box: 3, due: 900, at: 300 } });

  const all = await call('GET', '/v1/flashcards', { token: S });
  assert.deepEqual(all.body.progress[note.id], merged.body.cards);
  assert.deepEqual((await call('GET', '/v1/flashcards', { token: outsider })).body.progress, {});
});

test('AI and server failures show a plain message, not provider details', () => {
  const groq = new UpstreamError('groq-stt 400: invalid file', { status: 400, provider: 'groq-stt' });
  assert.equal(publicMessage(groq, 400), "This part of the recording couldn't be transcribed.");
  assert.match(publicMessage(new UpstreamError('gemini 429: quota', { status: 429, provider: 'gemini' }), 429), /busy/);
  assert.match(publicMessage(new UpstreamError('GROQ_API_KEY is not configured', { status: 503 }), 503), /isn't set up/);
  assert.match(publicMessage(new Error('boom'), 500), /Something went wrong/);
  for (const m of [publicMessage(groq, 400), publicMessage(new Error('x'), 502)]) {
    assert.doesNotMatch(m, /groq|gemini|\d{3}/i);
  }
});
