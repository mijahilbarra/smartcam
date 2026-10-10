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
 * Normaliza una URL asegurando protocolo http:// o https:// y eliminando barras finales
 * @param {string|null} url
 * @returns {string|null}
 */
export function normalizeUrl(url) {
  if (!url) return null;
  let u = url.trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) {
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/i.test(u)) {
      u = `http://${u}`;
    } else {
      u = `https://${u}`;
    }
  }
  return u.replace(/\/+$/, '');
}

/**
 * Obtiene la configuración y estado completo del entorno actual
 */
export function getEnvironmentInfo() {
  const isLocal = isLocalEnvironment();

  // En entorno local (localhost / 127.0.0.1), purgar proactivamente si apunta a un dominio remoto de producción
  if (isLocal && typeof localStorage !== 'undefined') {
    const rawStored = localStorage.getItem('CAMERA_CATCHER_API_URL');
    if (rawStored) {
      const isStoredLocal = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)/i.test(rawStored.trim());
      if (!isStoredLocal) {
        console.warn('[Environment] Purgando URL remota guardada en localStorage durante entorno local:', rawStored);
        localStorage.removeItem('CAMERA_CATCHER_API_URL');
      }
    }
  }

  const rawCustomUrl = typeof localStorage !== 'undefined' ? localStorage.getItem('CAMERA_CATCHER_API_URL') : null;
  const customUrl = normalizeUrl(rawCustomUrl);
  const isCustomLocal = customUrl && /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)/i.test(customUrl);

  const envUrl = normalizeUrl(
    typeof import.meta !== 'undefined' && import.meta.env
      ? import.meta.env.VITE_CAMERA_CATCHER_API_URL
      : null
  );
  const customDb = typeof localStorage !== 'undefined' ? localStorage.getItem('CAMERA_CATCHER_FIRESTORE_DB') : null;
  const customStorage = typeof localStorage !== 'undefined' ? localStorage.getItem('CAMERA_CATCHER_STORAGE_BUCKET') : null;

  // En local por defecto se utiliza la base de datos "test" y el bucket "gs://skip-bigotes-test".
  // En producción (GCP / Hosting) se utiliza "(default)" y "gs://skip-bigotes.firebasestorage.app".
  // Permite override si el usuario selecciona explícitamente otra base en la configuración (localStorage).
  const databaseId = customDb || (isLocal ? 'test' : '(default)');
  const storageBucket = customStorage || (isLocal ? 'gs://skip-bigotes-test' : 'gs://skip-bigotes.firebasestorage.app');

  // Resolución prioritaria de backendUrl:
  // - En entorno local (isLocal): SOLO aceptar customUrl si es explícitamente localhost/127.0.0.1, de lo contrario 'http://localhost:8085'
  // - En producción (Cloud): customUrl > envUrl > null
  let backendUrl = null;
  if (isLocal) {
    if (isCustomLocal) {
      backendUrl = customUrl;
    } else {
      backendUrl = 'http://localhost:8085';
    }
  } else {
    if (customUrl) {
      backendUrl = customUrl;
    } else if (envUrl) {
      backendUrl = envUrl;
    } else {
      backendUrl = 'https://stream.perrosuelto.com';
    }
  }

  return {
    isLocal,
    isServer: !isLocal,
    hostname: typeof window !== 'undefined' ? window.location.hostname : 'unknown',
    environmentMode: isLocal ? 'local' : 'server',
    environmentLabel: isLocal ? 'Local (Simulador E2)' : 'Servidor Cloud (GCP)',
    databaseId,
    storageBucket,
    dispatchTarget: isLocal
      ? `HTTP Directo (${backendUrl || 'http://localhost:8085'}) + Firestore [${databaseId}] + Storage [${storageBucket}]`
      : (backendUrl
          ? `Túnel Seguro (${backendUrl}) + Firestore [${databaseId}] + Storage [${storageBucket}]`
          : `Firestore Event Bus [${databaseId}]`),
    backendUrl,
    hasCustomUrl: isLocal ? !!isCustomLocal : !!customUrl,
    hasCustomDb: !!customDb,
    hasCustomStorage: !!customStorage
  };
}

/**
 * Permite actualizar dinámicamente la URL del backend/túnel en localStorage
 * @param {string|null} url - URL del backend (ej: https://stream.tudominio.com)
 */
export function setCustomBackendUrl(url) {
  if (typeof localStorage === 'undefined') return;
  const trimmed = typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
  if (!trimmed) {
    localStorage.removeItem('CAMERA_CATCHER_API_URL');
  } else {
    localStorage.setItem('CAMERA_CATCHER_API_URL', trimmed);
  }
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
