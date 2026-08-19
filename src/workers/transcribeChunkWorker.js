'use strict';

/**
 * transcribeChunkWorker.js — Step 4
 *
 * Consumes 'transcribeChunk' jobs.
 * For each job:
 *  1. Calls sttService.callSTT with the chunk's Cloudinary audio URL
 *  2. Upserts the resulting segments into the Transcript document
 *  3. Marks the chunk status as 'transcribed' on the Lecture doc
 *  4. On final failure → marks chunk 'failed' (does NOT stop the pipeline)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { Worker } = require('bullmq');
const mongoose = require('mongoose');

const { getRedisConnection } = require('../config/redis');
const { connectDB } = require('../config/db');
const { callSTT } = require('../services/sttService');
const Lecture = require('../models/Lecture');
const Transcript = require('../models/Transcript');

const QUEUE_NAME = 'transcribeChunk';

async function processTranscribeChunk(job) {
  const { lectureId, sequence, audioUrl } = job.data;
  console.log(`[Worker:transcribeChunk] job=${job.id} lecture=${lectureId} chunk=${sequence}`);

  // Fetch lecture for language config
  const lecture = await Lecture.findById(lectureId).select('language');
  if (!lecture) throw new Error(`Lecture ${lectureId} not found`);

  // ── Call STT ──────────────────────────────────────────────────────────────
  const sttResult = await callSTT(audioUrl, lecture.language);

  // ── Upsert Transcript document ────────────────────────────────────────────
  const newSegments = sttResult.segments.map((seg, i) => ({
    sequence: sequence * 1000 + i, // ensure ordering across chunks
    startTime: seg.start,
    endTime: seg.end,
    text: seg.text,
    speaker: seg.speaker || 'unknown',
    language: seg.language || sttResult.language,
    sttStatus: 'success',
  }));

  await Transcript.findOneAndUpdate(
    { lectureId },
    { $push: { segments: { $each: newSegments } } },
    { upsert: true, new: true }
  );

  // ── Mark chunk as transcribed on Lecture ──────────────────────────────────
  await Lecture.findOneAndUpdate(
    { _id: lectureId, 'audioChunks.sequence': sequence },
    { $set: { 'audioChunks.$.status': 'transcribed' } }
  );

  console.log(`[Worker:transcribeChunk] ✅ chunk=${sequence} transcribed, ${newSegments.length} segments added`);
  return { lectureId, sequence, segmentsAdded: newSegments.length };
}

async function startWorker() {
  await connectDB();

  const worker = new Worker(QUEUE_NAME, processTranscribeChunk, {
    connection: getRedisConnection(),
    concurrency: 5,
  });

  worker.on('completed', (job, result) => {
    console.log(`[Worker:transcribeChunk] Job ${job.id} completed:`, result);
  });

  // Step 10 — failure handler: mark chunk as failed in MongoDB
  worker.on('failed', async (job, err) => {
    console.error(`[Worker:transcribeChunk] Job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts}):`, err.message);

    const isLastAttempt = job.attemptsMade >= (job.opts.attempts || 3);
    if (isLastAttempt && job.data?.lectureId && job.data?.sequence != null) {
      try {
        await Lecture.findOneAndUpdate(
          { _id: job.data.lectureId, 'audioChunks.sequence': job.data.sequence },
          { $set: { 'audioChunks.$.status': 'failed' } }
        );

        // Push a failed segment placeholder so assembleTranscript knows this chunk is a gap
        await Transcript.findOneAndUpdate(
          { lectureId: job.data.lectureId },
          {
            $push: {
              segments: {
                sequence: job.data.sequence * 1000,
                startTime: 0,
                endTime: 0,
                text: `[TRANSCRIPTION FAILED for chunk ${job.data.sequence}]`,
                speaker: 'unknown',
                sttStatus: 'failed',
              },
            },
          },
          { upsert: true }
        );
        console.warn(`[Worker:transcribeChunk] Marked chunk ${job.data.sequence} as failed in MongoDB`);
      } catch (dbErr) {
        console.error('[Worker:transcribeChunk] Failed to update MongoDB on job failure:', dbErr.message);
      }
    }
  });

  console.log(`[Worker:transcribeChunk] 🚀 Listening on queue '${QUEUE_NAME}'`);
}

module.exports = { startWorker };

// Allow running as standalone process: node src/workers/transcribeChunkWorker.js
if (require.main === module) {
  startWorker().catch((err) => {
    console.error('[Worker:transcribeChunk] Startup error:', err);
    process.exit(1);
  });
}
