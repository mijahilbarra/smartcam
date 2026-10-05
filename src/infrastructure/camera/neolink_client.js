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
    await execPromise(`docker ps -q --filter ancestor=quantumentangledandy/neolink:latest | xargs -r docker rm -f 2>/dev/null || true`);
    await execPromise(`pkill -9 -f 'neolink image' 2>/dev/null || true`);
  } catch (err) {
    console.warn("[Neolink] Aviso durante limpieza inicial:", err.message);
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
