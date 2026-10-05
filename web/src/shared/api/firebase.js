import { initializeApp } from 'firebase/app';
import { 
  getFirestore, 
  collection, 
  doc, 
  onSnapshot, 
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc 
} from 'firebase/firestore';
import { 
  getStorage, 
  ref, 
  getDownloadURL 
} from 'firebase/storage';

// Firebase Web Configuration for skip-bigotes
export const firebaseConfig = {
  projectId: "skip-bigotes",
  appId: "1:1033289992711:web:4a490808d63b933a08f8a2",
  storageBucket: "skip-bigotes.firebasestorage.app",
  apiKey: "AIzaSyB0ihpyYO-jBnsYF4x9Uy77WbgpwqVPYUo",
  authDomain: "skip-bigotes.firebaseapp.com",
  messagingSenderId: "1033289992711",
  measurementId: "G-3369KSG3CS"
};

// Initialize Firebase
export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const storage = getStorage(app);

import { isLocalEnvironment, getEnvironmentInfo } from '@/shared/lib/environment';

export { isLocalEnvironment, getEnvironmentInfo };
export const IS_LOCAL_ENV = isLocalEnvironment();
export const IS_SERVER_ENV = !IS_LOCAL_ENV;

// Backend API URL: En local apunta al simulador/daemon (8085). En servidor (GCP/Hosting) es nulo ya que la VM usa Firestore
let storedUrl = typeof localStorage !== 'undefined' ? localStorage.getItem("CAMERA_CATCHER_API_URL") : null;
if (storedUrl && storedUrl.includes("run.app")) {
  localStorage.removeItem("CAMERA_CATCHER_API_URL");
  storedUrl = null;
}
export const BACKEND_URL = storedUrl || (IS_LOCAL_ENV ? "http://localhost:8085" : null);

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
    console.warn(`[Storage] No se pudo obtener la URL de descarga para ${imageStoragePath}:`, err);
    return "";
  }
}
