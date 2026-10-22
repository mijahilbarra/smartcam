/**
 * Reconciliador de Perfiles Provisionales ("to_verify")
 *
 * Módulo extraído del pipeline de atención para desacoplar:
 * 1. Detección y auto-eliminación física de perfiles que coinciden con el Barbero/Staff
 * 2. Purga de perfiles provisionales huérfanos/abandonados tras liberación de silla
 */

import { computeCosineSimilarity, extractFaceEmbedding } from "../../face_recognizer.js";
import { PIPELINE_CONFIG } from "../../core/pipeline_config.js";

/**
 * Reconcilia perfiles provisionales en RAM y Firestore eliminando falsas detecciones del personal y huérfanos
 * @param {Object} options
 * @param {Object} options.customerService
 * @param {Object} [options.db]
 * @param {Map} [options.activeSessions]
 * @param {number} [options.staffThreshold]
 * @param {number} [options.emptyChairTimeoutMs=30000]
 * @param {number} [options.now=Date.now()]
 * @param {Function} [options.logVerbal=console.log]
 * @returns {Promise<number>} Número de perfiles eliminados
 */
export async function reconcileOrphanedProvisionalProfiles({
  customerService,
  db,
  activeSessions = new Map(),
  staffThreshold,
  emptyChairTimeoutMs = 30000,
  now = Date.now(),
  logVerbal = console.log
} = {}) {
  if (!customerService) return 0;

  let deletedCount = 0;
  try {
    const candidates = new Map();

    // Candidatos en memoria RAM
    if (customerService.profilesCache) {
      for (const [id, p] of customerService.profilesCache.entries()) {
        if (p.status === "to_verify" || /^Cliente\s*\(Por verificar\)/i.test(p.name || "")) {
          candidates.set(id, p);
        }
      }
    }

    // Candidatos en Firestore (camera_catcher_people)
    const firestoreInstance = db || customerService?.db;
    if (firestoreInstance && typeof firestoreInstance.collection === "function" && process.env.IS_LOCAL_SIMULATOR !== "true") {
      try {
        const snap = await firestoreInstance.collection("camera_catcher_people").where("status", "==", "to_verify").get();
        if (snap && !snap.empty) {
          snap.forEach(docSnap => {
            const data = docSnap.data();
            const id = docSnap.id || data.id;
            if (id) {
              candidates.set(id, { id, ...data });
            }
          });
        }
      } catch (_) {}
    }

    if (candidates.size === 0) return 0;

    // Obtener perfiles y vectores del Staff / Barbero
    const knownProfiles = customerService.getComparisonProfiles?.() || [];
    const staffProfiles = knownProfiles.filter(p => {
      if (p.name && /^Cliente\s*#\d+/i.test(p.name)) return false;
      if (p.role === "client" || p.isStaff === false) return false;
      return (p.isStaff === true && p.role !== "client") || p.role === "barber" || (String(p.id).startsWith("staff_") && p.role !== "client" && p.isStaff !== false);
    });

    const staffVectors = [];
    for (const staff of staffProfiles) {
      if (Array.isArray(staff.embeddings)) {
        for (const item of staff.embeddings) {
          if (Array.isArray(item)) staffVectors.push(item);
          else if (item && Array.isArray(item.vector)) staffVectors.push(item.vector);
        }
      }
      if (staffVectors.length === 0 && Array.isArray(staff.embedding)) {
        staffVectors.push(staff.embedding);
      }
    }

    // Si no hay vectores en RAM, consultar staff_barbero en Firestore
    if (staffVectors.length === 0 && firestoreInstance && typeof firestoreInstance.doc === "function") {
      try {
        const sDoc = await firestoreInstance.doc("camera_catcher_people/staff_barbero").get();
        if (sDoc && sDoc.exists) {
          const sData = sDoc.data();
          if (Array.isArray(sData.embeddings)) {
            for (const item of sData.embeddings) {
              const v = Array.isArray(item) ? item : item?.vector;
              if (v) staffVectors.push(v);
            }
          }
          if (staffVectors.length === 0 && Array.isArray(sData.embedding)) {
            staffVectors.push(sData.embedding);
          }
        }
      } catch (_) {}
    }

    for (const [candId, cand] of candidates.entries()) {
      const isAttachedToActiveSession = Array.from(activeSessions.values()).some(
        s => s.tempClientId === candId || s.personId === candId || s.clientId === candId
      );

      const staffExclusionThreshold = staffThreshold ?? PIPELINE_CONFIG.staffFilter.staffExclusionThreshold;
      let maxStaffSim = 0;
      let staffMatchesCount = 0;
      let totalEvaluated = 0;

      // Evaluar embeddings existentes
      if (Array.isArray(cand.embeddings) && cand.embeddings.length > 0) {
        for (const item of cand.embeddings) {
          const v = Array.isArray(item) ? item : item?.vector;
          if (v && staffVectors.length > 0) {
            totalEvaluated++;
            let sampleBestSim = 0;
            for (const sv of staffVectors) {
              const sim = computeCosineSimilarity(v, sv);
              if (sim > sampleBestSim) sampleBestSim = sim;
              if (sim > maxStaffSim) maxStaffSim = sim;
            }
            if (sampleBestSim >= staffExclusionThreshold) {
              staffMatchesCount++;
            }
          }
        }
      }

      // Si no tiene embeddings pero tiene fotos, extraer embedding ONNX bajo demanda
      if (totalEvaluated === 0 && Array.isArray(cand.photos) && staffVectors.length > 0) {
        for (const ph of cand.photos) {
          if (ph.thumbnailBase64) {
            try {
              const base64Data = ph.thumbnailBase64.replace(/^data:image\/[a-z]+;base64,/, "");
              const buf = Buffer.from(base64Data, "base64");
              const emb = await extractFaceEmbedding(buf);
              if (emb) {
                totalEvaluated++;
                let sampleBestSim = 0;
                for (const sv of staffVectors) {
                  const sim = computeCosineSimilarity(emb, sv);
                  if (sim > sampleBestSim) sampleBestSim = sim;
                  if (sim > maxStaffSim) maxStaffSim = sim;
                }
                if (sampleBestSim >= staffExclusionThreshold) {
                  staffMatchesCount++;
                }
              }
            } catch (_) {}
          }
        }
      }

      // Exigir que la mayoría (> 50%) de las fotos del perfil pertenezcan al barbero para auto-eliminar el perfil completo
      const isBarberMatch = totalEvaluated > 0 &&
        maxStaffSim >= staffExclusionThreshold &&
        (staffMatchesCount / totalEvaluated) > 0.50;

      if (isBarberMatch) {
        // Descartar cualquier sesión en curso que pertenezca al barbero
        for (const [tId, s] of activeSessions.entries()) {
          if (s.tempClientId === candId || s.personId === candId) {
            activeSessions.delete(tId);
          }
        }
        logVerbal(`🧹 Auto-eliminando perfil "to_verify" (${candId}): Cluster coincide con el Barbero/Staff (similitud: ${maxStaffSim.toFixed(3)} >= ${staffExclusionThreshold.toFixed(2)}, ${staffMatchesCount}/${totalEvaluated} fotos).`, "process");
        await customerService.deleteCustomer(candId, { db: firestoreInstance });
        deletedCount++;
        continue;
      }

      // Si no está en una sesión activa, verificar si fue abandonado
      if (!isAttachedToActiveSession) {
        const lastActivityEpoch = cand.lastSeen ? new Date(cand.lastSeen).getTime() : (cand.firstSeen ? new Date(cand.firstSeen).getTime() : 0);
        const elapsedInactive = now - lastActivityEpoch;

        if (elapsedInactive >= (emptyChairTimeoutMs || 30000)) {
          logVerbal(`🧹 Auto-eliminando perfil "to_verify" huérfano (${candId}): Silla vacía y sin atención activa (${Math.round(elapsedInactive / 1000)}s inactivo).`, "process");
          await customerService.deleteCustomer(candId, { db: firestoreInstance });
          deletedCount++;
        }
      }
    }
  } catch (err) {
    console.warn(`[Appointment] Aviso en reconciliación automática de to_verify:`, err.message);
  }
  return deletedCount;
}
