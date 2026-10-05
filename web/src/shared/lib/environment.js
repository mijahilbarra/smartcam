/**
 * Detección de Entorno de Ejecución (Local vs Servidor Cloud)
 * Permite al frontend determinar dinámicamente si se encuentra en un entorno de desarrollo/simulador
 * local o desplegado en producción sobre Firebase Hosting CDN comunicándose con la VM de GCP.
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
  const backendUrl = customUrl || (isLocal ? 'http://localhost:8085' : null);

  return {
    isLocal,
    isServer: !isLocal,
    hostname: typeof window !== 'undefined' ? window.location.hostname : 'unknown',
    environmentMode: isLocal ? 'local' : 'server',
    environmentLabel: isLocal ? 'Local (Simulador E2)' : 'Servidor Cloud (GCP)',
    dispatchTarget: isLocal
      ? 'HTTP Directo (http://localhost:8085) + Firestore'
      : 'Firestore Event Bus (camera_catcher/commands)',
    backendUrl,
    hasCustomUrl: !!customUrl
  };
}
