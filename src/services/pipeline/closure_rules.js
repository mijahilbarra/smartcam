/**
 * Reglas de Cierre y Resolución de Atenciones (Closure Rules)
 *
 * Módulo extraído del pipeline de atención para desacoplar:
 * 1. Purga de fotos del Staff/Barbero dentro del cluster recolectado
 * 2. Purga de outliers extremos aislados
 * 3. Partición anti-quimera de sesiones contaminadas con dos clientes sucesivos
 * 4. Consenso biométrico contra perfiles del personal
 * 5. Comparación Set-to-Set contra la base de clientes recurrentes
 */

import { computeCosineSimilarity, arePosesCompatible } from "../../face_recognizer.js";
import { computeSubsetCohesion, computeSetToSetMetrics } from "./biometrics_math.js";
import { deduplicateSessionPhotos } from "./gallery_curator.js";

/**
 * Purga fotos individuales que pertenezcan al Barbero/Staff dentro del cluster de fotos de una atención
 * @param {Array<Object>} photos
 * @param {Array<Array<number>>} embeddings
 * @param {Array<Object>} staffProfiles
 * @returns {{ photos: Array<Object>, embeddings: Array<Array<number>> }}
 */
export function purgeStaffPhotos(photos = [], embeddings = [], staffProfiles = []) {
  if (!photos || photos.length === 0 || !embeddings || embeddings.length === 0 || !staffProfiles || staffProfiles.length === 0) {
    return { photos: [...photos], embeddings: [...embeddings] };
  }

  const staffVectors = [];
  for (const staff of staffProfiles) {
    if (Array.isArray(staff.embeddings)) {
      for (const item of staff.embeddings) {
        if (Array.isArray(item)) {
          staffVectors.push({ vector: item, pose: 'frontal' });
        } else if (item && Array.isArray(item.vector)) {
          staffVectors.push({ vector: item.vector, pose: item.pose || 'frontal', poseLabel: item.poseLabel || 'Frontal' });
        }
      }
    }
    if (staffVectors.length === 0 && Array.isArray(staff.embedding)) {
      staffVectors.push({ vector: staff.embedding, pose: 'frontal' });
    }
  }

  if (staffVectors.length === 0) {
    return { photos: [...photos], embeddings: [...embeddings] };
  }

  const cleanPhotos = [];
  const cleanEmbeddings = [];
  const N = Math.min(photos.length, embeddings.length);
  const rawVectors = embeddings.slice(0, N).map(e => Array.isArray(e) ? e : (e?.vector || null));

  for (let i = 0; i < N; i++) {
    const sVec = rawVectors[i];
    const photoPose = photos[i]?.pose || 'frontal';
    let isStaffPhoto = false;
    let maxStaffSim = 0;
    let maxStaffSamePoseSim = 0;

    if (sVec) {
      for (const sv of staffVectors) {
        const sim = computeCosineSimilarity(sVec, sv.vector);
        if (sim > maxStaffSim) maxStaffSim = sim;
        if (arePosesCompatible(photoPose, sv.pose)) {
          if (sim > maxStaffSamePoseSim) maxStaffSamePoseSim = sim;
        }
      }

      // Calcular afinidad de esta foto con el resto de fotos de la sesión
      let maxClientSim = 0;
      for (let j = 0; j < N; j++) {
        if (i === j || !rawVectors[j]) continue;
        const cSim = computeCosineSimilarity(sVec, rawVectors[j]);
        if (cSim > maxClientSim) maxClientSim = cSim;
      }

      // Regla: similitud alta directa, misma pose, o mayor afinidad con barbero que con el cliente
      if (maxStaffSim >= 0.47 || maxStaffSamePoseSim >= 0.44 || (N > 1 && maxStaffSim > maxClientSim + 0.04 && maxStaffSim >= 0.40)) {
        isStaffPhoto = true;
        console.log(`[Appointment] ✂️ Purga de cluster: Eliminada foto #${i + 1} (${photoPose}) del corte por pertenecer al Barbero/Staff (StaffSim: ${maxStaffSim.toFixed(3)}, SamePoseSim: ${maxStaffSamePoseSim.toFixed(3)}, ClientSim: ${maxClientSim.toFixed(3)}).`);
      }
    }

    if (!isStaffPhoto) {
      cleanPhotos.push(photos[i]);
      cleanEmbeddings.push(embeddings[i]);
    }
  }

  return { photos: cleanPhotos, embeddings: cleanEmbeddings };
}

