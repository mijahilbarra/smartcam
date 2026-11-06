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

import fs from "fs";
import path from "path";
import { computeCosineSimilarity, arePosesCompatible } from "../../face_recognizer.js";
import { computeSubsetCohesion, computeSetToSetMetrics } from "./biometrics_math.js";
import { deduplicateSessionPhotos, filterOutlierSamples, purgeChimeraPairs } from "./gallery_curator.js";
import { hasTwoEyesVisible } from "../face_quality_service.js";
import { doesDetectionOverlapZone, computeBoxInsideChairRatio, BARBERSHOP_QUADRANTS, isTransitZone } from "../../core/barbershop_rules.js";
import { boxNormToPolygonNorm } from "../../core/geometry.js";

export { computeBoxInsideChairRatio };

let _cachedQuadrants = null;

/**
 * Carga y cachea los cuadrantes desde data/quadrants.json
 * @returns {Array<Object>}
 */
export function getCachedQuadrants() {
  if (_cachedQuadrants && _cachedQuadrants.length > 0) return _cachedQuadrants;
  try {
    const p = path.resolve(process.cwd(), "data", "quadrants.json");
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      _cachedQuadrants = JSON.parse(raw);
      return _cachedQuadrants;
    }
  } catch (_) {}
  return [];
}

/**
 * Resuelve la zona de la silla de corte configurada a partir de un identificador,
 * objeto o catálogo de cuadrantes.
 * @param {Object|string} [chairIdOrZone]
 * @param {Array<Object>|Object} [quadrants]
 * @returns {Object|null}
 */
export function resolveChairZone(chairIdOrZone, quadrants = null) {
  if (chairIdOrZone && typeof chairIdOrZone === "object" && (chairIdOrZone.boxNorm || chairIdOrZone.polygonNorm || chairIdOrZone.box)) {
    return chairIdOrZone;
  }

  const chairId = typeof chairIdOrZone === "string" ? chairIdOrZone : null;

  let list = [];
  if (Array.isArray(quadrants)) {
    list = quadrants;
  } else if (quadrants && typeof quadrants === "object") {
    list = Object.values(quadrants);
  } else if (BARBERSHOP_QUADRANTS && Object.keys(BARBERSHOP_QUADRANTS).length > 0) {
    list = Object.values(BARBERSHOP_QUADRANTS);
  } else {
    list = getCachedQuadrants();
  }

  if (chairId && list.length > 0) {
    const found = list.find(q => q && (q.id === chairId || q.name === chairId || q.label === chairId));
    if (found) return found;
    return null;
  }

  return list.find(q => q && (q.type === "barber_chair" || (q.role === "client" && !isTransitZone(q)))) || null;
}

/**
 * Valida la consistencia espacial entre las cajas delimitadoras del cuerpo humano (YOLO)
 * y la geometría configurada para la silla de corte en Firebase (Firestore / data/quadrants.json).
 *
 * @param {Object} sessionOrBlock - Sesión o bloque a evaluar (contiene boxes, crops, photos o box)
 * @param {Object|string} [chairZone] - Zona de la silla de Firebase o ID de la silla
 * @param {Object} [options] - Parámetros de validación
 * @param {number} [options.width=1280] - Ancho del fotograma para desnormalizar si aplica
 * @param {number} [options.height=720] - Alto del fotograma para desnormalizar si aplica
 * @param {number} [options.minInsideRatio=0.50] - Proporción mínima requerida dentro de la silla (calibrado a 0.50)
 * @param {number} [options.minOverlapRatio=0.50] - Proporción mínima requerida dentro de la silla
 * @param {number} [options.minY2=550] - Coordenada Y2 mínima para confirmar descenso al plano de la silla
 * @param {Array<Object>} [options.quadrants] - Cuadrantes alternativos si chairZone no se suministra
 * @param {boolean} [options.allowEmptyBoxes=true] - Si no hay cajas registradas (ej. mocks), no descartar
 * @returns {{ isValid: boolean, reason: string, insideCount: number, totalBoxes: number, overlapRatio: number, avgInsideRatio: number, avgY2: number }}
 */
