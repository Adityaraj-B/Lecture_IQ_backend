/** Pure scoring and analytics over plain records. Ratios are 0..1; null means "no data". */

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export const ratioOf = (s) => (s.total ? s.score / s.total : 0);

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function grade(questions, answers) {
  return questions.reduce((n, q, i) => n + (answers[i] === q.answerIndex ? 1 : 0), 0);
}

export function summarize(submissions, enrolled) {
  return { enrolled, submitted: submissions.length, average: mean(submissions.map(ratioOf)) };
}

/** Topics come from the LLM as free text, so group them case-insensitively. Weakest first. */
function topicTally() {
  const map = new Map();
  return {
    add(topic, correct) {
      const label = String(topic || '').trim() || 'General';
      const key = label.toLowerCase();
      let t = map.get(key);
      if (!t) map.set(key, (t = { topic: label, correct: 0, total: 0 }));
      t.total++;
      if (correct) t.correct++;
    },
    list() {
      return [...map.values()]
        .map((t) => ({ ...t, accuracy: t.correct / t.total }))
        .sort((a, b) => a.accuracy - b.accuracy || b.total - a.total);
    },
  };
}

/** Five buckets: 0-19%, 20-39%, ... 80-100%. */
function distribution(ratios) {
  const bins = [0, 0, 0, 0, 0];
  for (const r of ratios) bins[Math.min(4, Math.floor(r * 5))]++;
  return bins;
}

/** Everything the professor's per-quiz results screen shows. */
export function assignmentResults(assignment, submissions, students) {
  const tally = topicTally();
  const questions = assignment.questions.map((q, i) => {
    const optionCounts = q.options.map(() => 0);
    let correct = 0;
    let skipped = 0;
    for (const s of submissions) {
      const a = s.answers[i];
      if (a == null) skipped++;
      else optionCounts[a]++;
      if (a === q.answerIndex) correct++;
      tally.add(q.topic, a === q.answerIndex);
    }
    return {
      index: i,
      question: q.question,
      topic: q.topic,
      options: q.options,
      answerIndex: q.answerIndex,
      optionCounts,
      skipped,
      accuracy: submissions.length ? correct / submissions.length : null,
    };
  });

  const byStudent = new Map(submissions.map((s) => [s.studentId, s]));
  const roster = students
    .map(({ id, name }) => {
      const s = byStudent.get(id);
      return s
        ? { id, name, submitted: true, score: s.score, total: s.total, ratio: ratioOf(s), durationMs: s.durationMs, submittedAt: s.submittedAt }
        : { id, name, submitted: false };
    })
    .sort((a, b) => b.submitted - a.submitted || (b.ratio ?? 0) - (a.ratio ?? 0) || a.name.localeCompare(b.name));

  const ratios = submissions.map(ratioOf);
  return {
    enrolled: students.length,
    submitted: submissions.length,
    average: mean(ratios),
    median: median(ratios),
    distribution: distribution(ratios),
    questions,
    topics: tally.list(),
    students: roster,
  };
}

/** Cross-quiz overview for a professor: totals, trend, weak topics, students at risk. */
export function professorOverview({ courses, assignments, submissionsOf, nameOf }) {
  const courseById = new Map(courses.map((c) => [c.id, c]));
  const perStudent = new Map();
  for (const c of courses) for (const id of c.studentIds) perStudent.set(id, { ratios: [], assigned: 0 });

  const tally = topicTally();
  const all = [];
  const trend = [];
  let slots = 0;
  let filled = 0;

  for (const a of [...assignments].sort((x, y) => x.publishedAt.localeCompare(y.publishedAt))) {
    const members = new Set(courseById.get(a.courseId)?.studentIds ?? []);
    const subs = submissionsOf(a.id);
    for (const id of members) perStudent.get(id).assigned++;
    slots += members.size;
    for (const s of subs) {
      const r = ratioOf(s);
      all.push(r);
      if (members.has(s.studentId)) filled++;
      perStudent.get(s.studentId)?.ratios.push(r);
      a.questions.forEach((q, i) => tally.add(q.topic, s.answers[i] === q.answerIndex));
    }
    trend.push({
      id: a.id,
      title: a.title,
      courseName: courseById.get(a.courseId)?.name ?? '',
      publishedAt: a.publishedAt,
      average: mean(subs.map(ratioOf)),
      submitted: subs.length,
      enrolled: members.size,
    });
  }

  // Most at risk first: work assigned but nothing submitted, then lowest average. Nothing assigned goes last.
  const risk = (s) => (s.assigned === 0 ? 2 : (s.average ?? -1));
  const students = [...perStudent]
    .map(([id, p]) => ({ id, name: nameOf(id), average: mean(p.ratios), completed: p.ratios.length, assigned: p.assigned }))
    .sort((a, b) => risk(a) - risk(b) || b.assigned - a.assigned || a.name.localeCompare(b.name));

  return {
    totals: {
      courses: courses.length,
      students: perStudent.size,
      assignments: assignments.length,
      submissions: all.length,
      average: mean(all),
      completion: slots ? filled / slots : null,
    },
    trend: trend.slice(-12),
    topics: tally.list().slice(0, 8),
    students,
  };
}

