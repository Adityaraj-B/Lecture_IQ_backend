'use strict';

require('dotenv').config();

const app = require('./app');
const { connectDB } = require('./config/db');

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await connectDB();
    const isProduction = process.env.NODE_ENV === 'production';
    app.listen(PORT, () => {
      if (isProduction) {
        console.log(`[Server] LectureIQ backend running on port ${PORT} (production)`);
      } else {
        console.log(`[Server] LectureIQ backend running on http://localhost:${PORT}`);
      }
      console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`[Server] STT Provider: ${process.env.STT_PROVIDER || 'mock'}`);
      console.log(`[Server] LLM Provider: ${process.env.LLM_PROVIDER || 'mock'}`);
    });

    // ── Start BullMQ workers in-process ────────────────────────────────────────
    // All three workers share the same Node.js process as the HTTP server.
    // This is fine for development and single-instance deployments.
    // For production scale, move each worker to a dedicated process/container.
    const { startWorker: startTranscribeWorker } = require('./workers/transcribeChunkWorker');
    const { startWorker: startAssembleWorker } = require('./workers/assembleTranscriptWorker');
    const { startWorker: startMCQWorker } = require('./workers/generateMCQsWorker');

    await startTranscribeWorker();
    await startAssembleWorker();
    await startMCQWorker();

    console.log('[Server] ✅ All BullMQ workers started');
  } catch (err) {
    console.error('[Server] Failed to start:', err);
    process.exit(1);
  }
}

start();
