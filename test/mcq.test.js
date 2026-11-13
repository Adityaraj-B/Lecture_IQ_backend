import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkTranscript, distribute, sanitizeQuestions } from '../src/services/mcq.js';
import { buildPrompt, filterSegments } from '../src/services/groqStt.js';

const q = (over = {}) => ({
  question: 'What is a stack?',
  options: ['LIFO structure', 'FIFO structure', 'A tree', 'A graph'],
  answerIndex: 0,
  explanation: 'The lecturer said...',
  topic: 'Stacks',
  ...over,
});

test('keeps valid questions and tracks the correct answer through shuffling', () => {
  for (let i = 0; i < 50; i++) {
    const [out] = sanitizeQuestions({ questions: [q()] });
    assert.equal(out.options[out.answerIndex], 'LIFO structure');
    assert.equal(out.options.length, 4);
  }
});

test('rejects bad shapes', () => {
  const bad = [
    q({ options: ['a', 'b', 'c'] }),
    q({ answerIndex: 4 }),
    q({ answerIndex: 1.5 }),
    q({ options: ['a', 'a', 'b', 'c'] }),
    q({ options: ['a', 'b', 'c', 'All of the above'] }),
    q({ question: '' }),
  ];
  assert.equal(sanitizeQuestions({ questions: bad }).length, 0);
});

test('dedupes questions and strips letter prefixes', () => {
  const out = sanitizeQuestions({
    questions: [q(), q({ question: 'what is a STACK' }), q({ question: 'Q2', options: ['A) x', 'B) y', 'C) z', 'D) w'] })],
  });
  assert.equal(out.length, 2);
  assert.deepEqual([...out[1].options].sort(), ['w', 'x', 'y', 'z']);
});

test('distribute sums to count', () => {
  assert.equal(distribute(10, [9000, 9000, 9000, 3000]).reduce((a, b) => a + b), 10);
  assert.equal(distribute(3, [100, 100, 100, 100, 100]).length, 5);
});

test('chunkTranscript respects max size', () => {
  const chunks = chunkTranscript('Sentence number one is here. '.repeat(1200), 9000);
  assert.ok(chunks.length >= 4);
  assert.ok(chunks.every((c) => c.length <= 9000));
});

test('filterSegments drops silence hallucinations and repeats', () => {
  const out = filterSegments([
    { text: 'Today we cover heaps.', no_speech_prob: 0.01, avg_logprob: -0.2 },
    { text: 'Thanks for watching!', no_speech_prob: 0.1, avg_logprob: -0.3 },
    { text: 'blah', no_speech_prob: 0.9, avg_logprob: -1.5 },
    { text: 'A heap is a tree.', no_speech_prob: 0.01, avg_logprob: -0.2 },
    { text: 'A heap is a tree.', no_speech_prob: 0.01, avg_logprob: -0.2 },
  ]);
  assert.deepEqual(out.map((s) => s.text), ['Today we cover heaps.', 'A heap is a tree.']);
});

test('buildPrompt includes subject and caps tail', () => {
  const p = buildPrompt('Operating Systems', 'word '.repeat(500));
  assert.ok(p.startsWith('Lecture on Operating Systems.'));
  assert.ok(p.length < 700);
});
