import { uploadClientCrop } from "../../infrastructure/firebase/storage_client.js";
import { processPeopleRecognition } from "../people_service.js";

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
export async function reidentifyPeople({ db, clientRecords = [], clientCrops = [], activeSessions = [], isRealtime = false, backgroundSync }) {
  if (!clientCrops || clientCrops.length === 0) return [];
  console.log(`[FaceRecognition] Evaluando biometría de personas detectadas...`);
  const effectiveBackgroundSync = backgroundSync !== undefined ? backgroundSync : isRealtime;
  return await processPeopleRecognition(db, clientRecords, clientCrops, activeSessions, { backgroundSync: effectiveBackgroundSync });
}
