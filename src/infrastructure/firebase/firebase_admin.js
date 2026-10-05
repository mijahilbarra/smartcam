/**
 * Inicialización de Firebase Admin SDK (Singleton)
 * Configura Firestore en la base de datos adecuada:
 * - "test": En entorno local, desarrollo, pruebas o simulador Docker E2.
 * - "(default)": En la máquina virtual de producción en GCP Compute Engine.
 */

import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";

let isInitialized = false;
let currentDb = null;
let currentBucket = null;
let currentDatabaseId = null;

/**
 * Resuelve qué base de datos Firestore utilizar:
 * 1. Prioridad 1: Opción explícita en options.databaseId.
 * 2. Prioridad 2: Variable de entorno FIRESTORE_DATABASE_ID.
 * 3. Prioridad 3: Si se ejecuta en la VM de producción en GCP (/opt/camera-catcher sin bandera de simulador) -> "(default)".
 * 4. Por defecto: "test" para entorno local y desarrollo.
 * @param {Object} options
 * @returns {string}
 */
export function getResolvedDatabaseId(options = {}) {
  if (options.databaseId) {
    return options.databaseId;
  }
  if (process.env.FIRESTORE_DATABASE_ID) {
    return process.env.FIRESTORE_DATABASE_ID;
  }

  // Comprobar si se ejecuta en la VM de producción de GCP
  const isGcpProdVm =
    process.cwd().startsWith("/opt/camera-catcher") &&
    process.env.IS_LOCAL_SIMULATOR !== "true";

  if (isGcpProdVm) {
    return "(default)";
  }

  // Por defecto en local / desarrollo / simulador
  return "test";
}

export function initFirebaseAdmin(options = {}) {
  if (!admin.apps.length) {
    admin.initializeApp({
      projectId: options.projectId || process.env.FIREBASE_PROJECT_ID || "skip-bigotes",
      storageBucket: options.storageBucket || process.env.STORAGE_BUCKET || "skip-bigotes.firebasestorage.app"
    });
    isInitialized = true;
  }

  const databaseId = getResolvedDatabaseId(options);
  currentDatabaseId = databaseId;
  const app = admin.app();

  // getFirestore(app) conecta a (default); getFirestore(app, "test") conecta a la base de datos nombrada "test"
  currentDb = databaseId === "(default)" ? getFirestore(app) : getFirestore(app, databaseId);
  currentBucket = admin.storage().bucket();

  console.log(`[Firebase] Conectado a Firestore [Database: ${databaseId}] (Proyecto: ${options.projectId || process.env.FIREBASE_PROJECT_ID || "skip-bigotes"})`);

  return {
    admin,
    db: currentDb,
    bucket: currentBucket,
    databaseId
  };
}

export function getFirebaseAdmin() {
  if (!isInitialized || !currentDb) {
    return initFirebaseAdmin();
  }
  return {
    admin,
    db: currentDb,
    bucket: currentBucket,
    databaseId: currentDatabaseId
  };
}

export { admin };
