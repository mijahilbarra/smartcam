/**
 * Inicialización de Firebase Admin SDK (Singleton)
 * Configura Firestore y Cloud Storage usando Application Default Credentials (ADC) en GCP VM.
 */

import admin from "firebase-admin";

let isInitialized = false;

export function initFirebaseAdmin(options = {}) {
  if (!admin.apps.length) {
    admin.initializeApp({
      projectId: options.projectId || process.env.FIREBASE_PROJECT_ID || "skip-bigotes",
      storageBucket: options.storageBucket || process.env.STORAGE_BUCKET || "skip-bigotes.firebasestorage.app"
    });
    isInitialized = true;
  }
  return {
    admin,
    db: admin.firestore(),
    bucket: admin.storage().bucket()
  };
}

export function getFirebaseAdmin() {
  if (!admin.apps.length) {
    return initFirebaseAdmin();
  }
  return {
    admin,
    db: admin.firestore(),
    bucket: admin.storage().bucket()
  };
}

export { admin };
