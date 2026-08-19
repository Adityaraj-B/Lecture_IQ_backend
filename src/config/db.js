'use strict';

// NEVER log process.env values that contain credentials (connection strings, API keys,
// secrets) directly or in full — logs are persisted by hosting providers and can leak.
// Log only non-sensitive derived info (host, db name, "configured: true/false").

const mongoose = require('mongoose');

let isConnected = false;

async function connectDB() {
  if (isConnected) return;

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set in environment');

  await mongoose.connect(uri);
  isConnected = true;
  console.log(`[MongoDB] Connected to: ${mongoose.connection.host}/${mongoose.connection.name}`);

  mongoose.connection.on('error', (err) => {
    console.error('[MongoDB] Connection error:', err);
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('[MongoDB] Disconnected');
    isConnected = false;
  });
}

module.exports = { connectDB };
