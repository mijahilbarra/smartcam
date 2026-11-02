import { captureSnapshotAdaptive } from "../../infrastructure/camera/neolink_client.js";
import { uploadRawSnapshot } from "../../infrastructure/firebase/storage_client.js";
import { daemonReporter } from "../../daemon_reporter.js";

/**
 * 1. Adquisición del fotograma: en tiempo real obtiene el buffer en RAM (0 ms);
 *    en modo manual ejecuta la captura adaptativa P2P con Neolink.
 */
export async function acquireFrame({
  streamServer,
  tomlPath,
  docId,
  isRealtime = false,
  triggerSource = "manual",
  localOutputPath
}) {
  if (!isRealtime) {
    console.log(`\n========================================`);
    console.log(`[1/5] Ejecutando captura P2P (${docId})...`);
    await daemonReporter.reportCameraQuery(triggerSource);
  }

  let buffer = null;
  if (isRealtime) {
    if (streamServer?.isPaused || streamServer?.mockVideoEnded) {
      return null;
    }
    buffer = streamServer?.getLatestFrame?.();
    if (!buffer) {
      return null;
    }
  } else {
    try {
      buffer = await captureSnapshotAdaptive({
        tomlPath,
        localOutputPath: localOutputPath || `/tmp/snap_${docId}.jpeg`
      });
    } catch (err) {
      console.warn(`[AcquireFrame] Aviso en captura adaptativa: ${err.message}. Intentando buffer en RAM...`);
      buffer = streamServer?.getLatestFrame?.() || null;
    }
  }

  if (!isRealtime && buffer) {
    console.log(`[2/5] Fotograma capturado: ${buffer.length} bytes.`);
  }

  return buffer;
}

/**
 * 2. Subida de imagen diagnóstica a Firebase Storage (solo capturas manuales o de arranque).
 */
export async function uploadDiagnosticSnapshot({ bucket, docId, buffer, isManual = false }) {
  if (!isManual) return null;

  const storagePath = `camera_catcher/photos/${docId}.jpg`;
  console.log(`[Storage] Subiendo imagen diagnóstica a Firebase Storage: ${storagePath}...`);
  if (bucket) {
    await uploadRawSnapshot(bucket, storagePath, buffer);
  }

  await daemonReporter.reportImageReceived({
    storagePath,
    width: 1024,
    height: 576,
    sizeBytes: buffer.length,
    docId
  });

  return storagePath;
}

export const STEP_NAME = "Cosecha inicial";
export const STEP_DESCRIPTION = (total = 0) =>
  `Recortes brutos detectados por YOLO en la silla de corte durante el Paso 1.`;
export const formatStepSummary = (imagesCount = 0, appointmentsCount = 0, details = "") =>
  `1. **${STEP_NAME}:** ${imagesCount.toLocaleString()} fotos (${appointmentsCount} atenciones tentativas por track_id).${details ? `\n   - *${details}*` : ""}`;