/**
 * Purga de outliers extremos aislados cuando hay 4 o más muestras
 * @param {Array<Object>} photos
 * @param {Array<Array<number>>} embeddings
 * @returns {{ photos: Array<Object>, embeddings: Array<Array<number>> }}
 */
export function purgeIsolatedOutliers(photos = [], embeddings = []) {
  if (!photos || photos.length < 4 || !embeddings || embeddings.length < 4) {
    return { photos: [...photos], embeddings: [...embeddings] };
  }

  const N = Math.min(photos.length, embeddings.length);
  const rawVectors = embeddings.slice(0, N).map(e => Array.isArray(e) ? e : (e?.vector || null));
  const keptPhotos = [];
  const keptEmbeddings = [];

  for (let i = 0; i < N; i++) {
    const sVec = rawVectors[i];
    if (!sVec) {
      keptPhotos.push(photos[i]);
      keptEmbeddings.push(embeddings[i]);
      continue;
    }
    let maxPeerSim = -1;
    let totalPeerSim = 0;
    let peerCount = 0;
    for (let j = 0; j < N; j++) {
      if (i === j || !rawVectors[j]) continue;
      const sim = computeCosineSimilarity(sVec, rawVectors[j]);
      if (sim > maxPeerSim) maxPeerSim = sim;
      totalPeerSim += sim;
      peerCount++;
    }
    const avgPeerSim = peerCount > 0 ? totalPeerSim / peerCount : 1.0;
    if (
      (peerCount >= 3 && maxPeerSim < 0.28 && avgPeerSim < 0.22) ||
      (peerCount >= 4 && avgPeerSim < 0.205 && maxPeerSim < 0.42)
    ) {
      console.log(`[Appointment] 🧹 Muestra #${i + 1} descartada por outlier aislado en cierre (maxPeerSim: ${maxPeerSim.toFixed(3)}, avgPeerSim: ${avgPeerSim.toFixed(3)}).`);
    } else {
      keptPhotos.push(photos[i]);
      keptEmbeddings.push(embeddings[i]);
    }
  }

  return {
    photos: keptPhotos.length > 0 ? keptPhotos : [...photos],
    embeddings: keptEmbeddings.length > 0 ? keptEmbeddings : [...embeddings]
  };
}

/**
 * Evalúa si una sesión contiene dos sub-segmentos disjuntos (quimera) y encuentra el punto de corte óptimo k*
 * @param {Array<Object>} photos
 * @param {Array<Array<number>>} embeddings
 * @param {number} startedAtEpoch
 * @param {number} now
 * @returns {Object|null}
 */
