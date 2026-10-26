import { computeCosineSimilarity } from "../../face_recognizer.js";
import { isVector } from "./appointment_finalizer.js";

/**
 * Compatibilidad anatómica mejorada entre poses
 */
export function arePosesCompatibleEnhanced(poseA, poseB) {
  if (!poseA || !poseB) return true;
  if (poseA === poseB) return true;

  const validSet = new Set(['frontal', 'semi_left', 'semi_right', 'tilted_down', 'tilted_up', 'tilted_down_left', 'tilted_down_right', 'tilted_up_left', 'tilted_up_right']);
  if (!validSet.has(poseA) || !validSet.has(poseB)) return false;

  if (poseA === 'frontal' && ['tilted_down', 'tilted_up', 'semi_left', 'semi_right'].includes(poseB)) return true;
  if (poseB === 'frontal' && ['tilted_down', 'tilted_up', 'semi_left', 'semi_right'].includes(poseA)) return true;
  if (poseA === 'semi_left' && ['frontal', 'tilted_down_left', 'tilted_up_left'].includes(poseB)) return true;
  if (poseA === 'semi_right' && ['frontal', 'tilted_down_right', 'tilted_up_right'].includes(poseB)) return true;
  if (poseB === 'semi_left' && ['frontal', 'tilted_down_left', 'tilted_up_left'].includes(poseA)) return true;
  if (poseB === 'semi_right' && ['frontal', 'tilted_down_right', 'tilted_up_right'].includes(poseA)) return true;
  if (poseA === 'tilted_down' && ['tilted_down_left', 'tilted_down_right'].includes(poseB)) return true;
  if (poseB === 'tilted_down' && ['tilted_down_left', 'tilted_down_right'].includes(poseA)) return true;

  return false;
}

/**
 * Detecta si dos poses corresponden a orientaciones opuestas (izquierda vs derecha)
 * donde la similitud facial esperada cae naturalmente a 0.05 - 0.20 en una misma persona.
 * @param {string} poseA
 * @param {string} poseB
 * @returns {boolean}
 */
export function isOppositeSide(poseA, poseB) {
  if (!poseA || !poseB || typeof poseA !== 'string' || typeof poseB !== 'string') return false;
  const a = poseA.toLowerCase();
  const b = poseB.toLowerCase();

  const isLeftA = a.endsWith('_left') || a.includes('left');
  const isRightA = a.endsWith('_right') || a.includes('right');
  const isLeftB = b.endsWith('_left') || b.includes('left');
  const isRightB = b.endsWith('_right') || b.includes('right');

  return (isLeftA && isRightB) || (isRightA && isLeftB);
}

/**
 * Compensación angular pose-consciente
 */
export function computePoseAwareSimilarity(sim, poseA, poseB) {
  if (!poseA || !poseB || poseA === poseB) return sim;
  if (sim < 0.35) return sim;

  const isPitchShift = (poseA === 'frontal' && (poseB === 'tilted_down' || poseB === 'tilted_up')) ||
                       (poseB === 'frontal' && (poseA === 'tilted_down' || poseA === 'tilted_up')) ||
                       (poseA === 'tilted_down' && (poseB === 'tilted_down_left' || poseB === 'tilted_down_right')) ||
                       (poseB === 'tilted_down' && (poseA === 'tilted_down_left' || poseA === 'tilted_down_right'));
  const isYawShift = (poseA === 'frontal' && (poseB === 'semi_left' || poseB === 'semi_right')) ||
                     (poseB === 'frontal' && (poseA === 'semi_left' || poseA === 'semi_right')) ||
                     (poseA === 'semi_right' && poseB === 'tilted_down_right') ||
                     (poseB === 'semi_right' && poseA === 'tilted_down_right') ||
                     (poseA === 'semi_left' && poseB === 'tilted_down_left') ||
                     (poseB === 'semi_left' && poseA === 'tilted_down_left');
  const isOppositeYaw = (poseA.includes('left') && poseB.includes('right')) ||
                        (poseA.includes('right') && poseB.includes('left'));

  let boost = 0;
  if (isPitchShift && sim >= 0.38) boost = 0.05;
  else if (isYawShift && sim >= 0.38) boost = 0.04;
  else if (isOppositeYaw && sim >= 0.38) boost = 0.05;

  return Math.min(1.0, sim + boost);
}

