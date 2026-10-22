import { uploadClientCrop } from "../../infrastructure/firebase/storage_client.js";
import { processPeopleRecognition } from "../people_service.js";
import { PIPELINE_CONFIG } from "../../core/pipeline_config.js";

/**
 * 5a. Extracción de recortes de clientes detectados y subida a Storage si es manual.
 */
export async function extractClientCrops({ bucket, clientCrops = [], docId, isManual = false }) {
  const clientRecords = [];
  if (!clientCrops || clientCrops.length === 0) return clientRecords;

  for (let i = 0; i < clientCrops.length; i++) {
    const crop = clientCrops[i];
    let clientStoragePath = null;

    if (isManual && bucket) {
      clientStoragePath = `camera_catcher/photos/${docId}_client_${i + 1}.jpg`;
      await uploadClientCrop(bucket, clientStoragePath, crop.buffer);
    }

    clientRecords.push({
      id: crop.id || `crop_${i + 1}`,
      storagePath: clientStoragePath,
      box: crop.box,
      confidence: crop.confidence,
      role: crop.role || "client",
      roleHint: crop.roleHint || null,
      isStaffHint: crop.isStaffHint === true,
      capturePerson: crop.capturePerson !== false,
      requiresClearCapture: crop.requiresClearCapture === true,
      isHighRes: crop.isHighRes === true,
      status: crop.status || "en_corte",
      detectedAt: new Date().toISOString()
    });
  }

  return clientRecords;
}

/**
 * 5b. Reconocimiento y Re-identificación Facial (filtrado de calidad, nitidez y gobernanza por sesión temporal).
 * @param {Object} params
 * @param {Object} params.db - Instancia de Firestore
 * @param {Array} params.clientRecords - Metadatos de recortes
 * @param {Array} params.clientCrops - Recortes en memoria
 * @param {Array} [params.activeSessions] - Sesiones de visita activas
 * @param {boolean} [params.isRealtime] - Bandera de ejecución en tiempo real
 * @param {boolean} [params.backgroundSync] - Forzar o deshabilitar sincronización en background
 * @returns {Promise<Array>} Personas identificadas
 */
export async function reidentifyPeople({ db, clientRecords = [], clientCrops = [], activeSessions = [], isRealtime = false, backgroundSync, nowEpoch }) {
  if (!clientCrops || clientCrops.length === 0) return [];
  console.log(`[FaceRecognition] Evaluando biometría de personas detectadas...`);
  const effectiveBackgroundSync = backgroundSync !== undefined ? backgroundSync : isRealtime;
  return await processPeopleRecognition(db, clientRecords, clientCrops, activeSessions, { backgroundSync: effectiveBackgroundSync, nowEpoch });
}

export { evaluateFaceQuality, validateHumanSkinAndTexture } from "../face_quality_service.js";
export { matchStaffFace } from "../people_service.js";
export {
  arePosesCompatibleEnhanced,
  computePoseAwareSimilarity,
  computeSetToSetMetrics,
  getClusterSimilarity,
  computeSubsetCohesion
} from "./biometrics_math.js";

// Poses faciales anatómicas genuinas para clientes (excluye estrictamente orejas y nucas laterales: tilted_down_left, tilted_down_right, profile_left, profile_right)
export const VALID_CLIENT_FACE_POSES = PIPELINE_CONFIG.faceDetection.validFacePoses;

export const STEP_SKIN_TEXTURE_NAME = "Filtro de Textura y Piel Humana";
export const SKIN_TEXTURE_DESCRIPTION = (discarded = 0) =>
  `Validación colorimétrica YCbCr y calidez de piel humana (skinRatio >= 0.18 || warmRatio >= 0.22). Se descartaron ${discarded.toLocaleString()} nucas de cabello negro puro y respaldos de cuero.`;
export const formatSkinTextureSummary = (imagesCount = 0, appointmentsCount = 0, details = "") =>
  `3. **${STEP_SKIN_TEXTURE_NAME}:** ${imagesCount.toLocaleString()} imágenes (${appointmentsCount} atenciones humanas confirmadas).${details ? `\n   - *${details}*` : ""}`;

export const STEP_ANTI_OBJECT_NAME = "Filtro Anti-Objetos (Celulares/Pantallas) y Piel Humana";
export const ANTI_OBJECT_DESCRIPTION = (discarded = 0) =>
  `Validación anatómica y de textura: descarte de pantallas de celular, objetos sostenidos en manos o regazo (posición y1 > 0.42) y confirmación de calidez de piel YCbCr (skinRatio >= 0.18 || warmRatio >= 0.22). Se descartaron ${discarded.toLocaleString()} objetos no anatómicos.`;
