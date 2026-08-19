'use strict';

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

let firebaseApp = null;

function getFirebaseApp() {
  if (firebaseApp) return firebaseApp;

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

  // TODO: replace this stub with real Firebase credentials when available
  if (!serviceAccountPath || !fs.existsSync(serviceAccountPath)) {
    console.warn(
      '[Firebase] Service account not found at:', serviceAccountPath,
      '— Firebase Firestore calls will be STUBBED (no-ops).'
    );
    return null;
  }

  const serviceAccount = require(path.resolve(serviceAccountPath));

  firebaseApp = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  console.log('[Firebase] Initialized with project:', serviceAccount.project_id);
  return firebaseApp;
}

function getFirestore() {
  const app = getFirebaseApp();
  if (!app) return null; // stub — callers must null-check
  return admin.firestore();
}

module.exports = { getFirebaseApp, getFirestore };
