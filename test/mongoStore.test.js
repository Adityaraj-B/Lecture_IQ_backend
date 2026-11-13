import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/store/db.js';
import { mongoStoreFor } from '../src/store/mongoStore.js';

/** Just enough of the driver's Db/Collection API, backed by Maps, recording bulk calls. */
function fakeDatabase() {
  const collections = new Map();
  const calls = [];
  let failNext = false;
  const collection = (name) => {
    if (!collections.has(name)) collections.set(name, new Map());
    const docs = collections.get(name);
    return {
      find: () => ({ toArray: async () => [...docs.values()].map((d) => structuredClone(d)) }),
      bulkWrite: async (ops) => {
        if (failNext) {
          failNext = false;
          throw new Error('network blip');
        }
        calls.push({ name, ops });
        for (const op of ops) {
          if (op.replaceOne) docs.set(op.replaceOne.filter._id, { _id: op.replaceOne.filter._id, ...op.replaceOne.replacement });
          if (op.deleteOne) docs.delete(op.deleteOne.filter._id);
        }
      },
    };
  };
  return { collection, calls, docs: (name) => collections.get(name) ?? new Map(), failOnce: () => (failNext = true) };
}

test('mongo store writes only what changed, deletes what was removed, and reloads it', async () => {
  const database = fakeDatabase();
  const store = mongoStoreFor(database);
  const db = await Db.open(store);

  db.data.users.push({ id: 'u1', name: 'Asha', role: 'student' }, { id: 'u2', name: 'Ben', role: 'student' });
  db.data.courses.push({ id: 'c1', name: 'OS', studentIds: [] });
  await db.save();
  assert.equal(database.calls.length, 2); // users + courses; untouched collections send nothing
  assert.equal(database.docs('users').get('u1').name, 'Asha');
  assert.ok(!('id' in database.docs('users').get('u1'))); // stored once, as _id

  database.calls.length = 0;
  db.course('c1').studentIds.push('u1'); // in-place mutation, like the join route does
  db.data.users = db.data.users.filter((u) => u.id !== 'u2');
  await db.save();
  assert.deepEqual(
    database.calls.map((c) => [c.name, c.ops.map((o) => Object.keys(o)[0])]),
    [
      ['users', ['deleteOne']],
      ['courses', ['replaceOne']],
    ],
  );

  database.calls.length = 0;
  await db.save(); // nothing changed
  assert.equal(database.calls.length, 0);

  const reloaded = await Db.open(mongoStoreFor(database));
  assert.deepEqual(reloaded.data.users, [{ id: 'u1', name: 'Asha', role: 'student' }]);
  assert.deepEqual(reloaded.course('c1').studentIds, ['u1']);
});

test('a failed write is retried in full on the next save', async () => {
  const database = fakeDatabase();
  const store = mongoStoreFor(database);
  const db = await Db.open(store);

  db.data.users.push({ id: 'u1', name: 'Asha' });
  database.failOnce();
  await assert.rejects(store.write(db.data), /network blip/);
  assert.equal(database.docs('users').size, 0);

  await store.write(db.data);
  assert.equal(database.docs('users').get('u1').name, 'Asha');
});