export const formatAntiObjectSummary = (photos = 0, sessions = 0, desc = "") =>
  `3. **${STEP_ANTI_OBJECT_NAME}:** ${photos.toLocaleString()} imágenes (${sessions} atenciones humanas confirmadas).${desc ? `\n   - *${desc}*` : ""}`;

export const STEP_SHARPNESS_NAME = "Filtro de Nitidez Mínima (Score >= 20)";
export const SHARPNESS_DESCRIPTION = (minScore = 20, discarded = 0) =>
  `Rostros con nitidez mínima suficiente (score >= ${minScore}) para extracción de biometría confiable. Se descartaron ${discarded.toLocaleString()} fotos afectadas por motion blur severo.`;
export const formatSharpnessSummary = (photos = 0, sessions = 0, desc = "") =>
  `4. **${STEP_SHARPNESS_NAME}:** ${photos.toLocaleString()} imágenes (${sessions} atenciones con nitidez mínima).${desc ? `\n   - *${desc}*` : ""}`;

export const STEP_VALID_POSE_NAME = "Filtro de Poses Anatómicas Válidas (Exclusión de Orejas / Nucas)";
export const VALID_POSE_DESCRIPTION = (discarded = 0) =>
  `Exclusión de poses ciegas sin rasgos faciales (perfiles extremos izquierdo/derecho y tilted_down_left/right con nitidez < 35). Se descartaron ${discarded.toLocaleString()} capturas no biométricas.`;
export const formatValidPoseSummary = (photos = 0, sessions = 0, desc = "") =>
  `5. **${STEP_VALID_POSE_NAME}:** ${photos.toLocaleString()} imágenes (${sessions} atenciones con poses biométricas válidas).${desc ? `\n   - *${desc}*` : ""}`;

export const STEP_ANATOMICAL_CLASS_NAME = "Clasificación Anatómica y Geometría Facial (Erguidas 1x2 vs Chatas/Reclinadas)";
export const ANATOMICAL_CLASS_DESCRIPTION = (uprightCount = 0, reclinedCount = 0) =>
  `Separación geométrica de muestras faciales:\n     - ${uprightCount.toLocaleString()} Caras Erguidas (~1x2, Frontal/Semi-perfil): Asignadas como Anclas Biométricas de Identidad (las únicas que determinan quién es el cliente).\n     - ${reclinedCount.toLocaleString()} Caras Chatas/Reclinadas (Inclinadas para corte de nuca / afeitado): Asignadas como Extensores de Tiempo de Corte (no discriminan identidad pero preservan la continuidad temporal de la sesión).`;
export const formatAnatomicalClassSummary = (photos = 0, sessions = 0, desc = "") =>
  `6. **${STEP_ANATOMICAL_CLASS_NAME}:** ${photos.toLocaleString()} imágenes (${sessions} atenciones clasificadas).${desc ? `\n   - *${desc}*` : ""}`;

export const STEP_SHARPNESS_POSE_NAME = "Filtro de Nitidez y Poses Válidas";
export const SHARPNESS_POSE_DESCRIPTION = (minSharpness = 20, discarded = 0) =>
  `Rostros con nitidez mínima (score >= ${minSharpness}) en ángulos faciales anatómicos válidos. Se descartaron ${discarded.toLocaleString()} recortes de nucas, orejas laterales o motion blur.`;
export const formatSharpnessPoseSummary = (imagesCount = 0, appointmentsCount = 0, details = "") =>
  `4. **${STEP_SHARPNESS_POSE_NAME}:** ${imagesCount.toLocaleString()} imágenes (${appointmentsCount} atenciones con nitidez mínima).${details ? `\n   - *${details}*` : ""}`;

export const STEP_STAFF_FILTER_NAME = "Filtro de Barbero / Personal";
export const STAFF_FILTER_DESCRIPTION = (staffThreshold = 0.46, discarded = 0) =>
  `Exclusión combinada por geometría de pie y coincidencia con los 20 vectores de referencia del barbero (similitud >= ${staffThreshold}). Se descartaron ${discarded.toLocaleString()} fotos del barbero cruzando la silla.`;
export const formatStaffFilterSummary = (imagesCount = 0, appointmentsCount = 0, details = "") =>
  `7. **${STEP_STAFF_FILTER_NAME}:** ${imagesCount.toLocaleString()} imágenes (${appointmentsCount} atenciones de clientes, excluyendo personal).${details ? `\n   - *${details}*` : ""}`;

export const formatStepSummary = formatStaffFilterSummary;