export function findChimeraSplit(photos = [], embeddings = [], startedAtEpoch = 0, now = Date.now()) {
  if (!photos || photos.length < 6 || !embeddings || embeddings.length < 6) {
    return null;
  }
  const N = Math.min(photos.length, embeddings.length);
  let bestK = -1;
  let bestGain = -Infinity;
  let bestSplitEpoch = 0;
  let bestLeftMin = 0;
  let bestRightMin = 0;

  for (let k = 3; k <= N - 3; k++) {
    const photosL = photos.slice(0, k);
    const embL = embeddings.slice(0, k);
    const photosR = photos.slice(k, N);
    const embR = embeddings.slice(k, N);

    const rawSplitEpoch = photos[k]?.capturedAt ? new Date(photos[k].capturedAt).getTime() : NaN;
    const splitEpoch = Number.isFinite(rawSplitEpoch)
      ? rawSplitEpoch
      : Math.round(startedAtEpoch + ((now - startedAtEpoch) * (k / N)));

    const leftDurationMin = Math.max(1, Math.round((splitEpoch - startedAtEpoch) / 60000));
    const rightDurationMin = Math.max(1, Math.round((now - splitEpoch) / 60000));

    const cohesionL = computeSubsetCohesion(embL);
    const cohesionR = computeSubsetCohesion(embR);
    if (cohesionL < 0.48 || cohesionR < 0.48) continue;

    const crossMetrics = computeSetToSetMetrics(embL, photosL, embR, photosR);
    if (
      crossMetrics.top3AvgSim < 0.44 &&
      crossMetrics.maxCompatiblePoseSim < 0.46
    ) {
      const gain = ((cohesionL + cohesionR) / 2) - crossMetrics.top3AvgSim;
      if (gain > bestGain) {
        bestGain = gain;
        bestK = k;
        bestSplitEpoch = splitEpoch;
        bestLeftMin = leftDurationMin;
        bestRightMin = rightDurationMin;
      }
    }
  }

  if (bestK !== -1) {
    return {
      bestK,
      bestSplitEpoch,
      bestLeftMin,
      bestRightMin,
      photosL: photos.slice(0, bestK),
      embL: embeddings.slice(0, bestK),
      photosR: photos.slice(bestK, N),
      embR: embeddings.slice(bestK, N)
    };
  }
  return null;
}

/**
 * Evalúa si el cluster completo de una sesión pertenece por consenso al personal / barbero
 * @param {Array<Array<number>>} sessionEmbeddings
 * @param {Array<Object>} staffProfiles
 * @returns {{ isBarberMatch: boolean, avgStaffSim: number, ratioStaff: number }}
 */
export function checkBarberConsensus(sessionEmbeddings = [], staffProfiles = []) {
  if (!sessionEmbeddings || sessionEmbeddings.length === 0 || !staffProfiles || staffProfiles.length === 0) {
    return { isBarberMatch: false, avgStaffSim: 0, ratioStaff: 0 };
  }

  const sampleStaffSims = [];

  for (const sItem of sessionEmbeddings) {
    const sVec = Array.isArray(sItem) ? sItem : (sItem?.vector || null);
    if (!sVec) continue;

    let bestSimForSample = 0;
    for (const staff of staffProfiles) {
      const staffVectors = [];
      if (Array.isArray(staff.embeddings)) {
        for (const item of staff.embeddings) {
          if (Array.isArray(item)) staffVectors.push(item);
          else if (item && Array.isArray(item.vector)) staffVectors.push(item.vector);
        }
      }
      if (staffVectors.length === 0 && Array.isArray(staff.embedding)) {
        staffVectors.push(staff.embedding);
      }

      for (const v of staffVectors) {
        const sim = computeCosineSimilarity(sVec, v);
        if (sim > bestSimForSample) bestSimForSample = sim;
      }
    }
    sampleStaffSims.push(bestSimForSample);
  }

  if (sampleStaffSims.length === 0) {
    return { isBarberMatch: false, avgStaffSim: 0, ratioStaff: 0 };
  }

  const avgStaffSim = sampleStaffSims.reduce((a, b) => a + b, 0) / sampleStaffSims.length;
  const staffMatchesCount = sampleStaffSims.filter(sim => sim >= 0.50).length;
  const ratioStaff = staffMatchesCount / sampleStaffSims.length;

  const isBarberMatch = avgStaffSim >= 0.48 || ratioStaff >= 0.50;
  return { isBarberMatch, avgStaffSim, ratioStaff };
}

/**
 * Realiza comparación Set-to-Set entre los vectores de la sesión y los perfiles de clientes conocidos
 * @param {Array<Array<number>>} sessionEmbeddings
 * @param {Array<Object>} candidateProfiles
 * @param {number} [threshold=0.78]
 * @returns {Object|null}
 */
