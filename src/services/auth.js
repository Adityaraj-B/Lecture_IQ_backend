import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length);
  return timingSafeEqual(actual, expected);
}

const sign = (payload, secret) => createHmac('sha256', secret).update(payload).digest();

/** Compact signed token: base64url(json).base64url(hmac). */
export function signToken(userId, secret, ttlMs) {
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Date.now() + ttlMs })).toString('base64url');
  return `${payload}.${sign(payload, secret).toString('base64url')}`;
}

/** Returns the user id, or null when the token is malformed, forged or expired. */
export function verifyToken(token, secret) {
  const [payload, sig] = String(token ?? '').split('.');
  if (!payload || !sig) return null;
  const given = Buffer.from(sig, 'base64url');
  const expected = sign(payload, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { sub, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof sub === 'string' && exp > Date.now() ? sub : null;
  } catch {
    return null;
  }
}
