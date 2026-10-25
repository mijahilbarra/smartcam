/**
 * Consolidador Biocéntrico Causal (Capa 13 Incremental al Cierre de Sesión)
 *
 * Elimina completamente el Lookahead Bias al evaluar la fusión de atenciones
 * exclusivamente de manera causal en tiempo real al cerrarse cada sesión:
 * 1. Regla Estricta Causal: Solo evalúa la fusión contra sesiones previas finalizadas en la misma silla (gap <= 45m).
 * 2. Fondo de Cohorte Causal: S-Norm se calcula únicamente con citas previas del pasado (k < actual) o base de clientes.
 * 3. Cirugía Argon 4 Integrada:
 *    - computeCleanCentroid (excluyendo vectores staff >= 0.43).
 *    - computePercentile(cleanSims, 0.85) (robustSim).
 *    - Veto Homólogo Incondicional (repSim < 0.35 entre erguidos, o repSim < 0.45 && centroidSim < 0.42).
 *    - Barrera de Capa (isCapeBarrierSeparating).
 *    - Continuidad robusta en silla y pureza de galería en fusiones.
 */

import { PIPELINE_CONFIG } from "../../core/pipeline_config.js";
import { computeCosineSimilarity } from "../../face_recognizer.js";
import { computeSetToSetMetrics, computeCohortSNorm } from "./biometrics_math.js";
import { mergePhotosAndEmbeddings, deduplicateSessionPhotos, purgeChimeraPairs } from "./gallery_curator.js";
import { getRepresentativeFace, isVector } from "./appointment_finalizer.js";
import { isCapeBarrierSeparating } from "./closure_rules.js";
import { hasTwoEyesVisible } from "../face_quality_service.js";

/**
 * Calcula el percentil p de un array numérico
 * @param {Array<number>} arr
 * @param {number} p - valor entre 0 y 1 (ej. 0.85)
 * @returns {number}
 */
export function computePercentile(arr, p) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx];
}

/**
 * Calcula el centroide limpio de un conjunto de vectores excluyendo muestras coincidentes con personal
 * @param {Array<Array<number>|Object>} vectors
 * @param {Array<Object>} staffProfiles
 * @param {number} [staffThreshold=0.43]
 * @returns {Array<number>|null}
 */
export function computeCleanCentroid(vectors = [], staffProfiles = [], staffThreshold = 0.43) {
  const clean = [];
  for (const v of vectors) {
    const vec = isVector(v) ? v : (v?.vector || null);
    if (!vec) continue;
    let isStaff = false;
    for (const st of staffProfiles) {
      const sVec = isVector(st) ? st : (st?.vector || st?.embedding);
      if (sVec && computeCosineSimilarity(vec, sVec) >= staffThreshold) {
        isStaff = true;
        break;
      }
    }
    if (!isStaff) clean.push(vec);
  }
  if (clean.length === 0) return null;
  const sum = new Array(clean[0].length).fill(0);
  for (const v of clean) {
    for (let k = 0; k < v.length; k++) sum[k] += v[k];
  }
  const norm = Math.sqrt(sum.reduce((acc, val) => acc + val * val, 0));
  return norm > 0 ? sum.map(x => x / norm) : null;
}

/**
 * Calcula similitudes cruzadas par a par entre vecsA y vecsB filtrando duplicados exactos (sim < duplicateThreshold)
 * @param {Array<Array<number>>} vecsA
 * @param {Array<Array<number>>} vecsB
 * @param {number} [duplicateThreshold=0.999]
 * @returns {Array<number>}
 */
export function computeCleanSims(vecsA = [], vecsB = [], duplicateThreshold = 0.999) {
  const cleanSims = [];
  for (const va of vecsA) {
    for (const vb of vecsB) {
      if (!isVector(va) || !isVector(vb)) continue;
      const sim = computeCosineSimilarity(va, vb);
      if (sim < duplicateThreshold) {
        cleanSims.push(sim);
      }
    }
  }
  return cleanSims;
}