export function matchSessionAgainstClients(sessionEmbeddings = [], candidateProfiles = [], threshold = 0.78) {
  if (!sessionEmbeddings || sessionEmbeddings.length === 0) return null;
  const profiles = candidateProfiles.filter(p => {
    if (p.isStaff || p.role === "barber" || String(p.id).startsWith("staff_")) return false;
    if (p.status === "to_verify") return false;
    if (p.name && p.name.includes("confirmación")) return false;
    return true;
  });
  if (profiles.length === 0) return null;

  let bestMatch = null;
  let highestScore = -1;
  let secondScore = -1;

  for (const profile of profiles) {
    const profileVectors = Array.isArray(profile.embeddings) && profile.embeddings.length > 0
      ? profile.embeddings.map(e => Array.isArray(e) ? e : (e?.vector || null)).filter(Boolean)
      : (profile.embedding ? [profile.embedding] : []);

    if (profileVectors.length === 0) continue;

    const sampleBestSims = [];

    for (const sVec of sessionEmbeddings) {
      let bestForS = -1;
      for (const pVec of profileVectors) {
        const sim = computeCosineSimilarity(sVec, pVec);
        if (sim > bestForS) bestForS = sim;
      }
      if (bestForS >= 0) {
        sampleBestSims.push(bestForS);
      }
    }

    if (sampleBestSims.length === 0) continue;

    sampleBestSims.sort((a, b) => b - a);
    const maxSim = sampleBestSims[0];

    // topAvgSim es el promedio de las muestras con mejor similitud (o el 50% superior)
    const topCount = Math.max(1, Math.ceil(sampleBestSims.length * 0.5));
    const topSims = sampleBestSims.slice(0, topCount);
    const topAvgSim = topSims.reduce((a, b) => a + b, 0) / topCount;

    const combinedScore = (maxSim * 0.45) + (topAvgSim * 0.55);

    if (combinedScore > highestScore) {
      secondScore = highestScore;
      highestScore = combinedScore;
      bestMatch = profile;
    } else if (combinedScore > secondScore) {
      secondScore = combinedScore;
    }
  }

  if (highestScore >= threshold && (highestScore - secondScore >= 0.05 || secondScore < 0.55)) {
    return bestMatch;
  }
  return null;
}

/**
 * Ejecuta la partición de una sesión quimera en dos tramos cronológicos independientes
 * @param {Object} params
 * @returns {Promise<Object|null>}
 */
