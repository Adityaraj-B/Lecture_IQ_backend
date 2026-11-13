/**
 * Per-user daily cap for AI-backed endpoints, so one enthusiastic student can't spend the
 * shared free-tier quota. Counts live in memory and reset at UTC midnight (and on restart,
 * which only ever loosens the cap).
 */
export function dailyQuota(name, limit) {
  let day = '';
  const used = new Map();
  return (req, res, next) => {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      used.clear();
    }
    const n = used.get(req.user.id) ?? 0;
    if (n >= limit) {
      return res.status(429).json({ error: `Daily limit reached for ${name} (${limit} a day). Try again tomorrow.`, code: 'daily_limit' });
    }
    used.set(req.user.id, n + 1);
    next();
  };
}
