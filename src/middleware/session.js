import { verifyToken } from '../services/auth.js';

/** Resolves `Authorization: Bearer <token>` to `req.user`. `code: 'auth'` tells the app to sign out. */
export function authenticate({ db, secret }) {
  return (req, res, next) => {
    const match = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    const user = match ? db.user(verifyToken(match[1], secret)) : undefined;
    if (!user) return res.status(401).json({ error: 'Your session expired, please sign in again', code: 'auth' });
    req.user = user;
    next();
  };
}

export const requireRole = (role) => (req, res, next) =>
  req.user.role === role ? next() : res.status(403).json({ error: `Only ${role}s can do that` });