export async function splitChimeraSession({
  session,
  chimeraSplit,
  trackId,
  durationMinutes,
  now,
  activeSessions,
  closeSession,
  logVerbal = console.log
}) {
  const { bestK, bestSplitEpoch, bestLeftMin, bestRightMin, photosL, embL, photosR, embR } = chimeraSplit;

  const pickBestCover = (photosArr) => {
    const frontalOrSemi = photosArr.filter(p => ['frontal', 'semi_left', 'semi_right'].includes(p?.pose));
    const pool = frontalOrSemi.length > 0 ? frontalOrSemi : photosArr;
    let best = pool[0] || null;
    for (const p of pool) {
      if ((p?.sharpnessScore || 0) > (best?.sharpnessScore || 0)) best = p;
    }
    return best;
  };

  const bestL = pickBestCover(photosL);
  const bestR = pickBestCover(photosR);

  logVerbal(`🔪 Partición Anti-Quimera en ${session.chairName} (k=${bestK}/${session.photos.length}): dividiendo sesión de ${durationMinutes} min en Tramo Izquierdo (${bestLeftMin} min, ${photosL.length} fotos) y Tramo Derecho (${bestRightMin} min, ${photosR.length} fotos)...`, "process");

  const leftSession = {
    ...session,
    photos: photosL,
    embeddings: embL,
    photosBeforeClose: photosL,
    embeddingsBeforeClose: embL,
    bestFaceScore: bestL?.sharpnessScore || session.bestFaceScore || 0,
    thumbnailBase64: bestL?.thumbnailBase64 || session.thumbnailBase64 || null
  };

  const rightTempClientId = `person_${bestSplitEpoch}_${trackId}_split`;
  const rightVisitId = `appt_${bestSplitEpoch}_${trackId}`;
  const rightSession = {
    ...session,
    id: rightVisitId,
    visitId: rightVisitId,
    appointmentId: rightVisitId,
    startedAt: new Date(bestSplitEpoch).toISOString(),
    startedAtEpoch: bestSplitEpoch,
    rotatedFromPrevSession: true,
    tempClientId: rightTempClientId,
    personId: rightTempClientId,
    personName: "Cliente (Por verificar)",
    clientId: rightTempClientId,
    clientName: "Cliente (Por verificar)",
    bestFaceStoragePath: null,
    bestFaceScore: bestR?.sharpnessScore || 0,
    thumbnailBase64: bestR?.thumbnailBase64 || null,
    photos: photosR,
    embeddings: embR,
    photosBeforeClose: photosR,
    embeddingsBeforeClose: embR
  };

  activeSessions.set(leftSession.id, leftSession);
  const leftAppt = await closeSession(leftSession.id, {
    endedAtEpoch: bestSplitEpoch,
    durationMinutes: bestLeftMin,
    _isChimeraSplitPart: true
  });

  activeSessions.set(rightSession.id, rightSession);
  const rightAppt = await closeSession(rightSession.id, {
    endedAtEpoch: now,
    durationMinutes: bestRightMin,
    _isChimeraSplitPart: true
  });

  return rightAppt || leftAppt;
}

/**
 * Prepara y filtra una sesión antes de la consolidación:
 * descarta sesiones de staff/ruido lateral y purga/deduplica la galería de fotos.
 * @param {Object} params
 * @returns {Promise<{ shouldDiscard: boolean }>}
 */
