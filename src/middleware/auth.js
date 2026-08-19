'use strict';

const jwt = require('jsonwebtoken');
const { createError } = require('./errorHandler');

/**
 * requireAuth — verifies JWT and attaches req.user = { id, role, email }
 * Expects header: Authorization: Bearer <token>
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.slice(7); // strip "Bearer "
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.id, role: payload.role };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * requireRole(role | role[]) — role-gate factory.
 * Must be used AFTER requireAuth in the middleware chain.
 * Usage: router.post('/start', requireAuth, requireRole('professor'), handler)
 */
function requireRole(...roles) {
  const allowed = roles.flat();
  return function (req, res, next) {
    if (!req.user || !allowed.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden — insufficient role' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
