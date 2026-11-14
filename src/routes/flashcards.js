import { Router } from 'express';

const MAX_CARDS = 100;
const MAX_BOX = 10;

/** One card's review state: Leitner box, next due time and when it was last reviewed (ms since epoch). */
function cleanCard(v) {
  if (!v || typeof v !== 'object') return null;
  const box = Number(v.box);
  const due = Number(v.due);
  const at = Number(v.at ?? 0);
  if (!Number.isInteger(box) || box < 0 || box > MAX_BOX) return null;
  if (!Number.isFinite(due) || !Number.isFinite(at) || due < 0 || at < 0) return null;
  return { box, due: Math.round(due), at: Math.round(at) };
}

/**
 * Flashcard progress, synced so it follows the user to a new phone. Each card keeps
 * whichever review happened last (`at`), so two devices can study the same lecture.
 */
export function flashcardsRouter({ db }) {
  const router = Router();

  const visibleTo = (user, noteId) => {
    const course = db.course(db.note(noteId)?.courseId);
    if (!course) return false;
    return user.role === 'professor' ? course.professorId === user.id : course.studentIds.includes(user.id);
  };

  /** GET /v1/flashcards: { progress: { [noteId]: { [cardIndex]: { box, due, at } } } } */
  router.get('/', (req, res) => {
    const progress = {};
    for (const r of db.data.flashcards) {
      if (r.userId === req.user.id) progress[r.noteId] = r.cards;
    }
    res.json({ progress });
  });

  /** PUT /v1/flashcards/:noteId { cards: { [cardIndex]: { box, due, at } } } → the merged cards */
  router.put('/:noteId', (req, res) => {
    const { noteId } = req.params;
    if (!visibleTo(req.user, noteId)) return res.status(404).json({ error: 'Notes not found' });
    const incoming = req.body?.cards;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return res.status(400).json({ error: 'Invalid flashcard progress' });
    }

    const id = `${req.user.id}_${noteId}`;
    const row = db.data.flashcards.find((r) => r.id === id) ?? { id, userId: req.user.id, noteId, cards: {} };
    const cards = { ...row.cards };
    for (const [index, value] of Object.entries(incoming)) {
      const card = cleanCard(value);
      if (!/^\d{1,3}$/.test(index) || Number(index) >= MAX_CARDS || !card) continue;
      if (!cards[index] || card.at >= (cards[index].at ?? 0)) cards[index] = card;
    }
    db.data.flashcards = [...db.data.flashcards.filter((r) => r.id !== id), { ...row, cards }];
    db.save();
    res.json({ cards });
  });

  return router;
}
