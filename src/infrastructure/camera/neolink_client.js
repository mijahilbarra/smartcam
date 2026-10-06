/**
 * Adaptador de Cámara Neolink (P2P Baichuan vía Docker)
 * Ejecuta el contenedor efímero Neolink para capturar el fotograma RTSP y administra procesos huérfanos.
 */

import { exec } from "child_process";
import fs from "fs/promises";
import util from "util";

const execPromise = util.promisify(exec);

export const DEFAULT_CONTAINER_NAME = "neolink-capture";

/**
 * Elimina forzosamente el contenedor de captura si quedó congelado
 * @param {string} containerName
 */
export async function killCaptureContainer(containerName = DEFAULT_CONTAINER_NAME) {
  try {
    await execPromise(`docker rm -f ${containerName} 2>/dev/null || true`);
  } catch (_) {}
}

/**
 * Limpieza profunda de contenedores o procesos huérfanos de capturas anteriores
 * @param {string} containerName
 */
export async function cleanupZombies(containerName = DEFAULT_CONTAINER_NAME) {
  try {
    console.log("[Neolink] Limpiando procesos y contenedores huérfanos de capturas anteriores...");
    await execPromise(`docker rm -f ${containerName} 2>/dev/null || true`);
    // Solo eliminar contenedores efímeros de captura, NUNCA el daemon RTSP permanente
    await execPromise(`docker ps -a -q --filter name=neolink-capture | xargs -r docker rm -f 2>/dev/null || true`);
    await execPromise(`pkill -9 -f 'neolink image' 2>/dev/null || true`);
  } catch (err) {
    console.warn("[Neolink] Aviso durante limpieza inicial:", err.message);
  }
}

export const DEFAULT_DAEMON_CONTAINER = "neolink-daemon";

/**
 * Inicia el contenedor permanente Neolink en modo servidor RTSP
 * @param {Object} options
 * @param {string} options.tomlPath
 * @param {string} [options.containerName]
 */
export async function startNeolinkDaemon({ tomlPath, containerName = DEFAULT_DAEMON_CONTAINER }) {
  try {
    const { stdout } = await execPromise(`docker ps -q --filter name=${containerName}`);
    if (stdout.trim().length > 0) {
      console.log(`[Neolink] Daemon RTSP ya está en ejecución (${containerName}).`);
      return true;
    }
    await execPromise(`docker rm -f ${containerName} 2>/dev/null || true`);
    const cmd = `docker run -d --name ${containerName} --restart unless-stopped -v "${tomlPath}":/etc/neolink.toml -p 8554:8554 quantumentangledandy/neolink:latest neolink rtsp -c /etc/neolink.toml`;
    await execPromise(cmd);
    console.log(`[Neolink] Daemon RTSP iniciado exitosamente en puerto 8554.`);
    return true;
  } catch (err) {
    console.warn(`[Neolink] Aviso iniciando daemon RTSP:`, err.message);
    return false;
  }
}

/**
 * Detiene el contenedor Neolink RTSP
 */
export async function stopNeolinkDaemon(containerName = DEFAULT_DAEMON_CONTAINER) {
  try {
    await execPromise(`docker rm -f ${containerName} 2>/dev/null || true`);
  } catch (_) {}
}

/**
 * Extrae un fotograma directamente del servidor RTSP local mediante FFmpeg (~200ms)
 * @param {Object} options
 * @param {string} [options.rtspUrl]
 * @param {string} options.localOutputPath
 * @param {number} [options.timeoutMs]
 * @returns {Promise<Buffer>}
 */
export async function captureSnapshotFromRtsp({
  rtspUrl = "rtsp://127.0.0.1:8554/barberia/main",
  localOutputPath,
  timeoutMs = 8000
}) {
  const cmd = `ffmpeg -y -rtsp_transport tcp -i "${rtspUrl}" -vframes 1 -f image2 "${localOutputPath}"`;
  await execPromise(cmd, { timeout: timeoutMs });
  const buffer = await fs.readFile(localOutputPath);
  try {
    await fs.unlink(localOutputPath);
  } catch (_) {}
  return buffer;
}

/**
 * Estrategia de captura adaptativa: Intenta RTSP local rápido (< 300ms);
 * si el daemon no está listo, recurre a contenedor efímero.
 */
export async function captureSnapshotAdaptive(options) {
  try {
    return await captureSnapshotFromRtsp(options);
  } catch (_) {
    return await captureSnapshotWithDocker(options);
  }
}

/**
 * Ejecuta una captura fotográfica mediante el contenedor Docker de Neolink
 * @param {Object} options
 * @param {string} options.tomlPath
 * @param {string} options.localOutputPath
 * @param {string} [options.containerName]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.cameraName]
 * @returns {Promise<Buffer>}
 */
export async function captureSnapshotWithDocker({
  tomlPath,
  localOutputPath,
  containerName = DEFAULT_CONTAINER_NAME,
  timeoutMs = 45000,
  cameraName = "barberia"
}) {
  await killCaptureContainer(containerName);

  const filename = localOutputPath.split("/").pop();
  const cmd = `docker run --rm --name ${containerName} --init --stop-timeout 5 -v "${tomlPath}":/etc/neolink.toml -v /tmp:/out quantumentangledandy/neolink:latest neolink image -c /etc/neolink.toml --use-stream -f /out/${filename} ${cameraName}`;

  try {
    await execPromise(cmd, { timeout: timeoutMs });
  } catch (err) {
    await killCaptureContainer(containerName);
    try {
      await fs.stat(localOutputPath);
    } catch (_) {
      throw new Error(`Neolink capture failed: ${err.message}`);
    }
  }

  const buffer = await fs.readFile(localOutputPath);

  // Limpiar archivo temporal en disco
  try {
    await fs.unlink(localOutputPath);
  } catch (_) {}

  return buffer;
}

