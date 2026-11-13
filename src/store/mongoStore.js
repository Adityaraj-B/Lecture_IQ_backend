import { MongoClient } from 'mongodb';
import { COLLECTIONS } from './db.js';

/**
 * Persists the working set to MongoDB, one document per record (`_id` = record id).
 * Each write diffs every record against what was last written and sends only the
 * changes (upserts and deletes) in one bulk call per collection.
 *
 * Takes a connected `Db` handle (from the driver) so tests can pass a fake.
 */
export function mongoStoreFor(database, { onClose } = {}) {
  const written = new Map(COLLECTIONS.map((c) => [c, new Map()])); // collection -> id -> JSON last written

  return {
    kind: 'mongodb',

    async load() {
      const data = {};
      for (const name of COLLECTIONS) {
        const docs = await database.collection(name).find({}).toArray();
        data[name] = docs.map(({ _id, ...doc }) => ({ ...doc, id: _id }));
        for (const doc of data[name]) written.get(name).set(doc.id, JSON.stringify(doc));
      }
      return data;
    },

    async write(data) {
      // Build every operation synchronously first, so the snapshot is consistent
      // even if requests mutate the data while the network calls are in flight.
      const batches = COLLECTIONS.map((name) => {
        const last = written.get(name);
        const next = new Map();
        const ops = [];
        for (const doc of data[name] ?? []) {
          const json = JSON.stringify(doc);
          next.set(doc.id, json);
          if (last.get(doc.id) !== json) {
            const { id, ...rest } = doc;
            ops.push({ replaceOne: { filter: { _id: id }, replacement: rest, upsert: true } });
          }
        }
        for (const id of last.keys()) {
          if (!next.has(id)) ops.push({ deleteOne: { filter: { _id: id } } });
        }
        return { name, ops, next };
      });

      for (const { name, ops, next } of batches) {
        if (ops.length) await database.collection(name).bulkWrite(ops, { ordered: false });
        written.set(name, next); // only after success, so a failed write is retried in full
      }
    },

    close: onClose,
  };
}

export async function mongoStore(uri, dbName) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000 });
  await client.connect();
  return mongoStoreFor(client.db(dbName), { onClose: () => client.close() });
}
