'use strict';

/**
 * assembleTranscriptWorker.js — Step 5
 *
 * Consumes 'assembleTranscript' jobs (one per lecture, triggered after finalize).
 * Steps:
 *  1. Poll until all chunks are transcribed or failed (or timeout)
 *  2. Sort segments by sequence number
 *  3. Apply diarization labels (uses STT output; stub for future override)
 *  4. Build fullTextConcatenated from professor-only segments
 *  5. Save updated Transcript
 *  6. Enqueue 'generateMCQs' job
 *  7. Update Lecture status to 'ready_for_review'
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { Worker } = require('bullmq');
const mongoose = require('mongoose');

const { getRedisConnection } = require('../config/redis');
const { connectDB } = require('../config/db');
const { generateMCQsQueue } = require('../queues');
const Lecture = require('../models/Lecture');
const Transcript = require('../models/Transcript');

const QUEUE_NAME = 'assembleTranscript';
const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes

// ── Diarization stub ──────────────────────────────────────────────────────────

/**
 * applyDiarization(segments) → segments with speaker labels.
 * Uses STT-provided speaker info if available.
 * TODO: replace with a proper diarization model if STT doesn't provide labels.
 */
function applyDiarization(segments) {
  return segments.map((seg) => ({
    ...seg,
    speaker: seg.speaker || 'professor', // default to professor when unknown
  }));
}

// ── Main job processor ────────────────────────────────────────────────────────

async function processAssembleTranscript(job) {
  const { lectureId, expectedChunks } = job.data;
  console.log(`[Worker:assembleTranscript] job=${job.id} lecture=${lectureId} expecting=${expectedChunks} chunks`);

  // ── Step 1: Wait for all chunks to finish (transcribed or failed) ──────────
  const deadline = Date.now() + MAX_WAIT_MS;
  let lecture;

  while (Date.now() < deadline) {
    lecture = await Lecture.findById(lectureId).select('audioChunks status');
    if (!lecture) throw new Error(`Lecture ${lectureId} not found`);

    const done = lecture.audioChunks.filter(
      (c) => c.status === 'transcribed' || c.status === 'failed'
    ).length;

    console.log(`[Worker:assembleTranscript] ${done}/${expectedChunks} chunks done`);
    if (done >= expectedChunks) break;

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    await job.updateProgress(Math.round((done / expectedChunks) * 50)); // 0-50% for polling
  }

  const failedChunks = lecture.audioChunks.filter((c) => c.status === 'failed');
  if (failedChunks.length > 0) {
    console.warn(
      `[Worker:assembleTranscript] ${failedChunks.length} chunk(s) failed — continuing with gaps`
    );
  }

  // ── Step 2: Sort segments by sequence ─────────────────────────────────────
  const transcript = await Transcript.findOne({ lectureId });
  if (!transcript) throw new Error(`Transcript document not found for lecture ${lectureId}`);

  // Convert Mongoose subdocs to plain objects before sorting/spreading
  // (Mongoose DocumentArray entries need .toObject() for reliable spread)
  const plainSegments = transcript.segments.map((s) => s.toObject ? s.toObject() : { ...s });
  const sortedSegments = [...plainSegments].sort((a, b) => a.sequence - b.sequence);

  // ── Step 3: Apply diarization ─────────────────────────────────────────────
  const diarizedSegments = applyDiarization(sortedSegments);

  // Build fullTextConcatenated — professor-only if diarization worked, else all successful
  const professorSegments = diarizedSegments.filter(
    (s) => s.speaker === 'professor' && s.sttStatus === 'success'
  );
  const allSuccessSegments = diarizedSegments.filter((s) => s.sttStatus === 'success');
  const sourceSegments = professorSegments.length > 0 ? professorSegments : allSuccessSegments;
  const fullTextConcatenated = sourceSegments.map((s) => s.text).join(' ');
  console.log(`[Worker:assembleTranscript] text built from ${sourceSegments.length} segments (${professorSegments.length} professor-labeled), length=${fullTextConcatenated.length}`);

  // ── Step 5: Save updated Transcript ───────────────────────────────────────
  await Transcript.findOneAndUpdate(
    { lectureId },
    {
      $set: {
        segments: diarizedSegments,
        fullTextConcatenated,
      },
    }
  );
  await job.updateProgress(75);

  // ── Step 6: Enqueue generateMCQs ──────────────────────────────────────────
  const mcqJob = await generateMCQsQueue().add(
    'generateMCQs',
    { lectureId },
    { jobId: `generateMCQs-${lectureId}` }
  );
  console.log(`[Worker:assembleTranscript] ✅ Transcript assembled. Queued generateMCQs job ${mcqJob.id}`);

  await job.updateProgress(100);
  return { lectureId, segmentCount: diarizedSegments.length, professorTextLength: fullTextConcatenated.length };
}

// ── Start worker ──────────────────────────────────────────────────────────────

async function startWorker() {
  await connectDB();

  const worker = new Worker(QUEUE_NAME, processAssembleTranscript, {
    connection: getRedisConnection(),
    concurrency: 2,
  });

  worker.on('completed', (job, result) => {
    console.log(`[Worker:assembleTranscript] Job ${job.id} completed:`, result);
  });

  // Step 10 — failure handler
  worker.on('failed', async (job, err) => {
    console.error(`[Worker:assembleTranscript] Job ${job.id} FAILED:`, err.message);

    const isLastAttempt = job.attemptsMade >= (job.opts.attempts || 3);
    if (isLastAttempt && job.data?.lectureId) {
      try {
        await Lecture.findByIdAndUpdate(job.data.lectureId, {
          $set: {
            status: 'failed',
            processingError: `Transcript assembly failed: ${err.message}`,
          },
        });
        console.warn(`[Worker:assembleTranscript] Marked lecture ${job.data.lectureId} as failed`);
      } catch (dbErr) {
        console.error('[Worker:assembleTranscript] Failed to update MongoDB on job failure:', dbErr.message);
      }
    }
  });

  console.log(`[Worker:assembleTranscript] 🚀 Listening on queue '${QUEUE_NAME}'`);
}

module.exports = { startWorker };

if (require.main === module) {
  startWorker().catch((err) => {
    console.error('[Worker:assembleTranscript] Startup error:', err);
    process.exit(1);
  });
}
