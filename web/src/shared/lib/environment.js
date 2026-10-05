/**
 * Detección de Entorno de Ejecución (Local vs Servidor Cloud) y Bases de Datos Firestore
 * Permite al frontend determinar dinámicamente si se encuentra en un entorno de desarrollo/simulador
 * local o desplegado en producción sobre Firebase Hosting CDN comunicándose con la VM de GCP.
 *
 * Mapeo de Bases de Datos Firestore:
 * - Entorno Local (localhost / 127.0.0.1) -> Base de datos: "test"
 * - Servidor de Producción (Firebase Hosting / GCP) -> Base de datos: "(default)"
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

  // En local por defecto se utiliza la base de datos "test".
  // En producción (GCP / Hosting) se utiliza "(default)".
  const databaseId = customDb || (isLocal ? 'test' : '(default)');
  const backendUrl = customUrl || (isLocal ? 'http://localhost:8085' : null);

  return {
    isLocal,
    isServer: !isLocal,
    hostname: typeof window !== 'undefined' ? window.location.hostname : 'unknown',
    environmentMode: isLocal ? 'local' : 'server',
    environmentLabel: isLocal ? 'Local (Simulador E2)' : 'Servidor Cloud (GCP)',
    databaseId,
    dispatchTarget: isLocal
      ? `HTTP Directo (http://localhost:8085) + Firestore [${databaseId}]`
      : `Firestore Event Bus [${databaseId}] (camera_catcher/commands)`,
    backendUrl,
    hasCustomUrl: !!customUrl,
    hasCustomDb: !!customDb
  };
}

/**
 * Permite cambiar manualmente la base de datos de Firestore en el navegador (para pruebas o desarrollo)
 * @param {string|null} dbId - "test", "(default)" o null para restablecer al valor automático
 */
export function switchFirestoreDatabase(dbId) {
  if (typeof localStorage === 'undefined') return;
  if (!dbId || dbId === 'auto') {
    localStorage.removeItem('CAMERA_CATCHER_FIRESTORE_DB');
  } else {
    localStorage.setItem('CAMERA_CATCHER_FIRESTORE_DB', dbId);
  }
  if (typeof window !== 'undefined') {
    window.location.reload();
  }
}
