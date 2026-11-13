import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { condense, passagesOf, relevantPassages } from '../src/services/llm.js';
import { Db } from '../src/store/db.js';

const calls = { notes: 0, ask: [] };
/** Stand-in for the AI so these tests are fast, offline and deterministic. */
const ai = {
  buildNotes: async ({ subject }) => {
    calls.notes++;
    return {
      summary: `About ${subject}.`,
      keyPoints: ['Deadlock needs four conditions'],
      topics: ['Deadlocks'],
      flashcards: [{ front: 'What is circular wait?', back: 'A cycle of waiting processes.' }],
      provider: 'stub',
    };
  },
  askLecture: async ({ sections, question }) => {
    calls.ask.push({ sections, question });
    return { answer: 'From the lecture.', moments: [300000], provider: 'stub' };
  },
};

let server;
let base;
before(async () => {
  const app = createApp({ db: await Db.open(null), secret: 's', ai });
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
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

const reg = async (role, name, email) =>
  (await call('POST', '/v1/auth/register', { body: { role, name, email, password: 'password1' } })).body;

const words = (n, topic) => Array.from({ length: n }, (_, i) => `${topic} point ${i}.`).join(' ');

test('lecture notes: shared once, readable by the class, English-only transcript, ask, live event', async () => {
  const prof = await reg('professor', 'Prof N', 'n@prof.edu');
  const stu = await reg('student', 'Stu', 'stu@uni.edu');
  const outsider = await reg('student', 'Out', 'out@uni.edu');
  const course = (await call('POST', '/v1/courses', { token: prof.token, body: { name: 'OS' } })).body.course;
  await call('POST', '/v1/courses/join', { token: stu.token, body: { code: course.code } });

  const share = (lectureId, language, extra = {}) =>
    call('POST', '/v1/notes', {
      token: prof.token,
      body: {
        courseId: course.id,
        lectureId,
        title: 'Deadlocks',
        subject: 'OS',
        language,
        sections: [
          { startMs: 0, text: words(40, 'deadlock') },
          { startMs: 300000, text: words(40, 'paging') },
        ],
        ...extra,
      },
    });

  assert.equal((await share('l1', 'en', { sections: [{ startMs: 0, text: 'too short' }] })).status, 400);
  const first = await share('l1', 'en');
  assert.equal(first.status, 201);
  assert.equal(first.body.note.summary, 'About OS.');
  const again = await share('l1', 'en'); // re-sharing replaces, doesn't duplicate
  assert.equal(again.status, 200);
  assert.equal(again.body.note.id, first.body.note.id);

  const list = (await call('GET', '/v1/notes', { token: stu.token })).body.notes;
  assert.equal(list.length, 1);
  assert.ok(!('sections' in list[0])); // lists stay small
  const detail = (await call('GET', `/v1/notes/${list[0].id}`, { token: stu.token })).body.note;
  assert.equal(detail.sections.length, 2);
  assert.equal(detail.flashcards[0].front, 'What is circular wait?');

  // Hindi lecture: notes are English, but the raw transcript is never sent to the app.
  const hindi = (await share('l2', 'hi')).body.note;
  assert.equal(hindi.sections, null);
  assert.equal((await call('GET', `/v1/notes/${hindi.id}`, { token: stu.token })).body.note.sections, null);

  const asked = await call('POST', `/v1/notes/${hindi.id}/ask`, { token: stu.token, body: { question: 'What is a deadlock?' } });
  assert.equal(asked.body.answer, 'From the lecture.');
  assert.equal(calls.ask.at(-1).sections.length, 2); // answered from the stored transcript, server-side

  assert.equal((await call('GET', `/v1/notes/${hindi.id}`, { token: outsider.token })).status, 404);
  assert.equal((await call('POST', '/v1/notes', { token: stu.token, body: {} })).status, 403);
});

test('practice: needs history, reuses missed questions on weak topics, never leaks untaken quizzes', async () => {
  const prof = await reg('professor', 'Prof P', 'p@prof.edu');
  const stu = await reg('student', 'Pia', 'pia@uni.edu');
  const course = (await call('POST', '/v1/courses', { token: prof.token, body: { name: 'Algo' } })).body.course;
  await call('POST', '/v1/courses/join', { token: stu.token, body: { code: course.code } });

  assert.equal((await call('POST', '/v1/practice', { token: stu.token, body: {} })).body.code, 'no_history');

  const q = (topic, n) => ({ question: `${topic} q${n}?`, options: ['right', 'b', 'c', 'd'], answerIndex: 0, explanation: 'e', topic });
  const publish = async (title, questions) =>
    (await call('POST', '/v1/assignments', { token: prof.token, body: { courseId: course.id, title, questions, shuffle: false } })).body.assignment;
  const taken = await publish('Taken', [q('Graphs', 1), q('Graphs', 2), q('Graphs', 3), q('Sorting', 1)]);
  await publish('Untaken', [q('Graphs', 9)]);
  await call('POST', `/v1/assignments/${taken.id}/submit`, { token: stu.token, body: { answers: [1, 1, 0, 0] } });

  const p = (await call('POST', '/v1/practice', { token: stu.token, body: { count: 5 } })).body;
  assert.equal(p.source, 'review'); // no shared notes, so no AI call
  assert.deepEqual(p.topics, ['Graphs']);
  assert.deepEqual(p.questions.map((x) => x.question), ['Graphs q1?', 'Graphs q2?', 'Graphs q3?']); // missed first
  assert.ok(p.questions.every((x) => x.options[x.answerIndex] === 'right'));
  assert.ok(!p.questions.some((x) => x.question === 'Graphs q9?')); // untaken quiz stays secret
});

test('gradebook CSV: scores, open vs missed, formula-safe', async () => {
  const prof = await reg('professor', 'Prof G', 'g@prof.edu');
  const stu = await reg('student', '=HYPERLINK("x")', 'evil@uni.edu');
  const stu2 = await reg('student', 'Gita', 'gita@uni.edu');
  const course = (await call('POST', '/v1/courses', { token: prof.token, body: { name: 'Grades' } })).body.course;
  for (const s of [stu, stu2]) await call('POST', '/v1/courses/join', { token: s.token, body: { code: course.code } });
  const quiz = (
    await call('POST', '/v1/assignments', {
      token: prof.token,
      body: { courseId: course.id, title: 'Quiz, one', shuffle: false, questions: [{ question: 'Q?', options: ['a', 'b', 'c', 'd'], answerIndex: 0, explanation: '', topic: 'T' }] },
    })
  ).body.assignment;
  await call('POST', `/v1/assignments/${quiz.id}/submit`, { token: stu2.token, body: { answers: [0] } });

  const csv = await call('GET', `/v1/courses/${course.id}/gradebook.csv`, { token: prof.token });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const lines = csv.text.replace(/^﻿/, '').split('\r\n');
  assert.equal(lines[0], 'Student,Email,"Quiz, one",Quizzes taken,Average %');
  assert.ok(lines.includes('Gita,gita@uni.edu,100,1,100'));
  assert.ok(lines.includes(`"'=HYPERLINK(""x"")",evil@uni.edu,,0,`)); // formula neutralised; no due date, so blank not "missed"
  assert.equal((await call('GET', `/v1/courses/${course.id}/gradebook.csv`, { token: stu.token })).status, 403);
});

test('retrieval helpers keep prompts small and on-topic', () => {
  const passages = passagesOf([
    { startMs: 0, text: 'Paging splits memory into frames. The TLB caches page table entries.' },
    { startMs: 300000, text: 'Deadlock needs circular wait. The banker algorithm avoids deadlock.' },
  ]);
  assert.equal(passages.length, 2);
  const [best] = relevantPassages(passages, 'How does the banker algorithm avoid deadlock?', 1);
  assert.equal(best.startMs, 300000);

  const long = 'x'.repeat(50_000);
  assert.ok(condense(long, 16_000).length <= 16_000 + 8 * 6);
  assert.equal(condense('short', 100), 'short');
});
