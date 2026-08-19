'use strict';

/**
 * generateMCQsWorker.js — Step 6
 *
 * Consumes 'generateMCQs' jobs.
 * Steps:
 *  1. Load the Transcript (professor-only fullText)
 *  2. Split into ~7-minute time windows
 *  3. Generate MCQs for each window via llmService
 *  4. Aggregate into one MCQSet document (status: draft)
 *  5. Set Lecture status → 'ready_for_review'
 *  6. Call notifyProfessor (stub)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { Worker } = require('bullmq');
const { v4: uuidv4 } = require('uuid');

const { getRedisConnection } = require('../config/redis');
const { connectDB } = require('../config/db');
const { splitIntoTimeWindows, generateMCQsForSegment } = require('../services/mcqService');
const Lecture = require('../models/Lecture');
const Transcript = require('../models/Transcript');
const Course = require('../models/Course');
const MCQSet = require('../models/MCQSet');

const QUEUE_NAME = 'generateMCQs';

// ── Notify professor stub ─────────────────────────────────────────────────────

async function notifyProfessor(lectureId, mcqSetId) {
  // TODO: replace with real FCM push notification via Firebase Admin SDK
  console.log(`[Notify] STUB — Professor notified: lecture=${lectureId} mcqSet=${mcqSetId} is ready for review`);
}

// ── Main job processor ────────────────────────────────────────────────────────

async function processGenerateMCQs(job) {
  const { lectureId } = job.data;
  console.log(`[Worker:generateMCQs] job=${job.id} lecture=${lectureId}`);

  // ── Load transcript ────────────────────────────────────────────────────────
  const transcript = await Transcript.findOne({ lectureId });
  if (!transcript) throw new Error(`Transcript not found for lecture ${lectureId}`);

  const lecture = await Lecture.findById(lectureId).select('courseId professorId language title');
  if (!lecture) throw new Error(`Lecture ${lectureId} not found`);

  const course = await Course.findById(lecture.courseId).select('name code');
  const courseContext = course ? `${course.name} (${course.code})` : 'University course';

  // ── Professor-only segments (already filtered in assembleTranscript) ───────
  const professorSegments = transcript.segments
    .filter((s) => s.speaker === 'professor' && s.sttStatus === 'success')
    .sort((a, b) => a.sequence - b.sequence);

  if (professorSegments.length === 0) {
    console.warn(`[Worker:generateMCQs] No professor segments found — using fullTextConcatenated fallback`);
  }

  // ── Split into time windows ────────────────────────────────────────────────
  const windows = professorSegments.length > 0
    ? splitIntoTimeWindows(professorSegments, 7)
    : [{ windowIndex: 0, startTime: 0, endTime: 0, text: transcript.fullTextConcatenated, segments: [] }];

  console.log(`[Worker:generateMCQs] Processing ${windows.length} time window(s)`);
  await job.updateProgress(10);

  // ── Generate MCQs per window (continue past individual failures) ──────────
  const allQuestions = [];
  let failedWindows = 0;

  for (let i = 0; i < windows.length; i++) {
    const window = windows[i];
    if (!window.text || window.text.trim().length < 20) {
      console.warn(`[Worker:generateMCQs] Skipping window ${i} — too short (${window.text?.trim().length ?? 0} chars)`);
      continue;
    }

    const result = await generateMCQsForSegment(window.text, courseContext, i);

    if (result.failed) {
      failedWindows++;
      console.warn(`[Worker:generateMCQs] Window ${i} MCQ generation failed — continuing`);
    } else {
      // Attach metadata to each question
      const enriched = result.questions.map((q) => ({
        questionId: uuidv4(),
        text: q.text,
        options: q.options,
        correctIndex: q.correctIndex,
        difficulty: q.difficulty || 'medium',
        timestampRef: window.startTime,
        sourceSegmentId: window.segments[0]?.sequence ?? null,
        confidenceScore: q.confidenceScore ?? null,
        professorEdited: false,
        // conceptId will be null until a Concept is created from the concept name
        _conceptName: q.concept, // temporary field for future concept linking
      }));
      allQuestions.push(...enriched);
    }

    await job.updateProgress(10 + Math.round(((i + 1) / windows.length) * 80));
  }

  console.log(`[Worker:generateMCQs] Generated ${allQuestions.length} questions (${failedWindows} windows failed)`);

  // ── Upsert MCQSet ─────────────────────────────────────────────────────────
  const mcqSet = await MCQSet.findOneAndUpdate(
    { lectureId },
    {
      $set: {
        lectureId,
        status: 'draft',
        questions: allQuestions,
      },
    },
    { upsert: true, new: true }
  );

  // ── Update Lecture status → ready_for_review ──────────────────────────────
  await Lecture.findByIdAndUpdate(lectureId, { $set: { status: 'ready_for_review' } });

  // ── Notify professor ───────────────────────────────────────────────────────
  await notifyProfessor(lectureId, mcqSet._id);

  await job.updateProgress(100);
  console.log(`[Worker:generateMCQs] ✅ MCQSet ${mcqSet._id} created with ${allQuestions.length} questions`);
  return { lectureId, mcqSetId: mcqSet._id, questionCount: allQuestions.length, failedWindows };
}

// ── Start worker ──────────────────────────────────────────────────────────────

async function startWorker() {
  await connectDB();

  const worker = new Worker(QUEUE_NAME, processGenerateMCQs, {
    connection: getRedisConnection(),
    concurrency: 2,
  });

  worker.on('completed', (job, result) => {
    console.log(`[Worker:generateMCQs] Job ${job.id} completed:`, result);
  });

  // Step 10 — failure handler
  worker.on('failed', async (job, err) => {
    console.error(`[Worker:generateMCQs] Job ${job.id} FAILED:`, err.message);

    const isLastAttempt = job.attemptsMade >= (job.opts.attempts || 2);
    if (isLastAttempt && job.data?.lectureId) {
      try {
        await Lecture.findByIdAndUpdate(job.data.lectureId, {
          $set: {
            status: 'failed',
            processingError: `MCQ generation failed: ${err.message}`,
          },
        });
        console.warn(`[Worker:generateMCQs] Marked lecture ${job.data.lectureId} as failed`);
      } catch (dbErr) {
        console.error('[Worker:generateMCQs] Failed to update MongoDB on job failure:', dbErr.message);
      }
    }
  });

  console.log(`[Worker:generateMCQs] 🚀 Listening on queue '${QUEUE_NAME}'`);
}

module.exports = { startWorker };

if (require.main === module) {
  startWorker().catch((err) => {
    console.error('[Worker:generateMCQs] Startup error:', err);
    process.exit(1);
  });
}
