import { detectObjectsAndQuadrants } from "../../detector.js";
import { daemonReporter } from "../../daemon_reporter.js";

/**
 * 3. Inferencia de Visión Local (ONNX Runtime / YOLO) y activación de cuadrantes.
 */
export async function detectScene(buffer, { isRealtime = false } = {}) {
  if (!isRealtime) console.log(`[3/5] Analizando fotograma con Machine Learning local (ONNX Runtime)...`);
  const mlResult = await detectObjectsAndQuadrants(buffer, { isRealtime });
  if (!isRealtime) console.log(`[ML] Inferencia completada en ${mlResult.inferenceMs} ms. Cuadrantes detectados: ${mlResult.quadrants.length}`);

  if (!isRealtime) {
    await daemonReporter.reportQuadrantsActive(mlResult.quadrants);
    await daemonReporter.reportHumanDetection(mlResult);
  }

  return mlResult;
}

export const STEP_NAME = "Filtro de Detección Facial";
export const STEP_DESCRIPTION = (discarded = 0, conf = 0.70) =>
  `Rostro detectable mediante red neuronal RFB-320 (confianza >= ${conf}). Se descartaron ${discarded.toLocaleString()} recortes sin cara (espaldas, hombros o cabezal vacío).`;
export const formatStepSummary = (imagesCount = 0, appointmentsCount = 0, details = "") =>
  `2. **${STEP_NAME}:** ${imagesCount.toLocaleString()} imágenes (${appointmentsCount} atenciones con rostro detectable).${details ? `\n   - *${details}*` : ""}`;

