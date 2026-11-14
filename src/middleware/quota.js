const today = () => new Date().toISOString().slice(0, 10);

/** The last day each database was pruned for, so old counters are cleared once a day. */
const prunedOn = new WeakMap();

function pruneOldDays(db, day) {
  if (prunedOn.get(db) === day) return;
  prunedOn.set(db, day);
  const before = db.data.usage.length;
  db.data.usage = db.data.usage.filter((r) => r.day === day);
  if (db.data.usage.length !== before) db.save();
}

/**
 * Per-user daily cap for AI-backed endpoints, so one account can't spend the shared AI
 * quota. Counts are stored in the database (so a server restart no longer resets them)
 * and roll over at UTC midnight. Every request counts, including ones that later fail.
 *
 * @param {{ db, key: string, label: string, limit: number }} opts
 *   key: stable name for the counter; label: what the user sees in the error message.
 */
export function dailyQuota({ db, key, label, limit }) {
  return (req, res, next) => {
    const day = today();
    pruneOldDays(db, day);
    const id = `${req.user.id}:${key}:${day}`;
    let row = db.data.usage.find((r) => r.id === id);
    if (row && row.count >= limit) {
      return res
        .status(429)
        .json({ error: `Daily limit reached for ${label} (${limit} a day). Try again tomorrow.`, code: 'daily_limit' });
    }
    if (!row) {
      row = { id, userId: req.user.id, key, day, count: 0 };
      db.data.usage.push(row);
    }
    row.count++;
    db.save();
    next();
  };
}