const WEAK_BELOW = 0.6;
const STRONG_FROM = 0.8;

/**
 * Everything a professor sees about one student, limited to quizzes published in
 * `courses` (the professor's classes this student is in). Newest quiz first.
 */
export function studentReport({ studentId, courses, assignments, submissionsOf }) {
  const courseName = new Map(courses.map((c) => [c.id, c.name]));
  const tally = topicTally();
  const mistakes = [];
  const ratios = [];
  const durations = [];
  let lastActiveAt = null;

  const history = [...assignments]
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .map((a) => {
      const subs = submissionsOf(a.id);
      const mine = subs.find((s) => s.studentId === studentId);
      const others = subs.filter((s) => s.studentId !== studentId);
      const entry = {
        assignmentId: a.id,
        title: a.title,
        courseId: a.courseId,
        courseName: courseName.get(a.courseId) ?? '',
        publishedAt: a.publishedAt,
        questionCount: a.questions.length,
        classAverage: mean(subs.map(ratioOf)),
        classSubmitted: subs.length,
        submitted: Boolean(mine),
      };
      if (!mine) return entry;

      const ratio = ratioOf(mine);
      ratios.push(ratio);
      durations.push(mine.durationMs);
      if (!lastActiveAt || mine.submittedAt > lastActiveAt) lastActiveAt = mine.submittedAt;
      a.questions.forEach((q, i) => {
        const chosen = mine.answers[i];
        tally.add(q.topic, chosen === q.answerIndex);
        if (chosen !== q.answerIndex) {
          mistakes.push({
            assignmentId: a.id,
            title: a.title,
            submittedAt: mine.submittedAt,
            question: q.question,
            topic: q.topic,
            chosen: chosen == null ? null : q.options[chosen],
            correct: q.options[q.answerIndex],
          });
        }
      });
      return {
        ...entry,
        score: mine.score,
        total: mine.total,
        ratio,
        durationMs: mine.durationMs,
        submittedAt: mine.submittedAt,
        // Where this score sits among everyone who took the quiz (1 = best).
        placement: 1 + others.filter((s) => ratioOf(s) > ratio).length,
      };
    });

  const topics = tally.list();
  const taken = history.filter((h) => h.submitted).reverse(); // oldest first, for trends
  const recent = taken.slice(-3).map((h) => h.ratio);
  const earlier = taken.slice(0, -3).map((h) => h.ratio);

  return {
    stats: {
      assigned: history.length,
      completed: ratios.length,
      missed: history.length - ratios.length,
      completion: history.length ? ratios.length / history.length : null,
      average: mean(ratios),
      // Class average on the same quizzes this student took: a fair comparison.
      classAverage: mean(taken.map((h) => h.classAverage).filter((v) => v != null)),
      best: ratios.length ? Math.max(...ratios) : null,
      worst: ratios.length ? Math.min(...ratios) : null,
      averageDurationMs: durations.length ? Math.round(mean(durations)) : null,
      recentChange: earlier.length && recent.length ? mean(recent) - mean(earlier) : null,
      lastActiveAt,
    },
    history,
    topics,
    weakTopics: topics.filter((t) => t.accuracy < WEAK_BELOW).slice(0, 4),
    strongTopics: topics.filter((t) => t.accuracy >= STRONG_FROM).reverse().slice(0, 4),
    mistakes: mistakes.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)).slice(0, 8),
  };
}