/**
 * Calcula métricas multi-dimensionales Pose-Aware entre dos conjuntos de embeddings/fotos (Set-to-Set)
 */
export function computeSetToSetMetrics(vecsA = [], photosA = [], vecsB = [], photosB = []) {
  const cleanA = (vecsA || [])
    .map((e, idx) => ({
      vec: isVector(e) ? e : (e?.vector || null),
      pose: photosA?.[idx]?.pose || e?.pose || null
    }))
    .filter(x => x.vec);
  const cleanB = (vecsB || [])
    .map((e, idx) => ({
      vec: isVector(e) ? e : (e?.vector || null),
      pose: photosB?.[idx]?.pose || e?.pose || null
    }))
    .filter(x => x.vec);

  if (cleanA.length === 0 || cleanB.length === 0) {
    return {
      maxSim: -1,
      maxCompatiblePoseSim: -1,
      maxExactPoseSim: -1,
      top3AvgSim: -1,
      medianSim: -1,
      topAvgS: -1
    };
  }

  let maxSim = -1;
  let maxCompatiblePoseSim = -1;
  let maxExactPoseSim = -1;
  const allPairSims = [];
  const sampleBestSimsB = [];

  for (const b of cleanB) {
    let bestForB = -1;
    for (const a of cleanA) {
      const raw = computeCosineSimilarity(b.vec, a.vec);
      const sim = computePoseAwareSimilarity(raw, a.pose, b.pose);
      allPairSims.push(sim);
      if (sim > maxSim) maxSim = sim;
      if (sim > bestForB) bestForB = sim;
      if (a.pose && b.pose) {
        if (arePosesCompatibleEnhanced(a.pose, b.pose) && sim > maxCompatiblePoseSim) {
          maxCompatiblePoseSim = sim;
        }
        if (a.pose === b.pose && sim > maxExactPoseSim) {
          maxExactPoseSim = sim;
        }
      }
    }
    if (bestForB >= 0) sampleBestSimsB.push(bestForB);
  }

  allPairSims.sort((a, b) => b - a);
  const top3Pairs = allPairSims.slice(0, Math.min(3, allPairSims.length));
  const top3AvgSim = top3Pairs.reduce((acc, v) => acc + v, 0) / top3Pairs.length;
  const mid = Math.floor(allPairSims.length / 2);
  const medianSim = allPairSims.length % 2 === 1
    ? allPairSims[mid]
    : (allPairSims[mid - 1] + allPairSims[mid]) / 2;

  sampleBestSimsB.sort((a, b) => b - a);
  const topCount = Math.max(1, Math.ceil(sampleBestSimsB.length * 0.5));
  const topAvgS = sampleBestSimsB.length > 0
    ? sampleBestSimsB.slice(0, topCount).reduce((acc, v) => acc + v, 0) / topCount
    : -1;

  return {
    maxSim,
    maxCompatiblePoseSim: maxCompatiblePoseSim >= 0 ? maxCompatiblePoseSim : maxSim,
    maxExactPoseSim,
    top3AvgSim,
    medianSim,
    topAvgS
  };
}

/**
 * Calcula similitud de un embedding frente al cluster actual de una sesión
 */
