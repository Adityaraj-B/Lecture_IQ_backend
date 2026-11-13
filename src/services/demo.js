import { randomBytes } from 'node:crypto';
import { newId } from '../store/db.js';
import { grade } from './analytics.js';
import { hashPassword } from './auth.js';

/**
 * Demo mode: one-tap sign-in as a seeded professor or student who share a class
 * with a few weeks of realistic history, so every screen has something to show.
 * Publishing as the demo professor reaches the demo student live.
 */
export const DEMO_EMAILS = { professor: 'professor@demo.lectureiq', student: 'student@demo.lectureiq' };
const CODE = 'DEMO42';

const q = (topic, question, options, answerIndex, explanation) => ({ question, options, answerIndex, explanation, topic });

const QUIZZES = [
  {
    title: 'Processes & threads',
    daysAgo: 21,
    questions: [
      q('Processes', 'What does a process control block (PCB) store?', ['The state and context of a process', 'The compiled program code', 'Only the process ID', 'The disk blocks of the program'], 0, 'The lecturer described the PCB as the kernel\'s record of a process: state, registers, PC and scheduling info.'),
      q('Threads', 'What do threads of the same process share?', ['Address space and open files', 'Their stacks', 'Their program counters', 'Their register sets'], 0, 'Threads share the address space and resources; each keeps its own stack, registers and PC.'),
      q('Processes', 'Which transition happens when a running process waits for I/O?', ['Running → Waiting', 'Running → Ready', 'Waiting → Running', 'Ready → Terminated'], 0, 'Blocking on I/O moves a process from Running to Waiting until the I/O completes.'),
      q('Threads', 'Why are threads cheaper to create than processes?', ['They don\'t need a new address space', 'They run in kernel mode', 'They skip scheduling', 'They never block'], 0, 'Creating a thread avoids allocating and copying a whole new address space.'),
      q('Context switching', 'What makes a context switch pure overhead?', ['No useful work is done while saving and restoring state', 'It always flushes the disk cache', 'It requires a reboot of the scheduler', 'It runs user code twice'], 0, 'The CPU spends the switch saving and loading state rather than running processes.'),
    ],
  },
  {
    title: 'CPU scheduling',
    daysAgo: 14,
    questions: [
      q('Scheduling', 'Which algorithm can starve long jobs?', ['Shortest Job First', 'Round Robin', 'First Come First Served', 'Multilevel feedback with aging'], 0, 'SJF keeps picking short jobs, so a long job may wait indefinitely.'),
      q('Scheduling', 'What happens if the Round Robin quantum is very large?', ['It behaves like FCFS', 'It behaves like SJF', 'Throughput drops to zero', 'It becomes non-preemptive priority'], 0, 'With a huge quantum, every process finishes its burst before preemption, which is FCFS.'),
      q('Context switching', 'A very small RR quantum mainly increases…', ['Context-switch overhead', 'Starvation', 'Turnaround of short jobs only', 'Memory fragmentation'], 0, 'Tiny quanta mean constant switching, so overhead dominates.'),
      q('Scheduling', 'Aging is used to prevent…', ['Starvation', 'Deadlock', 'Thrashing', 'Race conditions'], 0, 'Aging slowly raises the priority of waiting processes so they eventually run.'),
      q('Scheduling', 'Turnaround time is…', ['Completion time minus arrival time', 'Burst time minus waiting time', 'Time until first response', 'Waiting time plus quantum'], 0, 'Turnaround measures the whole stay in the system: completion minus arrival.'),
    ],
  },
  {
    title: 'Synchronization',
    daysAgo: 10,
    questions: [
      q('Synchronization', 'What is a race condition?', ['Outcome depends on the timing of concurrent access', 'Two processes have equal priority', 'A process runs faster than the scheduler', 'Threads finish in order'], 0, 'When the result depends on interleaving of shared-data access, it is a race condition.'),
      q('Synchronization', 'A binary semaphore is closest to…', ['A mutex lock', 'A condition variable', 'A monitor', 'A spinlock-free queue'], 0, 'A semaphore restricted to 0/1 behaves like a mutex.'),
      q('Synchronization', 'Which is NOT a requirement of a critical-section solution?', ['Fairness by arrival time', 'Mutual exclusion', 'Progress', 'Bounded waiting'], 0, 'The three requirements are mutual exclusion, progress and bounded waiting.'),
      q('Deadlocks', 'Holding one lock while waiting for another can lead to…', ['Deadlock', 'Thrashing', 'Paging', 'Aging'], 0, 'Hold-and-wait is one of the conditions that enables deadlock.'),
      q('Synchronization', 'wait() on a semaphore with value 0 will…', ['Block the caller', 'Return immediately', 'Increment the value', 'Terminate the process'], 0, 'With no permits available, wait() blocks until another thread signals.'),
    ],
  },
  {
    title: 'Deadlocks',
    daysAgo: 5,
    questions: [
      q('Deadlocks', 'Which is one of the four Coffman conditions?', ['Circular wait', 'Preemptive scheduling', 'Paging', 'Aging'], 0, 'Mutual exclusion, hold and wait, no preemption and circular wait must all hold.'),
      q('Deadlocks', 'The Banker\'s algorithm is used for deadlock…', ['Avoidance', 'Detection only', 'Recovery', 'Ignorance'], 0, 'It only grants requests that keep the system in a safe state: avoidance.'),
      q('Deadlocks', 'A safe state means…', ['Some order lets every process finish', 'No process holds any resource', 'All resources are free', 'Deadlock already happened'], 0, 'Safe means there is a sequence in which every process can complete.'),
      q('Deadlocks', 'Ordering all locks globally prevents…', ['Circular wait', 'Mutual exclusion', 'Starvation of I/O', 'Page faults'], 0, 'If everyone acquires locks in the same order, a cycle cannot form.'),
      q('Synchronization', 'A spinlock is a good choice when…', ['Locks are held very briefly on multicore', 'Locks are held for seconds', 'There is only one CPU', 'Threads do disk I/O inside'], 0, 'Spinning wastes CPU, so it only pays off for very short holds on multicore systems.'),
    ],
  },
  {
    title: 'Paging & virtual memory',
    daysAgo: 1,
    questions: [
      q('Paging', 'What does the TLB cache?', ['Page-table entries', 'Disk blocks', 'Recently used files', 'Process control blocks'], 0, 'The TLB caches recent virtual-to-physical translations.'),
      q('Paging', 'A page fault occurs when…', ['The page is not in physical memory', 'The TLB is full', 'Two processes share a page', 'A page is written twice'], 0, 'Accessing a page that is not resident traps to the OS: a page fault.'),
      q('Virtual memory', 'Thrashing is caused by…', ['Too little memory for the working sets', 'Too many CPUs', 'A small TLB only', 'Large page sizes'], 0, 'When working sets don\'t fit, the system spends its time paging instead of running.'),
      q('Paging', 'Paging eliminates…', ['External fragmentation', 'Internal fragmentation', 'Page faults', 'The need for a TLB'], 0, 'Fixed-size frames remove external fragmentation; internal fragmentation remains.'),
      q('Virtual memory', 'LRU replacement evicts the page that…', ['Was used least recently', 'Arrived first', 'Will be used last', 'Is the largest'], 0, 'LRU approximates the optimal policy by looking at the recent past.'),
    ],
  },
];

