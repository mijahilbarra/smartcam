/**
 * Inicialización de Firebase Admin SDK (Singleton)
 * Configura Firestore y Firebase Storage en los entornos y recursos adecuados:
 * - Local / Pruebas / Simulador E2:
 *     - Firestore Database: "test"
 *     - Storage Bucket: "skip-bigotes-test" (gs://skip-bigotes-test)
 * - Producción (GCP Compute Engine & Firebase Hosting):
 *     - Firestore Database: "(default)"
 *     - Storage Bucket: "skip-bigotes.firebasestorage.app"
 */

import net from "node:net";
if (net.setDefaultAutoSelectFamily) {
  net.setDefaultAutoSelectFamily(false);
}

import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";

let isInitialized = false;
let currentDb = null;
let currentBucket = null;
let currentDatabaseId = null;
let currentBucketName = null;

/**
 * Resuelve qué base de datos Firestore utilizar
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

/**
 * Resuelve qué bucket de Google Cloud Storage utilizar
 * @param {Object} options
 * @returns {string}
 */
export function getResolvedStorageBucket(options = {}) {
  if (options.storageBucket) {
    return options.storageBucket.replace(/^gs:\/\//, "");
  }
  if (process.env.STORAGE_BUCKET) {
    return process.env.STORAGE_BUCKET.replace(/^gs:\/\//, "");
  }

  const isGcpProdVm =
    process.cwd().startsWith("/opt/camera-catcher") &&
    process.env.IS_LOCAL_SIMULATOR !== "true";

  if (isGcpProdVm) {
    return "skip-bigotes.firebasestorage.app";
  }

  // Por defecto en local / desarrollo / simulador
  return "skip-bigotes-test";
}

export function initFirebaseAdmin(options = {}) {
  const isTestMode =
    process.env.IS_LOCAL_SIMULATOR === "true" ||
    process.env.USE_FIREBASE === "false" ||
    process.env.NO_FIREBASE === "true" ||
    options.disableFirebase === true;

  if (isTestMode) {
    console.log(`[Firebase] 🧪 Modo Test activo (IS_LOCAL_SIMULATOR=true / USE_FIREBASE=false). Conexión a Firebase omitida. Operando 100% con SQLite.`);
    currentDatabaseId = "test";
    currentBucketName = null;
    currentDb = null;
    currentBucket = null;
    isInitialized = true;
    return {
      admin: null,
      db: null,
      bucket: null,
      databaseId: "test",
      bucketName: null
    };
  }

  const databaseId = getResolvedDatabaseId(options);
  const bucketName = getResolvedStorageBucket(options);

  if (!admin.apps.length) {
    admin.initializeApp({
      projectId: options.projectId || process.env.FIREBASE_PROJECT_ID || "skip-bigotes",
      storageBucket: bucketName
    });
    isInitialized = true;
  }

  currentDatabaseId = databaseId;
  currentBucketName = bucketName;
  const app = admin.app();

  // Conectar a la base de datos Firestore resuelta
  currentDb = databaseId === "(default)" ? getFirestore(app) : getFirestore(app, databaseId);
  currentBucket = admin.storage().bucket(bucketName);

  console.log(`[Firebase] Conectado a Firestore [Database: ${databaseId}] & Storage [Bucket: ${bucketName}] (Proyecto: ${options.projectId || process.env.FIREBASE_PROJECT_ID || "skip-bigotes"})`);

  return {
    admin,
    db: currentDb,
    bucket: currentBucket,
    databaseId: currentDatabaseId,
    bucketName: currentBucketName
  };
}

export function getFirebaseAdmin() {
  if (!isInitialized) {
    return initFirebaseAdmin();
  }
  return {
    admin: admin.apps.length ? admin : null,
    db: currentDb,
    bucket: currentBucket,
    databaseId: currentDatabaseId,
    bucketName: currentBucketName
  };
}

export { admin };
