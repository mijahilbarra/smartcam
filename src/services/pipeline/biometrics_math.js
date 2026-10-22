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
