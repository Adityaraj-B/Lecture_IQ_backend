'use strict';

/**
 * Global Express error-handling middleware.
 * Must be registered as the LAST middleware in app.js.
 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const status = err.statusCode || err.status || 500;
  const message = err.message || 'Internal Server Error';

  // Don't leak stack traces in production
  const payload = {
    error: message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  };

  console.error(`[ErrorHandler] ${req.method} ${req.path} → ${status}:`, message);
  res.status(status).json(payload);
}

/**
 * Convenience helper to create HTTP errors with a status code.
 * Usage: throw createError(404, 'Lecture not found')
 */
function createError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

module.exports = { errorHandler, createError };
