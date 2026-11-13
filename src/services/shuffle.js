import { createHash } from 'node:crypto';

/**
 * Per-student shuffling: each student gets their own question order and option order,
 * stable across reloads (seeded by quiz id + student id). Answers are stored in the
 * quiz's original ("canonical") order, so grading and analytics never see the shuffle.
 */
export function layoutFor(assignment, studentId) {
  const n = assignment.questions.length;
  if (!assignment.shuffle) {
    return { order: [...Array(n).keys()], options: assignment.questions.map((q) => [...q.options.keys()]) };
  }
  const rand = seeded(`${assignment.id}:${studentId}`);
  return {
    order: permutation(n, rand),
    options: assignment.questions.map((q) => permutation(q.options.length, rand)),
  };
}

/** Questions as this student sees them: their order, their option order, answer index remapped. */
export function questionsFor(assignment, layout, { withAnswers }) {
  return layout.order.map((k) => {
    const q = assignment.questions[k];
    const opts = layout.options[k];
    const shown = { question: q.question, options: opts.map((j) => q.options[j]), topic: q.topic };
    return withAnswers ? { ...shown, answerIndex: opts.indexOf(q.answerIndex), explanation: q.explanation } : shown;
  });
}

/** Student-order answers -> canonical answers. */
export function toCanonical(answers, layout) {
  const out = Array(answers.length).fill(null);
  layout.order.forEach((k, i) => {
    out[k] = answers[i] == null ? null : layout.options[k][answers[i]];
  });
  return out;
}

/** Canonical answers -> this student's order. */
export function toStudentOrder(answers, layout) {
  return layout.order.map((k) => (answers[k] == null ? null : layout.options[k].indexOf(answers[k])));
}

function seeded(key) {
  let a = createHash('sha256').update(key).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function permutation(n, rand) {
  const p = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  return p;
}