export function getClusterSimilarity(embedding, sessionEmbeddings = [], sessionPhotos = [], incomingPose = null) {
  if (!embedding || !Array.isArray(sessionEmbeddings) || sessionEmbeddings.length === 0) {
    return {
      maxSim: 1.0,
      avgSim: 1.0,
      canonicalSim: 1.0,
      anchorMaxSim: 1.0,
      maxCompatibleSim: 1.0,
      maxExactPoseSim: 1.0,
      top3AvgSim: 1.0,
      medianSim: 1.0
    };
  }
  let maxSim = -1;
  let maxCompatibleSim = -1;
  let maxExactPoseSim = -1;
  let totalSim = 0;
  let count = 0;
  let canonicalSim = -1;
  let anchorMaxSim = -1;
  const allSims = [];
  for (let i = 0; i < sessionEmbeddings.length; i++) {
    const v = isVector(sessionEmbeddings[i]) ? sessionEmbeddings[i] : (sessionEmbeddings[i]?.vector || null);
    if (!v) continue;
    const rawSim = computeCosineSimilarity(embedding, v);
    const photoPose = sessionPhotos?.[i]?.pose || null;
    const sim = computePoseAwareSimilarity(rawSim, incomingPose, photoPose);

    allSims.push(sim);
    if (i === 0) canonicalSim = sim;
    if (count < 4 && sim > anchorMaxSim) anchorMaxSim = sim;
    if (sim > maxSim) maxSim = sim;

    if (incomingPose && photoPose) {
      if (arePosesCompatibleEnhanced(incomingPose, photoPose) && sim > maxCompatibleSim) {
        maxCompatibleSim = sim;
      }
      if (incomingPose === photoPose && sim > maxExactPoseSim) {
        maxExactPoseSim = sim;
      }
    }
    totalSim += sim;
    count++;
  }
  if (count === 0) {
    return {
      maxSim: 1.0,
      avgSim: 1.0,
      canonicalSim: 1.0,
      anchorMaxSim: 1.0,
      maxCompatibleSim: 1.0,
      maxExactPoseSim: 1.0,
      top3AvgSim: 1.0,
      medianSim: 1.0
    };
  }
  allSims.sort((a, b) => b - a);
  const topK = allSims.slice(0, Math.min(3, allSims.length));
  const top3AvgSim = topK.reduce((acc, val) => acc + val, 0) / topK.length;
  const mid = Math.floor(allSims.length / 2);
  const medianSim = allSims.length % 2 === 1
    ? allSims[mid]
    : (allSims[mid - 1] + allSims[mid]) / 2;

  return {
    maxSim,
    avgSim: totalSim / count,
    canonicalSim,
    anchorMaxSim,
    maxCompatibleSim: maxCompatibleSim >= 0 ? maxCompatibleSim : maxSim,
    maxExactPoseSim,
    top3AvgSim,
    medianSim
  };
}

/**
 * Calcula la cohesión interna de un subconjunto de vectores (promedio de la mejor similitud de cada elemento con sus pares)
 */
export function computeSubsetCohesion(vecs = []) {
  const clean = (vecs || []).map(e => isVector(e) ? e : (e?.vector || null)).filter(Boolean);
  if (clean.length < 2) return 1.0;
  let sumBest = 0;
  let validCount = 0;
  for (let i = 0; i < clean.length; i++) {
    let bestPeerSim = -1;
    for (let j = 0; j < clean.length; j++) {
      if (i === j) continue;
      const sim = computeCosineSimilarity(clean[i], clean[j]);
      if (sim > bestPeerSim) bestPeerSim = sim;
    }
    if (bestPeerSim >= 0) {
      sumBest += bestPeerSim;
      validCount++;
    }
  }
  return validCount > 0 ? sumBest / validCount : 0;
}

/**
 * Calcula el ratio de contraste entre la similitud del par y la similitud del competidor más cercano en la cohorte
 * @param {number} pairwiseSim - Similitud del par analizado
 * @param {number} maxCohortSim - Máxima similitud con cualquier otro cliente/sesión de la cohorte
 * @param {number} [epsilon=1e-4]
 * @returns {number}
 */
export function computeContrastRatio(pairwiseSim, maxCohortSim, epsilon = 1e-4) {
  return pairwiseSim / (Math.max(0, maxCohortSim) + epsilon);
}

/**
 * Normalización de Cohorte Adaptativa (Adaptive S-Norm) y Ratio de Contraste Biocéntrico.
 *
 * Evalúa si la similitud entre dos sesiones A y B se desvía de forma estadísticamente
 * significativa (Z-score) por encima del fondo de similitudes de la jornada (cohort background),
 * excluyendo sesiones temporalmente contiguas en la misma silla (gap <= 45 min).
 *
 * @param {number} pairwiseSim - Similitud calculada entre sesión A y B
 * @param {number} idxA - Índice de la sesión A
 * @param {number} idxB - Índice de la sesión B
 * @param {Array<Object>} sessions - Lista de sesiones de la jornada (ej. solidAppts)
 * @param {Object} [options={}] - Opciones adicionales (reps, getSimilarity, maxGapMs)
 * @returns {{ sNorm: number, contrastRatio: number, muA: number, sigmaA: number, muB: number, sigmaB: number, maxOtherSim: number }}
 */
