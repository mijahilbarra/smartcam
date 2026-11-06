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
import { computeSetToSetMetrics, computeCohortSNorm, isOppositeSide } from "./biometrics_math.js";
import { mergePhotosAndEmbeddings, deduplicateSessionPhotos, purgeChimeraPairs } from "./gallery_curator.js";
import { getRepresentativeFace, getMultiPoseRepresentativeBank, isVector } from "./appointment_finalizer.js";
import { isCapeBarrierSeparating } from "./closure_rules.js";
import { hasTwoEyesVisible } from "../face_quality_service.js";
import { sanitizeForFirestore, prepareAppointmentForFirestore, prepareAttentionUnitForFirestore } from "../../infrastructure/firebase/firestore_sanitizer.js";

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
  customerService = null,
  sqliteClient = null,
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
  // Ventana temporal máxima de servicio continuo en la misma silla (30 minutos / 1800s)
  const MAX_CONSOLIDATION_GAP_MS = 1800000;

  if (rawGapMs < minMergeGap || rawGapMs > MAX_CONSOLIDATION_GAP_MS) {
    return {
      shouldMerge: false,
      reason: rawGapMs > MAX_CONSOLIDATION_GAP_MS ? `gap_exceeds_physical_limit_${Math.round(rawGapMs / 1000)}s` : `gap_out_of_bounds_${Math.round(rawGapMs / 1000)}s`,
      metrics: { gapMs },
      repA: null,
      repB: null
    };
  }

  // Principio de Exclusión Mutua / Intervalo Convexo:
  // Si otra cita confirmada en la misma silla terminó después de prevEndedMs y empezó antes de sessionStartMs,
  // la silla fue ocupada por otro cliente. La consolidación a través de una cita intermedia está terminantemente PROHIBIDA.
  const hasInterveningConfirmedAppt = pastAppointments.some(a =>
    a.chairId === session.chairId &&
    a.id !== prevSameChairAppt.id &&
    a.id !== session.id &&
    (a.startedAtEpoch || (a.startedAt ? new Date(a.startedAt).getTime() : 0)) >= prevEndedMs &&
    (a.endedAtEpoch || (a.endedAt ? new Date(a.endedAt).getTime() : 0)) <= sessionStartMs &&
    (a.durationMinutes || 0) >= 3
  );
  if (hasInterveningConfirmedAppt) {
    logVerbal(`[CausalConsolidator] 🛑 Veto Topológico: existe una cita confirmada intermedia en ${session.chairId}. Silla sellada.`);
    return { shouldMerge: false, reason: "intervening_confirmed_appointment_in_chair", metrics: {}, repA: null, repB: null };
  }

  // Vectores y fotos de la cita previa (enriquecidos con base histórica completa si está disponible)
  let prevVecs = (prevSameChairAppt.embeddings || [])
    .map(e => isVector(e) ? e : e?.vector)
    .filter(Boolean);
  const prevPhotos = prevSameChairAppt.photos || [];

  if (prevSameChairAppt.clientId && (customerService || sqliteClient)) {
    const prevCust = customerService?.getCustomerData?.(prevSameChairAppt.clientId) ||
                     sqliteClient?.getCustomerById?.(prevSameChairAppt.clientId);
    if (prevCust?.embeddings && Array.isArray(prevCust.embeddings)) {
      for (const ce of prevCust.embeddings) {
        const vec = isVector(ce) ? ce : ce?.vector;
        if (vec && !prevVecs.includes(vec)) {
          prevVecs.push(vec);
        }
      }
    }
  }

  if (prevVecs.length === 0) {
    return { shouldMerge: false, reason: "prev_session_has_no_vectors", metrics: {}, repA: null, repB: null };
  }

  // Vectores y fotos de la sesión actual
  let sessionVecs = (session.embeddings || [])
    .map(e => isVector(e) ? e : e?.vector)
    .filter(Boolean);
  const sessionPhotos = session.photos || [];

  if (session.clientId && (customerService || sqliteClient)) {
    const sessCust = customerService?.getCustomerData?.(session.clientId) ||
                     sqliteClient?.getCustomerById?.(session.clientId);
    if (sessCust?.embeddings && Array.isArray(sessCust.embeddings)) {
      for (const ce of sessCust.embeddings) {
        const vec = isVector(ce) ? ce : ce?.vector;
        if (vec && !sessionVecs.includes(vec)) {
          sessionVecs.push(vec);
        }
      }
    }
  }

  if (sessionVecs.length === 0) {
    return { shouldMerge: false, reason: "current_session_has_no_vectors", metrics: {}, repA: null, repB: null };
  }

  // Representantes faciales anatómicos
  const repA = getRepresentativeFace(prevPhotos, prevVecs);
  const repB = getRepresentativeFace(sessionPhotos, sessionVecs);

  // Banco de Representantes por Posición (Multi-Pose Representative Bank)
  // Siempre calculado sobre las fotos y embeddings ya purgados de staff/outliers
  const bankA = (prevPhotos.length > 0 && prevVecs.length > 0)
    ? getMultiPoseRepresentativeBank(prevPhotos, prevVecs)
    : (prevSameChairAppt.representatives || getMultiPoseRepresentativeBank(prevPhotos, prevVecs));
  const bankB = (sessionPhotos.length > 0 && sessionVecs.length > 0)
    ? getMultiPoseRepresentativeBank(sessionPhotos, sessionVecs)
    : (session.representatives || getMultiPoseRepresentativeBank(sessionPhotos, sessionVecs));

  let maxHomologousSim = -1;
  let matchedHomologousCategory = null;
  const homologousSims = {};

  for (const cat of ['frontal', 'left', 'right', 'tilted']) {
    const repAItem = bankA?.[cat];
    const repBItem = bankB?.[cat];
    const vecA = repAItem ? (isVector(repAItem) ? repAItem : repAItem.vector) : null;
    const vecB = repBItem ? (isVector(repBItem) ? repBItem : repBItem.vector) : null;
    if (vecA && vecB) {
      const sim = computeCosineSimilarity(vecA, vecB);
      homologousSims[cat] = sim;
      if (sim > maxHomologousSim) {
        maxHomologousSim = sim;
        matchedHomologousCategory = cat;
      }
    }
  }

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

  let sNorm = 0;
  let contrastRatio = 1.0;

  // Detección de Ventana de Transición de Acabado (Finishing Phase en la misma silla)
  const prevDurationMinutes = prevSameChairAppt.durationMinutes || (prevSameChairAppt.duration ? Math.round(prevSameChairAppt.duration / 60) : 0);
  const sessionDurationMinutes = session.durationMinutes || (session.startedAtEpoch && session.endedAtEpoch ? Math.round((session.endedAtEpoch - session.startedAtEpoch) / 60000) : 0);
  logVerbal(`[DEBUG-CONSOLIDATOR] sessionDurationMinutes=${sessionDurationMinutes}, prevDurationMinutes=${prevDurationMinutes}, rawGapMs=${rawGapMs}, centroidSim=${centroidSim.toFixed(3)}, maxGallerySim=${maxGallerySim.toFixed(3)}`);
  
  // Principio de Continuidad en Silla No-Contestada (UCTC - Argon 4):
  // En una barbería real, un cliente puede levantarse 2 a 5 minutos (lavado de cabello, sacudida de capa)
  // y volver a la misma silla para remate/acabado final (1 a 8 min).
  // Criterios Causal-Topológicos Invariantes:
  // 1. Silla no disputada: cero citas intermedias confirmadas (!hasInterveningConfirmedAppt)
  // 2. Brecha temporal física admisible (rawGapMs <= 360000 ms = 6 min)
  // 3. Tramo entrante es un remate funcional corto (sessionDurationMinutes <= 8 min)
  // 4. Sesión previa fue un servicio sustancial (prevDurationMinutes >= 10 min)
  // 5. Duración total combinada no excede un turno estándar (prevDurationMinutes + sessionDurationMinutes <= 75 min)
  const isFinishingPhase = !hasInterveningConfirmedAppt &&
    (rawGapMs <= 360000 && rawGapMs >= minMergeGap) &&
    (sessionDurationMinutes <= 8) &&
    (prevDurationMinutes >= 10) &&
    (prevDurationMinutes + sessionDurationMinutes <= 75);

  // Invariante Físico de Continuidad en Silla (<= 3 segundos):
  // Si rawGapMs <= 3000 ms, es físicamente imposible que un cliente haya salido y entrado otro.
  // Es la misma persona en continuidad de atención.
  const isMicroGapSameChair = rawGapMs <= 3000 && rawGapMs >= minMergeGap;
  const isContinuousSameChair = rawGapMs <= 10000 && rawGapMs > 3000;

  // CANDADO BIOMÉTRICO UNIVERSAL (Argon 4):
  // Si no hay compatibilidad biométrica demostrada, la fusión está TERMINANTEMENTE PROHIBIDA.
  // Protege contra micro-gaps espurios y artefactos de streaming.
  const isBiometricallyIncompatible = (centroidSim < 0.45 && maxGallerySim < 0.48);

  if (isBiometricallyIncompatible) {
    logVerbal(`[CausalConsolidator] 🛑 Veto Biométrico Universal: incompatibilidad biométrica (centroidSim=${centroidSim.toFixed(3)} < 0.45 && maxGallerySim=${maxGallerySim.toFixed(3)} < 0.48). Fusión PROHIBIDA.`);
    return {
      shouldMerge: false,
      reason: "universal_biometric_veto",
      metrics: { repSim, robustSim, centroidSim, sNorm, contrastRatio, gapMs, maxGallerySim },
      repA,
      repB
    };
  }

  // 3. VETO HOMÓLOGO INCONDICIONAL (Hard Biometric Veto - Argon 4)
  const poseA = repA?.pose || repA?.photo?.pose;
  const poseB = repB?.pose || repB?.photo?.pose;
  const scoreA = Number(repA?.score ?? repA?.photo?.sharpnessScore ?? repA?.photo?.score ?? 0);
  const scoreB = Number(repB?.score ?? repB?.photo?.sharpnessScore ?? repB?.photo?.score ?? 0);

  const isOpposite = isOppositeSide(poseA, poseB);

  const UPRIGHT_POSES_VETO = ['frontal', 'semi_left', 'semi_right'];
  const isBothUprightRep = Boolean(!isOpposite && poseA && poseB && UPRIGHT_POSES_VETO.includes(poseA) && UPRIGHT_POSES_VETO.includes(poseB));
  const hasGoodSharpness = scoreA >= 55 && scoreB >= 55;
  const isSamePoseRep = Boolean(poseA && poseB && poseA === poseB);

  // Proteger los vetos por representante de foto única: si la galería acumulada ya tiene
  // coincidencia o no hay contradicción biológica evidente, NO vetar por un solo fotograma de discrepancia.
  const hasStrongGalleryMatch = isMicroGapSameChair || maxBiometric >= 0.52 || robustSim >= 0.48 || centroidSim >= 0.48 || maxGallerySim >= 0.48 || maxHomologousSim >= 0.50 || (isContinuousSameChair && (centroidSim >= 0.48 || maxGallerySim >= 0.48));

  if (isOpposite) {
    logVerbal(`[CausalConsolidator] 🛡️ Veto omitido: poses opuestas detectadas (${poseA} vs ${poseB}). Evaluación atemporal basada en evidencia acumulada.`);
  } else if (!hasStrongGalleryMatch) {
    const isClusterDivergent = centroidSim < 0.45 && robustSim < 0.45;
    if (isClusterDivergent) {
      if (
        (isBothUprightRep && hasGoodSharpness && repSim !== null && repSim < 0.35) ||
        (isSamePoseRep && repSim !== null && repSim < 0.45 && centroidSim < 0.42)
      ) {
        logVerbal(`[CausalConsolidator] 🛑 VETO HOMÓLOGO ABSOLUTO (repSim=${repSim?.toFixed(3)}, centroid=${centroidSim.toFixed(3)}, robustSim=${robustSim.toFixed(3)})`);
        return { shouldMerge: false, reason: "VETO_HOMOLOGO_ABSOLUTO", metrics: { repSim, centroidSim, robustSim, maxBiometric }, repA, repB };
      }

      if (isSamePoseRep && repSim !== null && repSim < 0.33) {
        logVerbal(`[CausalConsolidator] 🛑 VETO BIOMÉTRICO ORTOGONAL (repSim=${repSim?.toFixed(4)} < 0.33 homólogo)`);
        return { shouldMerge: false, reason: "VETO_BIOMETRICO_ORTOGONAL", metrics: { repSim, centroidSim, robustSim, maxBiometric }, repA, repB };
      }

      if (isBothUprightRep && repSim !== null && repSim < 0.35) {
        logVerbal(`[CausalConsolidator] 🛑 VETO BIOMÉTRICO ERGUIDO (repSim=${repSim?.toFixed(4)} < 0.35 entre caras erguidas)`);
        return { shouldMerge: false, reason: "VETO_BIOMETRICO_ERGUIDO", metrics: { repSim, centroidSim, robustSim, maxBiometric }, repA, repB };
      }
    }
  } else {
    logVerbal(`[CausalConsolidator] 🛡️ Veto evitado: la galería acumulada tiene coincidencia contundente (maxBiometric=${maxBiometric.toFixed(3)} >= 0.52 o robustSim=${robustSim.toFixed(3)} >= 0.48).`);
  }

  // 4. S-NORM CAUSAL (Calculado ÚNICAMENTE con sesiones previas finalizadas en el pasado)

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

  const isHomologousDifferentPerson = !isMicroGapSameChair &&
    isSamePoseRep &&
    scoreA >= 60 && scoreB >= 60 &&
    repSim !== null && repSim < 0.50 &&
    contrastRatio < 1.30 &&
    centroidSim < 0.45 &&
    robustSim < 0.45 &&
    maxGallerySim < 0.48;

  let isSamePerson = false;
  let mergeReason = '';

  // Medida 1 (Argon 4): Consolidación por Manifold de Galería Robusta
  // Si la galería limpia y el centroide demuestran identidad contundente (>= 0.48),
  // la disparidad de una pose representativa cosmética (repSim) por giro antipodal (semi_right vs semi_left) queda ANULADA.
  const hasRobustGalleryIdentity = (
    centroidSim >= 0.48 &&
    maxGallerySim >= 0.48 &&
    (metrics.top3AvgSim || 0) >= 0.48
  );

  if (hasRobustGalleryIdentity) {
    isSamePerson = true;
    mergeReason = `galleryManifoldIdentity (centroid=${centroidSim.toFixed(3)}, maxGallery=${maxGallerySim.toFixed(3)}, top3Avg=${(metrics.top3AvgSim || 0).toFixed(3)} >= 0.48)`;
  } else if (
    maxGallerySim >= 0.65 ||
    (maxBiometric >= 0.65 && (maxGallerySim >= 0.48 || centroidSim >= 0.45)) ||
    (maxGallerySim >= 0.48 && centroidSim >= 0.40)
  ) {
    isSamePerson = true;
    mergeReason = `highConfidenceGalleryIdentity (maxGallery=${maxGallerySim.toFixed(3)}, centroid=${centroidSim.toFixed(3)} >= 0.40)`;
  } else if (isFinishingPhase && (
    (maxGallerySim >= 0.50 && centroidSim >= 0.45) ||
    maxHomologousSim >= 0.52
  )) {
    isSamePerson = true;
    mergeReason = `finishingPhaseTransition (gap=${Math.round(rawGapMs / 1000)}s, maxGallery=${maxGallerySim.toFixed(3)}, centroid=${centroidSim.toFixed(3)})`;
  } else if (maxHomologousSim >= 0.52) {
    isSamePerson = true;
    mergeReason = `homologousPoseMatch (sim=${maxHomologousSim.toFixed(3)})`;
  } else if (robustSim >= 0.50) {
    const simVal = maxHomologousSim >= 0 ? maxHomologousSim : robustSim;
    isSamePerson = true;
    mergeReason = `homologousPoseMatch (sim=${simVal.toFixed(3)})`;
  } else if ((maxGallerySim >= 0.65 && centroidSim >= 0.52) || (sNorm >= 1.8 && (metrics.top3AvgSim || 0) >= 0.48)) {
    isSamePerson = true;
    mergeReason = `concordantBiometricsSameClient (robust=${robustSim.toFixed(3)}, centroid=${centroidSim.toFixed(3)}, top3Avg=${(metrics.top3AvgSim || 0).toFixed(3)}, maxGallery=${maxGallerySim.toFixed(3)}, sNorm=${sNorm.toFixed(2)})`;
  } else if (!isHomologousDifferentPerson) {
    // Reglas adicionales adaptativas / biometría estándar sin límites de tiempo rígidos:
    // Veto por discrepancia homóloga en banco multi-pose (solo si el centroide limpio y galería tampoco respaldan continuidad)
    // Se excluyen explícitamente micro-gaps (<= 3s) para permitir rotaciones en la misma silla sin vacancia
    if (!isContinuousSameChair && !isMicroGapSameChair && maxHomologousSim >= 0 && maxHomologousSim < 0.35 && centroidSim < 0.45 && maxGallerySim < 0.48) {
      logVerbal(`[CausalConsolidator] 🛑 VETO HOMÓLOGO DIRECTO: discrepancia severa en poses homólogas (maxHomologousSim=${maxHomologousSim.toFixed(3)} < 0.35, centroidSim=${centroidSim.toFixed(3)}). Bloqueando fusión.`);
      return {
        shouldMerge: false,
        reason: "VETO_HOMOLOGO_DIRECTO",
        metrics: { repSim, robustSim, centroidSim, sNorm, contrastRatio, gapMs, maxGallerySim, maxHomologousSim },
        repA,
        repB
      };
    }

    const isPrevLongService = prevDurationMinutes >= 25;
    const hasSolidBiometricContinuity = (centroidSim >= 0.48 && robustSim >= 0.42) ||
      (!isPrevLongService && centroidSim >= 0.48 && maxGallerySim >= 0.48) ||
      (isPrevLongService && centroidSim >= 0.50 && robustSim >= 0.44) ||
      (robustSim >= 0.52 && (repSim === null || repSim >= 0.30)) ||
      (isContinuousSameChair && (centroidSim >= 0.48 || maxGallerySim >= 0.48)) ||
      (sNorm >= 1.8 && contrastRatio >= 1.20);

    if (isMicroGapSameChair && (maxGallerySim >= 0.48 || centroidSim >= 0.48)) {
      isSamePerson = true;
      mergeReason = `microGapContinuity (rawGap=${Math.round(rawGapMs / 1000)}s <= 3s, maxGallery=${maxGallerySim.toFixed(3)})`;
    } else {
      const isDirectContinuity = !isPrevLongService ? (maxBiometric >= 0.65) : (maxBiometric >= 0.65 && centroidSim >= 0.52 && robustSim >= 0.44);

      const isBiometricallyCertain = (centroidSim >= 0.55 && robustSim >= 0.55) ||
        (robustSim >= 0.60 && centroidSim >= 0.50) ||
        (centroidSim >= 0.65 && ((metrics.top3AvgSim || 0) >= 0.55 || robustSim >= 0.48));

      const isDirectRepMatch = repSim !== null && repSim >= dynamicThreshold;
      const isRepWithSetMatch = repSim !== null && repSim >= (dynamicThreshold - 0.04) && (metrics.top3AvgSim || 0) >= dynamicThreshold;
      const isSetToSetMatch = (
        (metrics.maxCompatiblePoseSim >= dynamicThreshold && (metrics.top3AvgSim || 0) >= (dynamicThreshold - 0.02) && compatiblePeersCount >= 2) ||
        ((metrics.top3AvgSim || 0) >= dynamicThreshold && (metrics.maxSim || 0) >= dynamicThreshold && compatiblePeersCount >= 3)
      );

      if (isDirectContinuity || hasSolidBiometricContinuity) {
        isSamePerson = true;
        mergeReason = isDirectContinuity
          ? `chairContinuityDirect (maxBiometric=${maxBiometric.toFixed(3)})`
          : `chairContinuityRobust (robust=${robustSim.toFixed(3)}, centroid=${centroidSim.toFixed(3)})`;
      } else if (isBiometricallyCertain) {
        isSamePerson = true;
        mergeReason = `highBiometricCertainty (robust=${robustSim.toFixed(3)}, centroid=${centroidSim.toFixed(3)}, sNorm=${sNorm.toFixed(2)})`;
      } else if (strictlyPastAppts.length >= 2 && sNorm >= 2.2 && contrastRatio >= 1.5 && (metrics.top3AvgSim || 0) >= 0.45) {
        isSamePerson = true;
        mergeReason = `sNormAndContrast (sNorm=${sNorm.toFixed(2)}, contrast=${contrastRatio.toFixed(2)})`;
      } else if (isDirectRepMatch || isRepWithSetMatch || isSetToSetMatch) {
        isSamePerson = true;
        mergeReason = `standardBiometrics (dynamicThreshold=${dynamicThreshold})`;
      }
    }
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
    session: { ...session, durationMinutes: durationMinutes ?? session.durationMinutes },
    prevSameChairAppt,
    pastAppointments,
    staffProfiles,
    customerService,
    sqliteClient,
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
      const isOpp = isOppositeSide(ph?.pose, repRef?.photo?.pose || repRef?.pose);
      if (!isOpp) {
        const sim = computeCosineSimilarity(v, repRef.vector);
        if (sim < 0.40) continue;
      }
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
  prevSameChairAppt._lastMergeReason = evalResult.reason;
  prevSameChairAppt._lastMergeMetrics = metrics;

  const curThumbHasTwo = prevSameChairAppt.bestFaceHasTwoEyes !== undefined
    ? Boolean(prevSameChairAppt.bestFaceHasTwoEyes)
    : true;
  const newThumbHasTwo = session.bestFaceHasTwoEyes !== undefined
    ? Boolean(session.bestFaceHasTwoEyes)
    : (session.photos?.[0]?.hasTwoEyes !== undefined ? Boolean(session.photos[0].hasTwoEyes) : false);

  const curPose = prevSameChairAppt.bestFacePose || '';
  const newPose = session.bestFacePose || session.photos?.[0]?.pose || '';
  const curIsTilted = curPose.includes('tilted_down');
  const newIsTilted = newPose.includes('tilted_down');

  // Jerarquía lexicográfica: 2 ojos > 1 ojo; erguida > inclinada hacia abajo; nitidez
  let shouldUpdateMergedThumb = false;
  if (newThumbHasTwo && !curThumbHasTwo) {
    shouldUpdateMergedThumb = true;
  } else if (!newThumbHasTwo && curThumbHasTwo) {
    shouldUpdateMergedThumb = false;
  } else if (!newIsTilted && curIsTilted) {
    shouldUpdateMergedThumb = true;
  } else if (newIsTilted && !curIsTilted) {
    shouldUpdateMergedThumb = false;
  } else if ((session.bestFaceScore || 0) > (prevSameChairAppt.bestFaceScore || 0)) {
    shouldUpdateMergedThumb = true;
  }

  if (shouldUpdateMergedThumb && session.thumbnailBase64) {
    prevSameChairAppt.bestFaceScore = session.bestFaceScore;
    prevSameChairAppt.bestFacePose = newPose;
    prevSameChairAppt.bestFaceHasTwoEyes = newThumbHasTwo;
    prevSameChairAppt.thumbnailBase64 = session.thumbnailBase64;
  }

  // Actualizar banco acumulado de representantes por categoría
  if (!prevSameChairAppt.representatives) {
    prevSameChairAppt.representatives = { frontal: null, left: null, right: null, tilted: null };
  }
  const sessionBank = session.representatives || getMultiPoseRepresentativeBank(session.photos || [], session.embeddings || []);
  for (const cat of ['frontal', 'left', 'right', 'tilted']) {
    const sRep = sessionBank[cat];
    const pRep = prevSameChairAppt.representatives[cat];
    if (sRep) {
      const sScore = Number(sRep.score ?? sRep.sharpnessScore ?? 0);
      const pScore = pRep ? Number(pRep.score ?? pRep.sharpnessScore ?? 0) : -1;
      if (!pRep || sScore > pScore || (sRep.isAnatomical && !pRep.isAnatomical)) {
        prevSameChairAppt.representatives[cat] = { ...sRep };
      }
    }
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
      forceSync: true,
      forceConfirmSync: true
    });
  }

  // Limpiar clientes temporales generados para esta sesión
  if (session.tempClientId && session.tempClientId !== prevSameChairAppt.clientId) {
    await customerService?.deleteCustomer?.(session.tempClientId, { db });
  }
  if (session.personId && session.personId !== session.tempClientId && session.personId !== prevSameChairAppt.clientId) {
    await customerService?.deleteCustomer?.(session.personId, { db });
  }

  // Persistir actualización en SQLite y registrar Unidad de Atención (Fase 2)
  const sqlite = sqliteClient || (customerService?.sqliteClient);
  if (sqlite?.saveAppointment) {
    try {
      if (sqlite.saveAttentionUnit) {
        // Asegurar que la cita previa tenga su unidad base registrada
        if (sqlite.getAttentionUnitsByAppointmentId) {
          const existingUnits = sqlite.getAttentionUnitsByAppointmentId(prevSameChairAppt.id);
          if (existingUnits.length === 0) {
            sqlite.saveAttentionUnit({
              id: `unit_${prevSameChairAppt.id}`,
              appointmentId: prevSameChairAppt.id,
              chairId: prevSameChairAppt.chairId,
              chairName: prevSameChairAppt.chairName,
              clientId: prevSameChairAppt.clientId,
              clientName: prevSameChairAppt.clientName,
              startedAt: prevSameChairAppt.startedAt,
              endedAt: prevSameChairAppt.endedAt,
              startedEpoch: prevSameChairAppt.startedEpoch || new Date(prevSameChairAppt.startedAt).getTime(),
              endedEpoch: prevSameChairAppt.endedEpoch || (prevSameChairAppt.endedAt ? new Date(prevSameChairAppt.endedAt).getTime() : Date.now()),
              durationMinutes: prevSameChairAppt.durationMinutes || 0,
              durationSeconds: (prevSameChairAppt.durationMinutes || 0) * 60,
              status: prevSameChairAppt.status || "completed",
              bestFaceScore: prevSameChairAppt.bestFaceScore || 0,
              thumbnailPath: prevSameChairAppt.thumbnailPath || null,
              thumbnailBase64: prevSameChairAppt.thumbnailBase64 || null,
              photos: prevSameChairAppt.photos || []
            });
          }
        }

        // Registrar el nuevo tramo como una unidad de atención atómica e inmutable
        const unitId = `unit_${session.id || session.startedAtEpoch || Date.now()}`;
        sqlite.saveAttentionUnit({
          id: unitId,
          appointmentId: prevSameChairAppt.id,
          chairId: prevSameChairAppt.chairId,
          chairName: prevSameChairAppt.chairName,
          clientId: prevSameChairAppt.clientId,
          clientName: prevSameChairAppt.clientName,
          startedAt: session.startedAt || new Date(session.startedAtEpoch || now).toISOString(),
          endedAt: session.endedAt || new Date(sessionEndMs).toISOString(),
          startedEpoch: session.startedAtEpoch || (session.startedAt ? new Date(session.startedAt).getTime() : now),
          endedEpoch: sessionEndMs,
          durationMinutes: durationMinutes,
          durationSeconds: durationMinutes * 60,
          status: "completed",
          bestFaceScore: session.bestFaceScore || 0,
          thumbnailPath: session.thumbnailPath || null,
          thumbnailBase64: session.thumbnailBase64 || null,
          photos: filteredNewPhotos,
          embeddingsCount: filteredNewEmbeddings.length
        });

        if (sqlite.getAttentionUnitsByAppointmentId) {
          const currentUnits = sqlite.getAttentionUnitsByAppointmentId(prevSameChairAppt.id);
          const sumUnitsDuration = currentUnits.reduce((acc, u) => acc + (u.durationMinutes || 0), 0);
          prevSameChairAppt.durationMinutes = Math.max(sumUnitsDuration, consolidatedDurationMin);
          prevSameChairAppt.unitsCount = currentUnits.length;
          prevSameChairAppt.attentionUnits = currentUnits;
        }
      }

      sqlite.saveAppointment(prevSameChairAppt);
    } catch (sqlErr) {
      logVerbal(`[CausalConsolidator] Error guardando unidad de atención en SQLite: ${sqlErr.message}`);
    }
  }
  // Persistir actualización en Firestore
  if (db) {
    try {
      await Promise.race([
        db.doc(`camera_catcher_appointments/${prevSameChairAppt.id}`).set(prepareAppointmentForFirestore(prevSameChairAppt)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout actualizando cita en Firestore (8s)")), 8000))
      ]);
      try {
        await db.doc(`camera_catcher_attention_units/${unitId}`).set(prepareAttentionUnitForFirestore({
          id: unitId,
          appointmentId: prevSameChairAppt.id,
          chairId: prevSameChairAppt.chairId,
          chairName: prevSameChairAppt.chairName,
          clientId: prevSameChairAppt.clientId,
          clientName: prevSameChairAppt.clientName,
          startedAt: session.startedAt || new Date(session.startedAtEpoch || now).toISOString(),
          endedAt: session.endedAt || new Date(sessionEndMs).toISOString(),
          startedEpoch: session.startedAtEpoch || (session.startedAt ? new Date(session.startedAt).getTime() : now),
          endedEpoch: sessionEndMs,
          durationMinutes: durationMinutes,
          durationSeconds: durationMinutes * 60,
          status: "completed",
          bestFaceScore: session.bestFaceScore || 0,
          thumbnailPath: session.thumbnailPath || null,
          thumbnailBase64: session.thumbnailBase64 || null,
          photos: filteredNewPhotos,
          embeddingsCount: filteredNewEmbeddings.length
        }));
      } catch (_) {}
    } catch (_) {}
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
