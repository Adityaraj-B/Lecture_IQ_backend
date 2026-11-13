import { Router } from 'express';
import { config } from '../config.js';
import { hashPassword, signToken, verifyPassword } from '../services/auth.js';
import { DEMO_EMAILS, ensureDemo } from '../services/demo.js';
import { newId } from '../store/db.js';

const ROLES = ['student', 'professor'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const publicUser = ({ id, name, email, role }) => ({ id, name, email, role });

export function authRouter({ db, secret, authenticate }) {
  const router = Router();
  const session = (user) => ({ token: signToken(user.id, secret, config.auth.tokenTtlMs), user: publicUser(user) });

  /** POST /v1/auth/register { role, name, email, password, facultyCode? } */
  router.post('/register', async (req, res, next) => {
    try {
      const role = req.body?.role;
      const name = String(req.body?.name ?? '').trim().slice(0, 60);
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const password = String(req.body?.password ?? '');

      if (!ROLES.includes(role)) return res.status(400).json({ error: 'Choose student or professor' });
      if (!name) return res.status(400).json({ error: 'Enter your name' });
      if (!EMAIL.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      if (role === 'professor' && config.auth.facultyCode && req.body?.facultyCode !== config.auth.facultyCode) {
        return res.status(403).json({ error: 'A valid faculty access code is required', code: 'faculty_code' });
      }
      if (db.userByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists' });

      const user = { id: newId(), role, name, email, passwordHash: await hashPassword(password), createdAt: new Date().toISOString() };
      db.data.users.push(user);
      db.save();
      res.status(201).json(session(user));
    } catch (err) {
      next(err);
    }
  });

  /** POST /v1/auth/login { email, password } */
  router.post('/login', async (req, res, next) => {
    try {
      const user = db.userByEmail(String(req.body?.email ?? '').trim().toLowerCase());
      const ok = user && (await verifyPassword(String(req.body?.password ?? ''), user.passwordHash));
      if (!ok) return res.status(401).json({ error: 'Wrong email or password', code: 'credentials' });
      res.json(session(user));
    } catch (err) {
      next(err);
    }
  });

  /** POST /v1/auth/demo { role }: signs in as the seeded demo professor or student. */
  router.post('/demo', async (req, res, next) => {
    try {
      if (!config.demoMode) return res.status(404).json({ error: 'Demo sign-in is turned off on this server' });
      const email = DEMO_EMAILS[req.body?.role];
      if (!email) return res.status(400).json({ error: 'Choose student or professor' });
      await ensureDemo(db);
      res.json(session(db.userByEmail(email)));
    } catch (err) {
      next(err);
    }
  });

  router.get('/me', authenticate, (req, res) => res.json({ user: publicUser(req.user) }));

  return router;
}