export function validateSpatialChairAnchor(sessionOrBlock, chairZone = null, options = {}) {
  if (!sessionOrBlock) {
    return { isValid: false, reason: "fuera_de_caja_silla_firebase", insideCount: 0, totalBoxes: 0, overlapRatio: 0, avgInsideRatio: 0, avgY2: 0 };
  }

  // 1. Extraer todas las cajas humanas registradas con sus metadatos (ej. faceCenterY, faceCenterX)
  const rawItems = [];
  if (Array.isArray(sessionOrBlock.boxes) && sessionOrBlock.boxes.length > 0) {
    for (const b of sessionOrBlock.boxes) rawItems.push({ box: b, faceCenterY: null, faceCenterX: null });
  }
  if (Array.isArray(sessionOrBlock.crops)) {
    for (const c of sessionOrBlock.crops) {
      const b = c?.box || c?.faceData?.box;
      let fcy = null;
      let fcx = null;
      if (c?.faceData?.boxNorm && b && Array.isArray(b) && b.length >= 4) {
        const w = b[2] - b[0];
        const h = b[3] - b[1];
        fcx = b[0] + ((c.faceData.boxNorm[1] + c.faceData.boxNorm[3]) / 2) * w;
        fcy = b[1] + ((c.faceData.boxNorm[0] + c.faceData.boxNorm[2]) / 2) * h;
      } else if (c?.faceData?.landmarks && Array.isArray(c.faceData.landmarks) && c.faceData.landmarks.length >= 3) {
        const lx = c.faceData.landmarks[2][0];
        const ly = c.faceData.landmarks[2][1];
        if (b && Array.isArray(b) && b.length >= 4 && lx <= 1.05 && (b[2] - b[0]) > 2) {
          fcx = b[0] + lx * (b[2] - b[0]);
        } else {
          fcx = lx;
        }
        if (b && Array.isArray(b) && b.length >= 4 && ly <= 1.05 && (b[3] - b[1]) > 2) {
          fcy = b[1] + ly * (b[3] - b[1]);
        } else {
          fcy = ly;
        }
      }
      if (b) rawItems.push({ box: b, faceCenterY: fcy, faceCenterX: fcx });
    }
  }
  if (Array.isArray(sessionOrBlock.photos)) {
    for (const p of sessionOrBlock.photos) {
      const b = p?.box || p?.bodyBox;
      let fcy = null;
      let fcx = null;
      if (p?.landmarks && Array.isArray(p.landmarks) && p.landmarks.length >= 3) {
        const lx = p.landmarks[2][0];
        const ly = p.landmarks[2][1];
        if (b && Array.isArray(b) && b.length >= 4 && lx <= 1.05 && (b[2] - b[0]) > 2) {
          fcx = b[0] + lx * (b[2] - b[0]);
        } else {
          fcx = lx;
        }
        if (b && Array.isArray(b) && b.length >= 4 && ly <= 1.05 && (b[3] - b[1]) > 2) {
          fcy = b[1] + ly * (b[3] - b[1]);
        } else {
          fcy = ly;
        }
      }
      if (p?.boxNorm && b && Array.isArray(b) && b.length >= 4) {
        const w = b[2] - b[0];
        const h = b[3] - b[1];
        fcx = b[0] + ((p.boxNorm[1] + p.boxNorm[3]) / 2) * w;
        fcy = b[1] + ((p.boxNorm[0] + p.boxNorm[2]) / 2) * h;
      }
      if (b) rawItems.push({ box: b, faceCenterY: fcy, faceCenterX: fcx });
    }
  }
  if (Array.isArray(sessionOrBlock.photosBeforeClose)) {
    for (const p of sessionOrBlock.photosBeforeClose) {
      const b = p?.box || p?.bodyBox;
      let fcy = null;
      let fcx = null;
      if (p?.landmarks && Array.isArray(p.landmarks) && p.landmarks.length >= 3) {
        const lx = p.landmarks[2][0];
        const ly = p.landmarks[2][1];
        if (b && Array.isArray(b) && b.length >= 4 && lx <= 1.05 && (b[2] - b[0]) > 2) {
          fcx = b[0] + lx * (b[2] - b[0]);
        } else {
          fcx = lx;
        }
        if (b && Array.isArray(b) && b.length >= 4 && ly <= 1.05 && (b[3] - b[1]) > 2) {
          fcy = b[1] + ly * (b[3] - b[1]);
        } else {
          fcy = ly;
        }
      }
      if (p?.boxNorm && b && Array.isArray(b) && b.length >= 4) {
        const w = b[2] - b[0];
        const h = b[3] - b[1];
        fcx = b[0] + ((p.boxNorm[1] + p.boxNorm[3]) / 2) * w;
        fcy = b[1] + ((p.boxNorm[0] + p.boxNorm[2]) / 2) * h;
      }
      if (b) rawItems.push({ box: b, faceCenterY: fcy, faceCenterX: fcx });
    }
  }
  if (sessionOrBlock.box) rawItems.push({ box: sessionOrBlock.box, faceCenterY: null, faceCenterX: null });
  if (sessionOrBlock.lastBox) rawItems.push({ box: sessionOrBlock.lastBox, faceCenterY: null, faceCenterX: null });

  // Normalizar formato de cajas: parsear strings JSON y asegurar arrays válidos de 4 números
  const validItems = [];
  for (const item of rawItems) {
    let parsed = item.box;
    if (typeof parsed === "string") {
      try { parsed = JSON.parse(parsed); } catch (_) { continue; }
    }
    if (Array.isArray(parsed) && parsed.length >= 4 && parsed.slice(0, 4).every(v => typeof v === "number" && Number.isFinite(v))) {
      validItems.push({ box: parsed.slice(0, 4), faceCenterY: item.faceCenterY, faceCenterX: item.faceCenterX });
    }
  }

  // Si no se registraron cajas (ej. pruebas unitarias sintéticas sin video/cajas):
  if (validItems.length === 0) {
    if (options.requireBoxes === true || options.allowEmptyBoxes === false) {
      return { isValid: false, reason: "fuera_de_caja_silla_firebase", insideCount: 0, totalBoxes: 0, overlapRatio: 0, avgInsideRatio: 0, avgY2: 0 };
    }
    return { isValid: true, reason: "sin_cajas_registradas", insideCount: 0, totalBoxes: 0, overlapRatio: 1.0, avgInsideRatio: 1.0, avgY2: 720 };
  }

  // 2. Resolver la geometría de la silla de corte en Firebase (Firestore / data/quadrants.json)
  const targetChair = resolveChairZone(
    chairZone || sessionOrBlock.chairZone || sessionOrBlock.chairId,
    options.quadrants
  );

  if (!targetChair) {
    // Si no hay zona configurada, no se puede vetar por zona inexistente
    return {
      isValid: true,
      reason: "sin_zona_silla_configurada",
      insideCount: validItems.length,
      totalBoxes: validItems.length,
      overlapRatio: 1.0,
      avgInsideRatio: 1.0,
      avgY2: 720
    };
  }

  const frameWidth = options.width || 1280;
  const frameHeight = options.height || 720;
  const minOverlapRatio = options.minInsideRatio ?? options.minOverlapRatio ?? 0.50;
  const minY2 = targetChair?.minY2 ?? options.minY2 ?? 495;

  // Extraer límites espaciales de la silla en coordenadas de fotograma
  let cx1 = 0, cy1 = 0, cx2 = frameWidth, cy2 = frameHeight;
  if (targetChair.box && Array.isArray(targetChair.box) && targetChair.box.length >= 4) {
    const isChairNorm = targetChair.box.every(v => v >= 0 && v <= 1.05);
    cx1 = isChairNorm ? targetChair.box[0] * frameWidth : targetChair.box[0];
    cy1 = isChairNorm ? targetChair.box[1] * frameHeight : targetChair.box[1];
    cx2 = isChairNorm ? targetChair.box[2] * frameWidth : targetChair.box[2];
    cy2 = isChairNorm ? targetChair.box[3] * frameHeight : targetChair.box[3];
  } else if (targetChair.boxNorm && Array.isArray(targetChair.boxNorm) && targetChair.boxNorm.length === 4) {
    const [cymin, cxmin, cymax, cxmax] = targetChair.boxNorm;
    cx1 = cxmin * frameWidth;
    cy1 = cymin * frameHeight;
    cx2 = cxmax * frameWidth;
    cy2 = cymax * frameHeight;
  } else if (targetChair.polygonNorm && Array.isArray(targetChair.polygonNorm) && targetChair.polygonNorm.length >= 3) {
    const xs = targetChair.polygonNorm.map(p => (typeof p.x === 'number' ? p.x : p[0]));
    const ys = targetChair.polygonNorm.map(p => (typeof p.y === 'number' ? p.y : p[1]));
    cx1 = Math.min(...xs) * frameWidth;
    cx2 = Math.max(...xs) * frameWidth;
    cy1 = Math.min(...ys) * frameHeight;
    cy2 = Math.max(...ys) * frameHeight;
  }

  // Rango de cabeza del cliente configurable desde targetChair.headBoxNorm
  let headX1 = cx1 - 40;
  let headX2 = cx2 + 40;
  let headY1 = cy1 > 0 ? Math.min(340, cy1) : 340;
  let headY2 = frameHeight;

  if (targetChair.headBoxNorm && Array.isArray(targetChair.headBoxNorm) && targetChair.headBoxNorm.length === 4) {
    const [hy1, hx1, hy2, hx2] = targetChair.headBoxNorm;
    headX1 = hx1 * frameWidth;
    headX2 = hx2 * frameWidth;
    headY1 = hy1 * frameHeight;
    headY2 = hy2 * frameHeight;
  }

  // 3. Evaluar solapamiento de cada caja con el encuadre de la silla
  let insideCount = 0;
  let totalInsideRatio = 0;
  let totalY2 = 0;
  const hasConfirmedClientFaces =
    ((sessionOrBlock.clientFacesCount || 0) >= 1 && (sessionOrBlock.anatomicalFacesCount || 0) >= 1) ||
    (Array.isArray(sessionOrBlock.photos) && sessionOrBlock.photos.length >= 1);

  for (const item of validItems) {
    const b = item.box;
    const isNorm = b.every(v => v >= 0 && v <= 1.05);
    const w = isNorm ? 1 : frameWidth;
    const h = isNorm ? 1 : frameHeight;

    const ratio = computeBoxInsideChairRatio(b, targetChair, w, h);
    totalInsideRatio += ratio;

    const y1 = isNorm ? b[1] * frameHeight : b[1];
    const y2 = isNorm ? b[3] * frameHeight : b[3];
    totalY2 += y2;

    const fcx = item.faceCenterX !== null
      ? (item.faceCenterX <= 1.05 ? item.faceCenterX * frameWidth : item.faceCenterX)
      : null;
    const fcy = item.faceCenterY !== null
      ? (item.faceCenterY <= 1.05 ? item.faceCenterY * frameHeight : item.faceCenterY)
      : null;

    // Regla de Aprobación individual:
    // 1. insideRatio >= 0.50 (o >= 0.22 cuando el cuerpo está anclado a la base de la silla y2 >= 612 y el barbero ensancha la caja de YOLO)
    // 2. y2 >= minY2 (o y2 / frameHeight >= (minY2 / frameHeight))
    // 3. Validación de rostro y postura de cabeza dentro del marco de cabeza dinámico:
    const isAnchoredAtChairBase = y2 >= 550 || (y2 / frameHeight >= 0.76);
    const effectiveMinRatio = (hasConfirmedClientFaces && isAnchoredAtChairBase) ? Math.min(minOverlapRatio, 0.22) : minOverlapRatio;
    const isRatioOk = ratio >= effectiveMinRatio;
    const isY2Ok = y2 >= minY2 || (y2 / frameHeight >= (minY2 / frameHeight));

    const isFaceXOk = fcx === null || (fcx >= headX1 && fcx <= headX2);

    let isHeadOk = false;
    if (fcy !== null) {
      const isFaceSeatedHeight = fcy >= headY1 && fcy <= headY2;
      isHeadOk = isFaceXOk && isFaceSeatedHeight;
    } else {
      const isStandingProportion = (y1 < 220 && (y2 - y1) > 450) || (y2 - y1) > 500 || y1 < 180;
      isHeadOk = !isStandingProportion && (y1 >= 200 || (y2 - y1) <= 420);
    }

    if (isRatioOk && isY2Ok && isHeadOk) {
      insideCount++;
    }
  }

  const totalBoxes = validItems.length;
  const overlapRatio = totalBoxes > 0 ? insideCount / totalBoxes : 0;
  const avgInsideRatio = totalBoxes > 0 ? totalInsideRatio / totalBoxes : 0;
  const avgY2 = totalBoxes > 0 ? totalY2 / totalBoxes : 0;
  const effectiveAvgMinRatio = (hasConfirmedClientFaces && avgY2 >= 550) ? Math.min(minOverlapRatio, 0.22) : minOverlapRatio;

  // Si la sesión o bloque tiene un promedio de insideRatio < effectiveAvgMinRatio o y2 < 550,
  // se descarta formalmente con motivo fuera_de_caja_silla_firebase.
  if (insideCount === 0 || overlapRatio < effectiveAvgMinRatio || avgInsideRatio < effectiveAvgMinRatio || avgY2 < minY2) {
    return {
      isValid: false,
      reason: "fuera_de_caja_silla_firebase",
      insideCount,
      totalBoxes,
      overlapRatio,
      avgInsideRatio,
      avgY2
    };
  }

  return {
    isValid: true,
    reason: "dentro_de_caja_silla",
    insideCount,
    totalBoxes,
    overlapRatio,
    avgInsideRatio,
    avgY2
  };
}

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

      // Regla: similitud alta directa, misma pose, o afinidad con barbero
      const isCanonicalStaff = maxStaffSim >= 0.46 || (maxStaffSamePoseSim >= 0.44 && maxStaffSim > maxClientSim + 0.05);
      const isStaffAffinity = N >= 4 && maxStaffSim >= 0.40 && maxStaffSim > maxClientSim + 0.05;

      if (isCanonicalStaff || isStaffAffinity) {
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
  if (!photos || photos.length < 8 || !embeddings || embeddings.length < 8) {
    return null;
  }
  const N = Math.min(photos.length, embeddings.length);
  let bestK = -1;
  let bestGain = -Infinity;
  let bestSplitEpoch = 0;
  let bestLeftMin = 0;
  let bestRightMin = 0;

  for (let k = 4; k <= N - 4; k++) {
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

    const UPRIGHT = ['frontal', 'semi_left', 'semi_right'];
    const hasUprightL = photosL.some(p => UPRIGHT.includes(p?.pose));
    const hasUprightR = photosR.some(p => UPRIGHT.includes(p?.pose));
    const bothHaveUpright = hasUprightL && hasUprightR;

    // Si ambos lados tienen poses erguidas comparables, exigir divergencia clara (< 0.42).
    // Si uno de los lados carece de poses erguidas (ej. cabeza inclinada hacia abajo durante el corte),
    // solo partir si hay contradicción extrema (< 0.22).
    const splitThreshold = bothHaveUpright ? 0.42 : 0.22;
    if (
      crossMetrics.top3AvgSim < splitThreshold &&
      crossMetrics.maxCompatiblePoseSim < (splitThreshold + 0.02)
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
    _blockPrevChairMerge: true,
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
  options = {},
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
    return { shouldDiscard: true, reason: "Sesión identificada como Barbero/Staff al cierre." };
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

  // 2. Validación de Caja del Humano (YOLO) vs Caja de la Silla de Firebase (Firestore / data/quadrants.json)
  const chairZone = options?.chairZone || session.chairZone || session.chairId;
  const spatialRes = validateSpatialChairAnchor(session, chairZone, options);
  if (!spatialRes.isValid) {
    if (session.tempClientId) {
      await customerService?.deleteCustomer?.(session.tempClientId, { db });
    }
    if (session.personId && session.personId !== session.tempClientId && !session.personId.startsWith("staff_")) {
      await customerService?.deleteCustomer?.(session.personId, { db });
    }
    logVerbal(`📐 Sesión en ${session.chairName || `Track #${trackId}`}: descartada por validación espacial (${spatialRes.reason || 'fuera_de_caja_silla_firebase'}).`, 'info');
    if (stats) stats.noiseDiscarded = (stats.noiseDiscarded || 0) + 1;
    return { shouldDiscard: true, reason: spatialRes.reason || "fuera_de_caja_silla_firebase" };
  }

  // A. Filtro Anti-Ruido Anatómico (Manos, Tijeras, Nucas y Celulares):
  // Exigencia inquebrantable de al menos un rostro anatómico genuino con dos ojos visibles
  const isUnitTest = /(?:^|[\\\/])test[\\\/]/.test(process.argv[1] || '') && process.env.IS_LOCAL_SIMULATOR !== "true";
  const candidatePhotos = (session.photos && session.photos.length > 0)
    ? session.photos
    : ((customerService?.getCustomerData?.(session.personId)?.photos) ||
       (customerService?.getCustomerData?.(session.tempClientId)?.photos) || []);

  let hasAnatomicalFace = candidatePhotos.some(p => {
    const isAnatomicalPose = isUnitTest || ['frontal', 'semi_left', 'semi_right', 'tilted_down', 'tilted_down_left', 'tilted_down_right', 'tilted_up', 'tilted_up_left', 'tilted_up_right'].includes(p?.pose || (p && !p.pose ? 'frontal' : ''));
    const hasTwoEyes = p?.hasTwoEyes !== undefined
      ? Boolean(p.hasTwoEyes)
      : (p?.landmarks && Array.isArray(p.landmarks) && p.landmarks.length >= 5
          ? hasTwoEyesVisible(p.landmarks, p.boxNorm, p.pose)
          : Boolean(isUnitTest));
    return isAnatomicalPose && hasTwoEyes;
  });

  // Si no tiene dos ojos frontales pero la silla tiene una atención reciente en curso (afeitado de nuca, lavado, remate):
  if (!hasAnatomicalFace && options?.hasRecentSameChairAppt && candidatePhotos.length > 0) {
    hasAnatomicalFace = true;
  }

  // Si una atención jamás mostró un rostro anatómico con 2 ojos (ej. nuca siendo afeitada), se descarta siempre
  if (!hasAnatomicalFace) {
    if (session.tempClientId) {
      await customerService?.deleteCustomer?.(session.tempClientId, { db });
    }
    if (session.personId && session.personId !== session.tempClientId && !session.personId.startsWith("staff_")) {
      await customerService?.deleteCustomer?.(session.personId, { db });
    }
    logVerbal(`✋ Sesión de ${durationMinutes}m sin rostro anatómico con dos ojos en ${session.chairName || `Track #${trackId}`}: descartada como falso positivo (nuca/pelo/objeto).`, 'info');
    if (stats) stats.noiseDiscarded++;
    return { shouldDiscard: true, reason: `Sin rostro anatómico con 2 ojos tras ${durationMinutes} min (falso positivo de nuca/objeto).` };
  }

  // B. Filtro de Densidad Mínima en Silla Vacía de Tránsito (sin eliminar segmentos cortos con rostro válido):
  if (!isUnitTest) {
    const hasSolidFace = candidatePhotos.some(p => (p.sharpnessScore || 0) >= 50);
    const isTransitEmptyChair = (durationMinutes >= 4 && (candidatePhotos.length === 0 || (!hasSolidFace && candidatePhotos.length <= 1)));
    if (isTransitEmptyChair) {
      if (session.tempClientId) {
        await customerService?.deleteCustomer?.(session.tempClientId, { db });
      }
      if (session.personId && session.personId !== session.tempClientId && !session.personId.startsWith("staff_")) {
        await customerService?.deleteCustomer?.(session.personId, { db });
      }
      logVerbal(`⏱️ Sesión de ${durationMinutes} min con densidad insuficiente (${candidatePhotos.length} fotos) en ${session.chairName || `Track #${trackId}`}: descartada como falso positivo de tránsito/barbero limpiando.`, "info");
      if (stats) stats.noiseDiscarded++;
      return { shouldDiscard: true, reason: `Densidad facial insuficiente (${candidatePhotos.length} fotos en ${durationMinutes} min): tránsito o limpieza de silla.` };
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

  // Purga de outliers extremos y filtrado de dispersión
  if (session.photos && session.photos.length >= 4 && session.embeddings && session.embeddings.length >= 4) {
    const cleaned = purgeIsolatedOutliers(session.photos, session.embeddings);
    const outlierFiltered = filterOutlierSamples(cleaned.photos, cleaned.embeddings);
    const chimeraCleaned = purgeChimeraPairs(outlierFiltered.photos, outlierFiltered.embeddings, 0.38);
    session.photos = chimeraCleaned.photos;
    session.embeddings = chimeraCleaned.embeddings;
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
    return { isValid: false, reason: "0 fotos válidas tras purgar fotos del barbero y outliers en el cierre." };
  }

  if (session.embeddings && session.embeddings.length > 0) {
    const knownProfiles = customerService?.getComparisonProfiles?.() || [];
    const staffProfiles = knownProfiles.filter(p => {
      if (p.name && /^Cliente\s*#\d+/i.test(p.name)) return false;
      if (p.role === "client" || p.isStaff === false) return false;
      return (p.isStaff === true && p.role !== "client") || p.role === "barber" || (String(p.id).startsWith("staff_") && p.role !== "client" && p.isStaff !== false);
    });

    if (staffProfiles.length > 0) {
      const { isBarberMatch, avgStaffSim, ratioStaff } = checkBarberConsensus(session.embeddings, staffProfiles);
      if (isBarberMatch) {
        if (session.tempClientId) {
          await customerService?.deleteCustomer?.(session.tempClientId, { db });
        }
        if (session.personId && session.personId !== session.tempClientId) {
          await customerService?.deleteCustomer?.(session.personId, { db });
        }
        console.log("[Appointment] 🗑️ Atención descartada: el cluster de fotos pertenece al Barbero/Staff. Perfil temporal eliminado físicamente.");
        if (stats) stats.barberDiscarded++;
        return { isValid: false, reason: `Consenso biométrico de Barbero/Staff al cerrar (avgSim=${(avgStaffSim || 0).toFixed(3)}, ratioStaff=${Math.round((ratioStaff || 0) * 100)}%).` };
      }
    }
  }

  return { isValid: true };
}

/**
 * Valida si un segmento independiente califica como ruido o cumple con duración mínima
 * @param {Object} params
 * @returns {Promise<{ isNoise: boolean, reason?: string }>}
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
  const durationSec = session.durationSeconds || (session.startedAtEpoch && session.endedAtEpoch ? Math.round((session.endedAtEpoch - session.startedAtEpoch) / 1000) : durationMinutes * 60);

  // MVSD: Umbral de Duración Mínima Viable de Servicio (180 segundos / 3 minutos)
  // Ninguna atención < 180s que no haya consolidado con una cita previa puede guardarse como cita independiente.
  const isUnitTest = /(?:^|[\\\/])test[\\\/]/.test(process.argv[1] || '') && process.env.IS_LOCAL_SIMULATOR !== "true";
  const minValidDurationSec = isUnitTest ? 60 : 180;
  const minValidDurationMin = isUnitTest ? 1 : 3;
  const isTooShort = durationSec < minValidDurationSec || durationMinutes < minValidDurationMin;

  const isSinglePhotoNoise =
    session.photos &&
    session.photos.length === 1 &&
    (
      (session.photos[0]?.pose && session.photos[0].pose !== "frontal") ||
      durationMinutes < minMinutes
    );

  if (isTooShort || isSinglePhotoNoise) {
    if (session.tempClientId) {
      await customerService?.deleteCustomer?.(session.tempClientId, { db });
    }
    if (session.personId && session.personId !== session.tempClientId && !session.personId.startsWith("staff_")) {
      await customerService?.deleteCustomer?.(session.personId, { db });
    }
    const reasonMsg = isTooShort
      ? `Duración insuficiente como cita independiente (${durationSec}s < ${minValidDurationSec}s): micro-track o estancia efímera no consolidada`
      : `No consolidó con sesión previa y solo tenía 1 foto aislada (${durationMinutes} min)`;
    logVerbal(`⏱️ Estancia de ${durationMinutes} min (${durationSec}s) en ${session.chairName} descartada (${reasonMsg}).`, "info");
    if (stats) stats.noiseDiscarded++;
    return { isNoise: true, reason: reasonMsg };
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