export function computeCohortSNorm(pairwiseSim, idxA, idxB, sessions = [], options = {}) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return {
      sNorm: 0,
      contrastRatio: 0,
      muA: 0,
      sigmaA: 0,
      muB: 0,
      sigmaB: 0,
      maxOtherSim: 0
    };
  }

  const reps = options.reps || sessions.map(s => s?.representativeFace || null);
  const getRepSim = options.getSimilarity || ((i, k) => {
    const repI = reps[i]?.vector || (isVector(reps[i]) ? reps[i] : null);
    const repK = reps[k]?.vector || (isVector(reps[k]) ? reps[k] : null);
    if (repI && repK) {
      return computeCosineSimilarity(repI, repK);
    }
    const embI = sessions[i]?.embeddings?.[0]?.vector || sessions[i]?.embeddings?.[0];
    const embK = sessions[k]?.embeddings?.[0]?.vector || sessions[k]?.embeddings?.[0];
    if (embI && embK) {
      return computeCosineSimilarity(embI, embK);
    }
    return 0;
  });

  const isExcludedFromCohort = (targetIdx, otherIdx) => {
    if (otherIdx === idxA || otherIdx === idxB) return true;
    const sTarget = sessions[targetIdx];
    const sOther = sessions[otherIdx];
    if (!sTarget || !sOther) return false;

    // Excluir sesiones en la misma silla con gap <= 45m
    if (sTarget.chairId && sOther.chairId && sTarget.chairId === sOther.chairId) {
      const startT = sTarget.startedAtEpoch || (sTarget.startedAt ? new Date(sTarget.startedAt).getTime() : 0);
      const endT = sTarget.endedAtEpoch || (sTarget.endedAt ? new Date(sTarget.endedAt).getTime() : 0);
      const startO = sOther.startedAtEpoch || (sOther.startedAt ? new Date(sOther.startedAt).getTime() : 0);
      const endO = sOther.endedAtEpoch || (sOther.endedAt ? new Date(sOther.endedAt).getTime() : 0);

      const firstEnd = startT <= startO ? endT : endO;
      const secondStart = startT <= startO ? startO : startT;
      const gapMs = Math.max(0, secondStart - firstEnd);
      if (gapMs <= 45 * 60 * 1000) {
        return true;
      }
    }
    return false;
  };

  const getCohortStats = (targetIdx) => {
    const cohortSims = [];
    for (let k = 0; k < sessions.length; k++) {
      if (isExcludedFromCohort(targetIdx, k)) continue;
      const sim = getRepSim(targetIdx, k);
      if (typeof sim === 'number' && !isNaN(sim)) {
        cohortSims.push(sim);
      }
    }

    if (cohortSims.length === 0) {
      return { mu: 0, sigma: 0.1, maxSim: 0, sims: cohortSims };
    }

    const mu = cohortSims.reduce((acc, v) => acc + v, 0) / cohortSims.length;
    const variance = cohortSims.reduce((acc, v) => acc + Math.pow(v - mu, 2), 0) / cohortSims.length;
    const sigma = Math.sqrt(variance);
    const maxSim = Math.max(...cohortSims);

    return { mu, sigma, maxSim, sims: cohortSims };
  };

  const statsA = getCohortStats(idxA);
  const statsB = getCohortStats(idxB);

  const sNorm = 0.5 * (
    ((pairwiseSim - statsA.mu) / (statsA.sigma + 1e-4)) +
    ((pairwiseSim - statsB.mu) / (statsB.sigma + 1e-4))
  );

  const maxOtherSim = Math.max(statsA.maxSim, statsB.maxSim, 0);
  const maxDenominator = Math.max(statsA.mu + 1.5 * statsA.sigma, statsB.mu + 1.5 * statsB.sigma, maxOtherSim);
  const contrastRatio = pairwiseSim / (maxDenominator + 1e-4);

  return {
    sNorm: Number(sNorm.toFixed(4)),
    contrastRatio: Number(contrastRatio.toFixed(4)),
    muA: Number(statsA.mu.toFixed(4)),
    sigmaA: Number(statsA.sigma.toFixed(4)),
    muB: Number(statsB.mu.toFixed(4)),
    sigmaB: Number(statsB.sigma.toFixed(4)),
    maxOtherSim: Number(maxOtherSim.toFixed(4))
  };
}