/**
 * Evalúa causalmente si una sesión que cierra debe consolidarse con la cita previa en la misma silla
 * @param {Object} params
 * @returns {{ shouldMerge: boolean, reason: string, metrics: Object, repA: Object|null, repB: Object|null }}
 */
export function evaluateCausalConsolidation({
  session,
  prevSameChairAppt,
  pastAppointments = [],
  staffProfiles = [],
  logVerbal = console.log
}) {
  if (
    session._blockPrevChairMerge ||
    !prevSameChairAppt ||
    prevSameChairAppt.chairId !== session.chairId ||
    !session.embeddings ||
    session.embeddings.length === 0
  ) {
    return { shouldMerge: false, reason: "invalid_session_or_different_chair", metrics: {}, repA: null, repB: null };
  }

  // 1. Barrera dura de capa: retiro formal de capa impide fusión de tramos
  if (isCapeBarrierSeparating(prevSameChairAppt, session)) {
    logVerbal(`[CausalConsolidator] 🛑 Consolidación bloqueada por barrera de capa (isCapeBarrierSeparating).`);
    return { shouldMerge: false, reason: "cape_barrier_separated", metrics: {}, repA: null, repB: null };
  }

  // 2. Control temporal causal de la brecha (gap causal)
  const prevEndedMs = prevSameChairAppt.endedAtEpoch || new Date(prevSameChairAppt.endedAt).getTime();
  const sessionStartMs = session.startedAtEpoch || new Date(session.startedAt).getTime();
  const rawGapMs = sessionStartMs - prevEndedMs;
  const gapMs = Math.max(0, rawGapMs);
  const isOverlap = rawGapMs < 0;

  const minMergeGap = PIPELINE_CONFIG.consolidation?.minMergeGapMs ?? -300000;
  const maxMergeGap = 45 * 60 * 1000; // a) Brecha de ausencia causal <= 45 minutos

  if (rawGapMs < minMergeGap || gapMs > maxMergeGap) {
    return { shouldMerge: false, reason: `gap_out_of_bounds_${Math.round(rawGapMs / 1000)}s`, metrics: { gapMs }, repA: null, repB: null };
  }

  // Vectores y fotos de la cita previa
  const prevVecs = (prevSameChairAppt.embeddings || [])
    .map(e => isVector(e) ? e : e?.vector)
    .filter(Boolean);
  const prevPhotos = prevSameChairAppt.photos || [];

  if (prevVecs.length === 0) {
    return { shouldMerge: false, reason: "prev_session_has_no_vectors", metrics: {}, repA: null, repB: null };
  }

  // Vectores y fotos de la sesión actual
  const sessionVecs = (session.embeddings || [])
    .map(e => isVector(e) ? e : e?.vector)
    .filter(Boolean);
  const sessionPhotos = session.photos || [];

  if (sessionVecs.length === 0) {
    return { shouldMerge: false, reason: "current_session_has_no_vectors", metrics: {}, repA: null, repB: null };
  }

  // Representantes faciales anatómicos
  const repA = getRepresentativeFace(prevPhotos, prevVecs);
  const repB = getRepresentativeFace(sessionPhotos, sessionVecs);

  const repSim = (repA?.vector && repB?.vector)
    ? computeCosineSimilarity(repA.vector, repB.vector)
    : null;

  // Centroides limpios sin vectores de personal (staffProfiles)
  const cleanCentroidA = computeCleanCentroid(prevVecs, staffProfiles, 0.43);
  const cleanCentroidB = computeCleanCentroid(sessionVecs, staffProfiles, 0.43);
  const centroidSim = (cleanCentroidA && cleanCentroidB)
    ? computeCosineSimilarity(cleanCentroidA, cleanCentroidB)
    : 0;

  // Similitud robusta (percentil 85 de pares limpios)
  const cleanSims = computeCleanSims(prevVecs, sessionVecs, 0.999);
  const metrics = computeSetToSetMetrics(prevVecs, prevPhotos, sessionVecs, sessionPhotos);
  const robustSim = cleanSims.length >= 3
    ? computePercentile(cleanSims, 0.85)
    : (cleanSims.length > 0 ? computePercentile(cleanSims, 0.85) : (metrics.top3AvgSim < 0.999 ? (metrics.top3AvgSim || 0) : 0));

  const maxBiometric = Math.max(
    metrics.maxSim || 0,
    metrics.maxCompatiblePoseSim || 0,
    repSim !== null ? repSim : 0
  );

  let maxGallerySim = 0;
  for (const va of prevVecs) {
    for (const vb of sessionVecs) {
      const sim = computeCosineSimilarity(va, vb);
      if (sim > maxGallerySim) maxGallerySim = sim;
    }
  }
  if (maxBiometric > maxGallerySim) {
    maxGallerySim = maxBiometric;
  }

  const isBiometricallyIncompatible = (repSim !== null && repSim < 0.30) || centroidSim < 0.40 || maxGallerySim < 0.45;

  // 3. VETO HOMÓLOGO INCONDICIONAL (Hard Biometric Veto - Argon 4)
  const poseA = repA?.pose || repA?.photo?.pose;
  const poseB = repB?.pose || repB?.photo?.pose;
  const scoreA = Number(repA?.score ?? repA?.photo?.sharpnessScore ?? repA?.photo?.score ?? 0);
  const scoreB = Number(repB?.score ?? repB?.photo?.sharpnessScore ?? repB?.photo?.score ?? 0);

  const UPRIGHT_POSES_VETO = ['frontal', 'semi_left', 'semi_right'];
  const isBothUprightRep = Boolean(poseA && poseB && UPRIGHT_POSES_VETO.includes(poseA) && UPRIGHT_POSES_VETO.includes(poseB));
  const hasGoodSharpness = scoreA >= 55 && scoreB >= 55;
  const isSamePoseRep = Boolean(poseA && poseB && poseA === poseB);

  const isOppositeProfiles = (poseA === 'semi_left' && poseB === 'semi_right') ||
                             (poseA === 'semi_right' && poseB === 'semi_left');
  const uprightVetoThreshold = isOppositeProfiles ? 0.22 : 0.35;

  // Proteger los vetos por representante de foto única: si la galería acumulada ya tiene
  // coincidencia contundente (maxBiometric >= 0.52 o robustSim >= 0.48), NO vetar por un solo fotograma de discrepancia.
  const hasStrongGalleryMatch = maxBiometric >= 0.52 || robustSim >= 0.48;

  if (!hasStrongGalleryMatch) {
    const isClusterDivergent = centroidSim < 0.45 && robustSim < 0.45;
    if (isClusterDivergent) {
      if (
        (isBothUprightRep && hasGoodSharpness && repSim !== null && repSim < uprightVetoThreshold) ||
        (isSamePoseRep && repSim !== null && repSim < 0.45 && centroidSim < 0.42)
      ) {
        logVerbal(`[CausalConsolidator] 🛑 VETO HOMÓLOGO ABSOLUTO (repSim=${repSim?.toFixed(3)}, centroid=${centroidSim.toFixed(3)}, robustSim=${robustSim.toFixed(3)})`);
        return { shouldMerge: false, reason: "VETO_HOMOLOGO_ABSOLUTO", metrics: { repSim, centroidSim, robustSim, maxBiometric }, repA, repB };
      }

      if (isSamePoseRep && repSim !== null && repSim < 0.33) {
        logVerbal(`[CausalConsolidator] 🛑 VETO BIOMÉTRICO ORTOGONAL (repSim=${repSim?.toFixed(4)} < 0.33 homólogo)`);
        return { shouldMerge: false, reason: "VETO_BIOMETRICO_ORTOGONAL", metrics: { repSim, centroidSim, robustSim, maxBiometric }, repA, repB };
      }

      if (isBothUprightRep && repSim !== null && repSim < uprightVetoThreshold) {
        logVerbal(`[CausalConsolidator] 🛑 VETO BIOMÉTRICO ERGUIDO (repSim=${repSim?.toFixed(4)} < ${uprightVetoThreshold} entre caras erguidas)`);
        return { shouldMerge: false, reason: "VETO_BIOMETRICO_ERGUIDO", metrics: { repSim, centroidSim, robustSim, maxBiometric }, repA, repB };
      }
    }
  } else {
    logVerbal(`[CausalConsolidator] 🛡️ Veto evitado: la galería acumulada tiene coincidencia contundente (maxBiometric=${maxBiometric.toFixed(3)} >= 0.52 o robustSim=${robustSim.toFixed(3)} >= 0.48).`);
  }

  // 4. S-NORM CAUSAL (Calculado ÚNICAMENTE con sesiones previas finalizadas en el pasado)
  let sNorm = 0;
  let contrastRatio = 1.0;

  // Filtrar estrictamente citas previas del pasado (t_ended <= sessionStartMs)
  const strictlyPastAppts = pastAppointments.filter(a => {
    const aEnd = a.endedAtEpoch || (a.endedAt ? new Date(a.endedAt).getTime() : 0);
    return aEnd <= sessionStartMs && a.id !== session.id && a.id !== session.visitId;
  });

  if (strictlyPastAppts.length >= 2) {
    const cohortSessions = [...strictlyPastAppts, session];
    const idxA = cohortSessions.indexOf(prevSameChairAppt);
    const idxB = cohortSessions.length - 1;

    if (idxA !== -1) {
      const cohortSim = Math.max(
        repSim || 0,
        robustSim || 0,
        metrics.top3AvgSim || 0,
        centroidSim * 0.85
      );
      const cohortReps = cohortSessions.map(s => getRepresentativeFace(s.photos || [], s.embeddings || []));
      const cohort = computeCohortSNorm(cohortSim, idxA, idxB, cohortSessions, { reps: cohortReps });
      sNorm = cohort.sNorm;
      contrastRatio = cohort.contrastRatio;
    }
  }

  let compatiblePeersCount = 0;
  for (const vb of sessionVecs) {
    for (const va of prevVecs) {
      if (computeCosineSimilarity(va, vb) >= 0.45) {
        compatiblePeersCount++;
      }
    }
  }

  const UPRIGHT_POSES = ['frontal', 'semi_left', 'semi_right'];
  const uprightA = prevPhotos.filter(p => UPRIGHT_POSES.includes(p?.pose));
  const uprightB = sessionPhotos.filter(p => UPRIGHT_POSES.includes(p?.pose));
  const hasHomologousUpright = uprightA.length > 0 && uprightB.length > 0;

  const dynamicThreshold = hasHomologousUpright
    ? (process.env.SAME_POSE_THRESHOLD ? parseFloat(process.env.SAME_POSE_THRESHOLD) : 0.58)
    : (process.env.CROSS_POSE_THRESHOLD ? parseFloat(process.env.CROSS_POSE_THRESHOLD) : 0.48);

  const isHomologousDifferentPerson = isSamePoseRep &&
    scoreA >= 60 && scoreB >= 60 &&
    repSim !== null && repSim < 0.50 &&
    contrastRatio < 1.30 &&
    centroidSim < 0.45 &&
    robustSim < 0.45;

  let isSamePerson = false;
  let mergeReason = '';

  if (!isHomologousDifferentPerson && !isBiometricallyIncompatible) {
    // 5. CONTINUIDAD CAUSAL EN SILLA (gap <= 6 min)
    if (gapMs <= 6 * 60 * 1000) {
      const hasSolidBiometricContinuity = (centroidSim >= 0.52 && robustSim >= 0.55) ||
        (robustSim >= 0.62 && (repSim === null || repSim >= 0.40)) ||
        (sNorm >= 2.2 && contrastRatio >= 1.30 && robustSim >= 0.50);

      const isUltraShortMicroPause = gapMs <= 45 * 1000 && (repSim === null || repSim >= 0.38) && centroidSim >= 0.45 && robustSim >= 0.50;

      const isDirectContinuity = maxBiometric >= 0.68;

      if (isDirectContinuity || hasSolidBiometricContinuity || isUltraShortMicroPause) {
        isSamePerson = true;
        mergeReason = isDirectContinuity
          ? `chairContinuityDirect (maxBiometric=${maxBiometric.toFixed(3)}, gap=${(gapMs/1000).toFixed(0)}s)`
          : `chairContinuityRobust (robust=${robustSim.toFixed(3)}, centroid=${centroidSim.toFixed(3)}, gap=${(gapMs/1000).toFixed(0)}s)`;
      }
    }

    // 6. ALTA CONCORDANCIA BIOMÉTRICA ENTRE SESIONES (Gaps mayores hasta 45 min)
    if (!isSamePerson) {
      const isBiometricallyCertain = (centroidSim >= 0.58 && robustSim >= 0.65 && (sNorm >= 1.8 || strictlyPastAppts.length < 2)) ||
        (robustSim >= 0.70 && centroidSim >= 0.54) ||
        (centroidSim >= 0.70 && (metrics.top3AvgSim >= 0.60 || robustSim >= 0.52) && (repSim === null || repSim >= 0.35));

      if (isBiometricallyCertain) {
        isSamePerson = true;
        mergeReason = `highBiometricCertainty (robust=${robustSim.toFixed(3)}, centroid=${centroidSim.toFixed(3)}, sNorm=${sNorm.toFixed(2)})`;
      }
    }

    // 7. S-Norm y Contraste
    if (!isSamePerson) {
      if (strictlyPastAppts.length >= 2) {
        if (sNorm >= 2.5 && contrastRatio >= 1.7 && metrics.top3AvgSim >= 0.48) {
          isSamePerson = true;
          mergeReason = `sNormAndContrast (sNorm=${sNorm.toFixed(2)}, contrast=${contrastRatio.toFixed(2)})`;
        }
      }
    }

    // 8. Biometría estándar para retornos de lavacabezas / micro-transiciones
    if (!isSamePerson) {
      const isDirectRepMatch = repSim !== null && repSim >= dynamicThreshold;
      const isRepWithSetMatch = repSim !== null && repSim >= (dynamicThreshold - 0.04) && metrics.top3AvgSim >= dynamicThreshold;
      const isSetToSetMatch = (
        (metrics.maxCompatiblePoseSim >= dynamicThreshold && metrics.top3AvgSim >= (dynamicThreshold - 0.01) && compatiblePeersCount >= 2 && (repSim === null || repSim >= 0.38) && (gapMs <= 6 * 60 * 1000 || sNorm >= 2.0)) ||
        (metrics.top3AvgSim >= dynamicThreshold && metrics.maxSim >= dynamicThreshold && compatiblePeersCount >= 5 && (repSim === null || repSim >= 0.38) && (gapMs <= 6 * 60 * 1000 || sNorm >= 2.0))
      );
      const isTransitionalChair = (gapMs <= 30000 && (isDirectRepMatch || isSetToSetMatch));
      const weightedSim = Math.max(
        metrics.top3AvgSim || 0,
        metrics.maxCompatiblePoseSim || 0,
        metrics.maxSim || 0,
        repSim || 0
      );
      const isWashbasinReturn = Boolean(
        (contrastRatio >= 1.0) &&
        (
          (repSim !== null && repSim >= dynamicThreshold && (metrics.top3AvgSim >= (dynamicThreshold - 0.03) || centroidSim >= 0.55)) ||
          (metrics.maxCompatiblePoseSim >= dynamicThreshold && metrics.top3AvgSim >= dynamicThreshold && compatiblePeersCount >= 3)
        )
      );

      if (isDirectRepMatch || isRepWithSetMatch || isSetToSetMatch || isTransitionalChair || isWashbasinReturn) {
        isSamePerson = true;
        mergeReason = `standardBiometrics (dynamicThreshold=${dynamicThreshold})`;
      }
    }
  } else if (isBiometricallyIncompatible) {
    logVerbal(`[CausalConsolidator] 🛑 Incompatibilidad biométrica (centroidSim=${centroidSim.toFixed(3)} < 0.40 || repSim=${repSim?.toFixed(3)} < 0.30 || maxGallerySim=${maxGallerySim.toFixed(3)} < 0.45). No se consolida.`);
  }

  return {
    shouldMerge: isSamePerson,
    reason: mergeReason,
    metrics: { repSim, robustSim, centroidSim, sNorm, contrastRatio, gapMs, maxGallerySim },
    repA,
    repB
  };
}

