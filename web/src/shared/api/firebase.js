import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getStorage, ref, getDownloadURL } from "firebase/storage";
import { isLocalEnvironment, getEnvironmentInfo, switchEnvironmentResources, switchFirestoreDatabase } from '@/shared/lib/environment';

export const firebaseConfig = {
  apiKey: "AIzaSyC2qf1_REPLACE_WITH_REAL_OR_PROD_IF_SET",
  authDomain: "skip-bigotes.firebaseapp.com",
  projectId: "skip-bigotes",
  storageBucket: "skip-bigotes.firebasestorage.app",
  messagingSenderId: "1033289992711",
  measurementId: "G-3369KSG3CS"
};

// 1. Inicializar Firebase App
export const app = initializeApp(firebaseConfig);

// 2. Resolver Entorno, Base de Datos y Storage Bucket (test en local, default en prod)
const envInfo = getEnvironmentInfo();
export const IS_LOCAL_ENV = envInfo.isLocal;
export const IS_SERVER_ENV = envInfo.isServer;
export const FIRESTORE_DATABASE_ID = envInfo.databaseId;
export const STORAGE_BUCKET = envInfo.storageBucket;

// 3. Inicializar Firestore y Storage en los recursos adecuados:
// - Local: DB "test" y Storage "gs://skip-bigotes-test"
// - Prod: DB "(default)" y Storage "gs://skip-bigotes.firebasestorage.app"
export const db = getFirestore(app, FIRESTORE_DATABASE_ID);
export const storage = getStorage(app, STORAGE_BUCKET);

// Backend API URL: En local apunta al simulador/daemon (8085). En servidor (GCP/Hosting) es nulo ya que la VM usa Firestore
export const BACKEND_URL = envInfo.backendUrl;

export { isLocalEnvironment, getEnvironmentInfo, switchEnvironmentResources, switchFirestoreDatabase };

// Cache resolved image URLs from Storage SDK to avoid redundant network calls
const urlCache = new Map();

/**
 * Resolves a storage path (e.g. photos/2026-10-02/photo.jpg) to a public download URL
 */
export async function resolveStorageUrl(imageStoragePath) {
  if (!imageStoragePath) return "";
  if (urlCache.has(imageStoragePath)) {
    return urlCache.get(imageStoragePath);
  }

  try {
    const storageRef = ref(storage, imageStoragePath);
    const downloadUrl = await getDownloadURL(storageRef);
    urlCache.set(imageStoragePath, downloadUrl);
    return downloadUrl;
  } catch (err) {
    console.warn(`[Storage] No se pudo obtener la URL de descarga para ${imageStoragePath} en ${STORAGE_BUCKET}:`, err);
    return "";
  }
}