const CLASSMATES = ['Diya Menon', 'Kabir Singh', 'Ananya Iyer', 'Rohan Gupta', 'Sara Khan', 'Vikram Rao', 'Meghna Das'];

/** Small seeded PRNG so the demo looks the same on every server. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rotates options so the correct answer isn't always A. */
function arrange(question, shift) {
  const n = question.options.length;
  const options = question.options.map((_, i) => question.options[(i - shift + n) % n]);
  return { ...question, options, answerIndex: (question.answerIndex + shift) % n };
}

const seeding = new WeakMap(); // db -> Promise, so concurrent first sign-ins seed once

export function ensureDemo(db) {
  if (db.userByEmail(DEMO_EMAILS.professor)) return Promise.resolve();
  if (!seeding.has(db)) seeding.set(db, seed(db));
  return seeding.get(db);
}

async function seed(db) {
  const unusable = await hashPassword(randomBytes(24).toString('hex')); // demo users sign in via /demo only
  const now = Date.now();
  const day = 86_400_000;
  const user = (role, name, email) => {
    const u = { id: newId(), role, name, email, passwordHash: unusable, createdAt: new Date(now - 30 * day).toISOString() };
    db.data.users.push(u);
    return u;
  };

  const prof = user('professor', 'Dr. Meera Rao', DEMO_EMAILS.professor);
  const me = user('student', 'Aarav Shah', DEMO_EMAILS.student);
  const mates = CLASSMATES.map((n, i) => user('student', n, `student${i + 1}@demo.lectureiq`));

  const course = { id: newId(), name: 'Operating Systems', code: CODE, professorId: prof.id, studentIds: [me.id, ...mates.map((m) => m.id)], createdAt: new Date(now - 28 * day).toISOString() };
  const second = { id: newId(), name: 'Data Structures', code: 'DSA7K3', professorId: prof.id, studentIds: mates.slice(0, 3).map((m) => m.id), createdAt: new Date(now - 20 * day).toISOString() };
  db.data.courses.push(course, second);

  const rand = rng(42);
  // Per-student ability and one weak topic; the demo student improves over time and struggles with deadlocks.
  const profiles = [
    { id: me.id, skill: (k) => 0.5 + k * 0.08, weak: 'Deadlocks' },
    ...mates.map((m, i) => ({ id: m.id, skill: () => 0.45 + (i / CLASSMATES.length) * 0.45, weak: ['Paging', 'Scheduling', 'Synchronization'][i % 3] })),
  ];

  QUIZZES.forEach((quiz, k) => {
    const publishedAt = now - quiz.daysAgo * day;
    const questions = quiz.questions.map((qq, i) => arrange(qq, (i + k) % 4));
    const a = { id: newId(), courseId: course.id, professorId: prof.id, title: quiz.title, subject: 'Operating Systems', lectureId: null, difficulty: k % 2 ? 'hard' : 'medium', questions, publishedAt: new Date(publishedAt).toISOString() };
    db.data.assignments.push(a);

    const latest = k === QUIZZES.length - 1;
    for (const [i, p] of profiles.entries()) {
      // The newest quiz is still open: the demo student hasn't taken it and only some classmates have.
      if (latest && (p.id === me.id || i > 4)) continue;
      const answers = questions.map((qq) => {
        const chance = Math.min(0.95, Math.max(0.1, p.skill(k) - (qq.topic === p.weak ? 0.3 : 0)));
        if (rand() < chance) return qq.answerIndex;
        // Wrong answers cluster on one distractor, so the "common mistake" insight has something to find.
        return rand() < 0.6 ? (qq.answerIndex + 1) % 4 : (qq.answerIndex + 2 + Math.floor(rand() * 2)) % 4;
      });
      db.data.submissions.push({
        id: newId(),
        assignmentId: a.id,
        studentId: p.id,
        answers,
        score: grade(questions, answers),
        total: questions.length,
        durationMs: Math.round((2 + rand() * 6) * 60_000),
        submittedAt: new Date(Math.min(now - 600_000, publishedAt + (2 + rand() * 30) * 3_600_000)).toISOString(),
      });
    }
  });
  db.save();
}