/**
 * Consolida incrementalmente una sesión que cierra contra la atención previa en la misma silla si hay continuidad
 * @param {Object} params
 * @returns {Promise<Object|null>} Retorna la cita previa consolidada si hubo unión, o null si es independiente
 */
export async function consolidateChairAppointment({
  session,
  prevSameChairAppt,
  pastAppointments = [],
  durationMinutes,
  now,
  customerService,
  sqliteClient,
  db,
  bucket,
  logVerbal = console.log,
  stats
}) {
  if (!prevSameChairAppt) return null;

  // Extraer perfiles del personal desde customerService
  const knownProfiles = customerService?.getComparisonProfiles?.() || [];
  const staffProfiles = knownProfiles.filter(p => {
    if (p.name && /^Cliente\s*#\d+/i.test(p.name)) return false;
    if (p.role === "client" || p.isStaff === false) return false;
    return (p.isStaff === true && p.role !== "client") || p.role === "barber" || (String(p.id).startsWith("staff_") && p.role !== "client" && p.isStaff !== false);
  });

  const evalResult = evaluateCausalConsolidation({
    session,
    prevSameChairAppt,
    pastAppointments,
    staffProfiles,
    logVerbal
  });

  if (!evalResult.shouldMerge) {
    return null;
  }

  const { repA, repB, metrics } = evalResult;

  // Pureza de la galería en fusiones (Cirugía Argon 4):
  // Solo ingresan fotos con dos ojos visibles y similitud con el representante >= 0.40
  const repRef = repA?.vector ? repA : repB;
  const filteredNewPhotos = [];
  const filteredNewEmbeddings = [];

  for (let k = 0; k < (session.photos || []).length; k++) {
    const ph = session.photos[k];
    const emb = session.embeddings?.[k] || null;
    const v = isVector(emb) ? emb : (emb?.vector || null);
    const hasTwo = ph?.hasTwoEyes !== undefined
      ? Boolean(ph.hasTwoEyes)
      : hasTwoEyesVisible(ph?.landmarks, ph?.boxNorm, ph?.pose);
    if (!hasTwo) continue;
    if (repRef?.vector && v) {
      const sim = computeCosineSimilarity(v, repRef.vector);
      if (sim < 0.40) continue;
    }
    filteredNewPhotos.push(ph);
    filteredNewEmbeddings.push(emb);
  }

  const prevPhotos = prevSameChairAppt.photos || [];
  const prevVecs = prevSameChairAppt.embeddings || [];

  const merged = mergePhotosAndEmbeddings(
    prevPhotos,
    filteredNewPhotos,
    prevVecs,
    filteredNewEmbeddings
  );
  const deduped = deduplicateSessionPhotos(merged.photos, merged.embeddings, 20);
  const pureMerged = purgeChimeraPairs(deduped.photos, deduped.embeddings, 0.38);

  const prevStartMs = new Date(prevSameChairAppt.startedAt).getTime();
  const sessionEndMs = session.endedAtEpoch || (session.endedAt ? new Date(session.endedAt).getTime() : now);
  const consolidatedDurationMin = Math.max(
    (prevSameChairAppt.durationMinutes || 0) + durationMinutes,
    Math.round((sessionEndMs - prevStartMs) / 60000)
  );

  prevSameChairAppt.endedAt = new Date(sessionEndMs).toISOString();
  prevSameChairAppt.endedAtEpoch = sessionEndMs;
  prevSameChairAppt.durationMinutes = consolidatedDurationMin;
  prevSameChairAppt.photos = pureMerged.photos;
  prevSameChairAppt.embeddings = pureMerged.embeddings;

  if ((session.bestFaceScore || 0) > (prevSameChairAppt.bestFaceScore || 0)) {
    prevSameChairAppt.bestFaceScore = session.bestFaceScore;
    prevSameChairAppt.thumbnailBase64 = session.thumbnailBase64 || prevSameChairAppt.thumbnailBase64;
  }

  // Actualizar perfil del cliente en memoria y persistencia
  const prevClient = customerService?.getCustomerData?.(prevSameChairAppt.clientId) ||
                     sqliteClient?.getCustomerById?.(prevSameChairAppt.clientId);
  if (prevClient) {
    prevClient.lastSeen = new Date(sessionEndMs).toISOString();
    prevClient.photos = deduped.photos;
    prevClient.embeddings = deduped.embeddings;
    prevClient.bestFaceScore = prevSameChairAppt.bestFaceScore;
    await customerService?.saveOrUpdateCustomer?.(prevClient, {
      db,
      bucket,
      galleryUpdated: true,
      forceSync: true
    });
  }

  // Limpiar clientes temporales generados para esta sesión
  if (session.tempClientId && session.tempClientId !== prevSameChairAppt.clientId) {
    await customerService?.deleteCustomer?.(session.tempClientId, { db });
  }
  if (session.personId && session.personId !== session.tempClientId && session.personId !== prevSameChairAppt.clientId) {
    await customerService?.deleteCustomer?.(session.personId, { db });
  }

  // Persistir actualización en SQLite
  const sqlite = sqliteClient || (customerService?.sqliteClient);
  if (sqlite?.saveAppointment) {
    try { sqlite.saveAppointment(prevSameChairAppt); } catch (_) {}
  }
  // Persistir actualización en Firestore
  if (db) {
    try { await db.doc(`camera_catcher_appointments/${prevSameChairAppt.id}`).set(prevSameChairAppt); } catch (_) {}
  }

  // Exportar auditoría fotográfica
  try {
    const fs = await import("fs");
    const path = await import("path");
    const reportDir = path.resolve(process.cwd(), "data/audit_reports");
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
    const combinedBefore = [
      ...(prevSameChairAppt._photosBeforeClose || prevSameChairAppt.photos || []),
      ...(session.photosBeforeClose || [])
    ];
    prevSameChairAppt._photosBeforeClose = combinedBefore;
    const auditPayload = {
      appointmentId: prevSameChairAppt.id,
      clientId: prevSameChairAppt.clientId,
      clientName: prevSameChairAppt.clientName,
      clientStatus: prevSameChairAppt.clientStatus,
      matchedClient: null,
      durationMinutes: prevSameChairAppt.durationMinutes,
      mergeReason: evalResult.reason,
      photosBeforeClose: combinedBefore.map((p, i) => ({
        idx: i + 1,
        pose: p.pose,
        poseLabel: p.poseLabel,
        sharpnessScore: p.sharpnessScore,
        thumbnailBase64: p.thumbnailBase64
      })),
      photosAfterClose: (prevSameChairAppt.photos || []).map((p, i) => ({
        idx: i + 1,
        pose: p.pose,
        poseLabel: p.poseLabel,
        sharpnessScore: p.sharpnessScore,
        thumbnailBase64: p.thumbnailBase64
      }))
    };
    fs.writeFileSync(path.join(reportDir, `audit_${prevSameChairAppt.id}.json`), JSON.stringify(auditPayload, null, 2));
  } catch (_) {}

  logVerbal(`🔗 Tramo de ${durationMinutes} min consolidado en la atención en curso ${prevSameChairAppt.id} (${prevSameChairAppt.clientName}, duración total: ${consolidatedDurationMin} min, brecha: ${Math.round((metrics.gapMs || 0) / 1000)}s, motivo: ${evalResult.reason}).`, "success");
  if (stats) {
    stats.continuousMergesCount = (stats.continuousMergesCount || 0) + 1;
    stats.consolidated = (stats.consolidated || 0) + 1;
  }
  return prevSameChairAppt;
}
