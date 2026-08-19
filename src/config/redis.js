'use strict';

/**
 * Redis connection config for BullMQ / ioredis.
 * Supports both redis:// (plain) and rediss:// (TLS — required for Upstash).
 */
function getRedisConnection() {
  const rawUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const url = new URL(rawUrl);

  const isTLS = rawUrl.startsWith('rediss://');

  return {
    host: url.hostname,
    port: parseInt(url.port || (isTLS ? '6380' : '6379'), 10),
    username: url.username || 'default',
    password: url.password ? decodeURIComponent(url.password) : undefined,

    // TLS required for Upstash and any rediss:// URL
    ...(isTLS && {
      tls: {},  // ioredis uses empty object for TLS with system CA (works for Upstash)
    }),

    // BullMQ requires maxRetriesPerRequest=null (not 0) for its internal commands
    maxRetriesPerRequest: null,
    enableReadyCheck: false,

    connectTimeout: 10000,  // 10s to establish initial TLS handshake

    retryStrategy: (times) => {
      if (times > 10) return null; // stop retrying after 10 attempts
      const delay = Math.min(times * 300, 3000);
      if (times === 1) {
        console.warn(`[Redis] Connection failed — retrying (attempt ${times})...`);
      }
      return delay;
    },
  };
}

module.exports = { getRedisConnection };
