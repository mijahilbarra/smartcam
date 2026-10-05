/**
 * Detección de Entorno de Ejecución (Local vs Servidor Cloud)
 * y Enrutamiento de Recursos Aislados de Firebase (Firestore & Storage)
 *
 * Mapeo de Recursos:
 * - Entorno Local (localhost / 127.0.0.1 / Simulador E2):
 *     - Firestore Database: "test"
 *     - Storage Bucket: "gs://skip-bigotes-test"
 * - Servidor de Producción (Firebase Hosting / GCP Compute Engine):
 *     - Firestore Database: "(default)"
 *     - Storage Bucket: "gs://skip-bigotes.firebasestorage.app"
 */

/**
 * Determina si la aplicación se está ejecutando en un entorno local (localhost, IP de loopback o red local)
 * @returns {boolean}
 */
export function isLocalEnvironment() {
  if (typeof window === 'undefined' || !window.location) {
    return false;
  }
  const hostname = window.location.hostname;
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname.endsWith('.local')
  );
}

/**
 * Obtiene la configuración y estado completo del entorno actual
 */
export function getEnvironmentInfo() {
  const isLocal = isLocalEnvironment();
  const customUrl = typeof localStorage !== 'undefined' ? localStorage.getItem('CAMERA_CATCHER_API_URL') : null;
  const customDb = typeof localStorage !== 'undefined' ? localStorage.getItem('CAMERA_CATCHER_FIRESTORE_DB') : null;
  const customStorage = typeof localStorage !== 'undefined' ? localStorage.getItem('CAMERA_CATCHER_STORAGE_BUCKET') : null;

  // En local por defecto se utiliza la base de datos "test" y el bucket "gs://skip-bigotes-test".
  // En producción (GCP / Hosting) se utiliza "(default)" y "gs://skip-bigotes.firebasestorage.app".
  const databaseId = customDb || (isLocal ? 'test' : '(default)');
  const storageBucket = customStorage || (isLocal ? 'gs://skip-bigotes-test' : 'gs://skip-bigotes.firebasestorage.app');
  const backendUrl = customUrl || (isLocal ? 'http://localhost:8085' : null);

  return {
    isLocal,
    isServer: !isLocal,
    hostname: typeof window !== 'undefined' ? window.location.hostname : 'unknown',
    environmentMode: isLocal ? 'local' : 'server',
    environmentLabel: isLocal ? 'Local (Simulador E2)' : 'Servidor Cloud (GCP)',
    databaseId,
    storageBucket,
    dispatchTarget: isLocal
      ? `HTTP Directo (http://localhost:8085) + Firestore [${databaseId}] + Storage [${storageBucket}]`
      : `Firestore Event Bus [${databaseId}] (camera_catcher/commands)`,
    backendUrl,
    hasCustomUrl: !!customUrl,
    hasCustomDb: !!customDb,
    hasCustomStorage: !!customStorage
  };
}

/**
 * Permite cambiar manualmente los recursos de Firebase en el navegador (para pruebas o desarrollo)
 * @param {string|null} mode - "test", "prod" o "auto"
 */
export function switchEnvironmentResources(mode) {
  if (typeof localStorage === 'undefined') return;
  if (!mode || mode === 'auto') {
    localStorage.removeItem('CAMERA_CATCHER_FIRESTORE_DB');
    localStorage.removeItem('CAMERA_CATCHER_STORAGE_BUCKET');
  } else if (mode === 'test') {
    localStorage.setItem('CAMERA_CATCHER_FIRESTORE_DB', 'test');
    localStorage.setItem('CAMERA_CATCHER_STORAGE_BUCKET', 'gs://skip-bigotes-test');
  } else if (mode === 'prod' || mode === '(default)') {
    localStorage.setItem('CAMERA_CATCHER_FIRESTORE_DB', '(default)');
    localStorage.setItem('CAMERA_CATCHER_STORAGE_BUCKET', 'gs://skip-bigotes.firebasestorage.app');
  }
  if (typeof window !== 'undefined') {
    window.location.reload();
  }
}

// Mantener alias para retrocompatibilidad
export const switchFirestoreDatabase = (dbId) => {
  if (dbId === 'test') switchEnvironmentResources('test');
  else if (dbId === '(default)' || dbId === 'prod') switchEnvironmentResources('prod');
  else switchEnvironmentResources('auto');
};
