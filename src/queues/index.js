'use strict';

const { Queue } = require('bullmq');
const { getRedisConnection } = require('../config/redis');

// ── Lazy queue factory ────────────────────────────────────────────────────────
// Queues are only created on first use. If REDIS_URL is not reachable,
// errors only occur when an enqueue is attempted, not at boot time.

const _queues = {};

function getQueue(name, defaultJobOptions = {}) {
  if (!_queues[name]) {
    const conn = getRedisConnection();
    _queues[name] = new Queue(name, {
      connection: conn,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
        ...defaultJobOptions,
      },
    });

    // Silence ioredis connection-refused noise at the queue level
    _queues[name].on('error', (err) => {
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        // Only log once per queue, not every retry
        if (!_queues[name]._warnedConnErr) {
          console.warn(`[Queue:${name}] Redis not reachable (${err.message}). Jobs will be held until Redis is available.`);
          _queues[name]._warnedConnErr = true;
        }
      } else {
        console.error(`[Queue:${name}] Error:`, err.message);
      }
    });
  }
  return _queues[name];
}

// ── Named queue accessors ─────────────────────────────────────────────────────

/** Queue for per-chunk transcription jobs */
function transcribeChunkQueue() {
  return getQueue('transcribeChunk', {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  });
}

/** Queue for transcript assembly */
function assembleTranscriptQueue() {
  return getQueue('assembleTranscript', {
    attempts: 3,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 200 },
  });
}

/** Queue for LLM MCQ generation */
function generateMCQsQueue() {
  return getQueue('generateMCQs', {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 200 },
  });
}

module.exports = { transcribeChunkQueue, assembleTranscriptQueue, generateMCQsQueue };