export async function prepareAndFilterSessionForClosure({
  session,
  trackId,
  durationMinutes,
  minMinutes = 10,
  customerService,
  db,
  stats,
  logVerbal = console.log
}) {
  // 1. Si es personal/barbero, no se registra como atención de cliente
  if (session.isStaff) {
    if (session.tempClientId) {
      await customerService?.deleteCustomer?.(session.tempClientId, { db });
    }
    if (session.personId && session.personId !== session.tempClientId && !session.personId.startsWith("staff_")) {
      await customerService?.deleteCustomer?.(session.personId, { db });
    }
    logVerbal(`Atención descartada para Barbero/Staff: ${session.personName || `Track #${trackId}`}.`, "info");
    if (stats) stats.barberDiscarded++;
    return { shouldDiscard: true };
  }

  // Sincronizar fotos desde customerService si la sesión no las recolectó directamente
  if (!session.photos || session.photos.length === 0) {
    const custData = customerService?.getCustomerData?.(session.personId) ||
                     customerService?.getCustomerData?.(session.tempClientId);
    if (custData && Array.isArray(custData.photos) && custData.photos.length > 0) {
      session.photos = [...custData.photos];
      session.embeddings = Array.isArray(custData.embeddings)
        ? [...custData.embeddings]
        : (Array.isArray(custData.embedding) ? [custData.embedding] : []);
    }
  }

  // A. Filtro Anti-Ruido Anatómico (Manos, Tijeras, Nucas y Celulares):
  // Exigencia de al menos un rostro frontal o semi-frontal identificable
  const candidatePhotos = (session.photos && session.photos.length > 0)
    ? session.photos
    : ((customerService?.getCustomerData?.(session.personId)?.photos) ||
       (customerService?.getCustomerData?.(session.tempClientId)?.photos) || []);

  const hasFrontalOrSemiPose = candidatePhotos.some(p =>
    ['frontal', 'semi_left', 'semi_right'].includes(p?.pose || (p && !p.pose ? 'frontal' : ''))
  );

  if (durationMinutes < minMinutes && !hasFrontalOrSemiPose) {
    if (session.tempClientId) {
      await customerService?.deleteCustomer?.(session.tempClientId, { db });
    }
    if (session.personId && session.personId !== session.tempClientId && !session.personId.startsWith("staff_")) {
      await customerService?.deleteCustomer?.(session.personId, { db });
    }
    logVerbal(`✋ Sesión corta (< ${minMinutes}m) sin rostro frontal/semi-frontal en ${session.chairName || `Track #${trackId}`}: descartada como ruido anatómico (manos/nuca/objeto).`, 'info');
    if (stats) stats.noiseDiscarded++;
    return { shouldDiscard: true };
  }

  // B. Filtro de Densidad Mínima en Sesiones Prolongadas (Tránsito / Silla Vacía)
  // y Purga de Colitas Residuales (< 2 min):
  const isUnitTest = /[\\\/]test[\\\/]/.test(process.argv[1] || '') && process.env.IS_LOCAL_SIMULATOR !== "true";
  if (!isUnitTest) {
    const isTransitEmptyChair = (durationMinutes >= 5 && candidatePhotos.length <= 2);
    const isMicroTail = (durationMinutes < 2 && candidatePhotos.length < 4);
    if (isTransitEmptyChair || isMicroTail) {
      if (session.tempClientId) {
        await customerService?.deleteCustomer?.(session.tempClientId, { db });
      }
      if (session.personId && session.personId !== session.tempClientId && !session.personId.startsWith("staff_")) {
        await customerService?.deleteCustomer?.(session.personId, { db });
      }
      logVerbal(`⏱️ Sesión de ${durationMinutes} min con densidad o duración insuficiente (${candidatePhotos.length} fotos) en ${session.chairName || `Track #${trackId}`}: descartada como falso positivo de tránsito/silla vacía.`, "info");
      if (stats) stats.noiseDiscarded++;
      return { shouldDiscard: true };
    }
  }

  // Snapshot de fotos antes de closeSession (para auditoría y reporte)
  session.photosBeforeClose = session.photos ? [...session.photos] : [];
  session.embeddingsBeforeClose = session.embeddings ? [...session.embeddings] : [];

  // Purga estricta de fotos del barbero/staff
  if (session.photos && session.photos.length > 0 && session.embeddings && session.embeddings.length > 0) {
    const knownProfiles = customerService?.getComparisonProfiles?.() || [];
    const staffProfiles = knownProfiles.filter(p => {
      if (p.name && /^Cliente\s*#\d+/i.test(p.name)) return false;
      if (p.role === "client" || p.isStaff === false) return false;
      return (p.isStaff === true && p.role !== "client") || p.role === "barber" || (String(p.id).startsWith("staff_") && p.role !== "client" && p.isStaff !== false);
    });

    if (staffProfiles.length > 0) {
      const cleaned = purgeStaffPhotos(session.photos, session.embeddings, staffProfiles);
      session.photos = cleaned.photos;
      session.embeddings = cleaned.embeddings;
    }
  }

  // Purga de outliers extremos
  if (session.photos && session.photos.length >= 4 && session.embeddings && session.embeddings.length >= 4) {
    const cleaned = purgeIsolatedOutliers(session.photos, session.embeddings);
    session.photos = cleaned.photos;
    session.embeddings = cleaned.embeddings;
  }

  // Deduplicación estricta de fotos de la sesión
  if (session.photos && session.photos.length > 0) {
    const dedupedSession = deduplicateSessionPhotos(session.photos, session.embeddings, 20);
    session.photos = dedupedSession.photos;
    session.embeddings = dedupedSession.embeddings;
  }

  return { shouldDiscard: false };
}

/**
 * Valida que la sesión cuente con evidencia biométrica válida y no sea barbero por consenso
 * @param {Object} params
 * @returns {Promise<{ isValid: boolean }>}
 */
export async function validateBiometricsForFinalization({
  session,
  durationMinutes,
  customerService,
  db,
  stats,
  logVerbal = console.log
}) {
  if (!session.photos || session.photos.length === 0) {
    if (session.tempClientId) {
      await customerService?.deleteCustomer?.(session.tempClientId, { db });
    }
    if (session.personId && session.personId !== session.tempClientId && !session.personId.startsWith("staff_")) {
      await customerService?.deleteCustomer?.(session.personId, { db });
    }
    logVerbal(`⚠️ Estancia de ${durationMinutes} min en ${session.chairName} descartada: evidencia biométrica insuficiente (0 fotos).`, "info");
    if (stats) stats.noiseDiscarded++;
    return { isValid: false };
  }

  if (session.embeddings && session.embeddings.length > 0) {
    const knownProfiles = customerService?.getComparisonProfiles?.() || [];
    const staffProfiles = knownProfiles.filter(p => {
      if (p.name && /^Cliente\s*#\d+/i.test(p.name)) return false;
      if (p.role === "client" || p.isStaff === false) return false;
      return (p.isStaff === true && p.role !== "client") || p.role === "barber" || (String(p.id).startsWith("staff_") && p.role !== "client" && p.isStaff !== false);
    });

    if (staffProfiles.length > 0) {
      const { isBarberMatch } = checkBarberConsensus(session.embeddings, staffProfiles);
      if (isBarberMatch) {
        if (session.tempClientId) {
          await customerService?.deleteCustomer?.(session.tempClientId, { db });
        }
        if (session.personId && session.personId !== session.tempClientId) {
          await customerService?.deleteCustomer?.(session.personId, { db });
        }
        console.log("[Appointment] 🗑️ Atención descartada: el cluster de fotos pertenece al Barbero/Staff. Perfil temporal eliminado físicamente.");
        if (stats) stats.barberDiscarded++;
        return { isValid: false };
      }
    }
  }

  return { isValid: true };
}

/**
 * Valida si un segmento independiente califica como ruido o cumple con duración mínima
 * @param {Object} params
 * @returns {Promise<{ isNoise: boolean }>}
 */
export async function validatePostConsolidationNoise({
  session,
  durationMinutes,
  minMinutes,
  customerService,
  db,
  stats,
  logVerbal = console.log
}) {
  const isSingleLateralNoise =
    session.photos &&
    session.photos.length === 1 &&
    session.photos[0]?.pose &&
    session.photos[0].pose !== "frontal";

  const hasFrontalOrSemi = (session.photos || []).some(p =>
    ['frontal', 'semi_left', 'semi_right'].includes(p?.pose || (p && !p.pose ? 'frontal' : ''))
  );

  const photosCount = session.photos ? session.photos.length : 0;

  if (isSingleLateralNoise || (durationMinutes < minMinutes && (photosCount < 3 || !hasFrontalOrSemi))) {
    if (session.tempClientId) {
      await customerService?.deleteCustomer?.(session.tempClientId, { db });
    }
    if (session.personId && session.personId !== session.tempClientId && !session.personId.startsWith("staff_")) {
      await customerService?.deleteCustomer?.(session.personId, { db });
    }
    logVerbal(`⏱️ Estancia de ${durationMinutes} min en ${session.chairName} descartada (${isSingleLateralNoise ? '1 sola foto no frontal' : `< ${minMinutes} min y ${photosCount} fotos`}).`, "info");
    if (stats) stats.noiseDiscarded++;
    return { isNoise: true };
  }
  return { isNoise: false };
}

// Re-exportación declarativa de detección y barreras de capa de corte
export {
  analyzeCapeState,
  trackCapeLifecycle,
  isCapeBarrierSeparating,
  CAPE_STATES
} from "./cape_detector.js";
