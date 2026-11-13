import path from 'node:path';
import { createApp } from './app.js';
import { config, describeConfig } from './config.js';
import { Db } from './store/db.js';
import { fileStore } from './store/fileStore.js';
import { mongoStore } from './store/mongoStore.js';

const store = config.mongo.uri
  ? await mongoStore(config.mongo.uri, config.mongo.dbName)
  : fileStore(path.join(config.dataDir, 'db.json'));
const db = await Db.open(store);
const app = createApp({ db, secret: config.auth.secret });

const server = app.listen(config.port, () => {
  console.log(`lecture-iq api listening on :${config.port}`, describeConfig());
  if (!config.auth.secretConfigured) {
    console.warn('[auth] AUTH_SECRET not set: using a random key, so everyone is signed out on restart');
  }
  if (!config.mongo.uri) {
    // Render sets RENDER=true. Its disk is wiped on every sleep and redeploy, so a file there loses everything.
    if (process.env.RENDER) {
      console.warn('[db] WARNING: MONGODB_URI is not set. Data is stored on Render\'s temporary disk and will be LOST on the next sleep or deploy.');
    } else {
      console.log(`[db] using local file storage in ${config.dataDir}/`);
    }
  }
});

// Render sends SIGTERM on redeploy and when the free instance sleeps: finish pending writes first.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    server.close();
    server.closeAllConnections(); // open live-event streams would otherwise hold the server open
    await db.close();
    process.exit(0);
  });
}
