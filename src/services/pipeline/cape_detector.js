/**
 * Detector de Estado y Ciclo de Vida de Capa de Barbería (Cape Detector)
 *
 * Módulo especializado en la detección del uso y retiro de la capa de corte (peignoir/cape):
 * 1. analyzeCapeState: Inspecciona la región del regazo/torso (y: 0.35 - 0.85) usando Sharp
 *    para extraer varianza cromática, desviación estándar y uniformidad textil.
 * 2. trackCapeLifecycle: Administra la máquina de estados de la sesión:
 *    NO_CAPE -> CAPE_ON -> CAPE_ACTIVE -> CAPE_REMOVED.
 * 3. isCapeBarrierSeparating: Actúa como barrera dura física que impide la consolidación
 *    o fusión de dos sesiones distintas si entre ellas ocurrió un retiro formal de capa.
 *
 * Conforme a la Regla de Oro 8 (Agent.md): lógica modular desacoplada de processes.js.
 */

import sharp from "sharp";

export const CAPE_STATES = Object.freeze({
  NO_CAPE: "NO_CAPE",
  CAPE_ON: "CAPE_ON",
  CAPE_ACTIVE: "CAPE_ACTIVE",
  CAPE_REMOVED: "CAPE_REMOVED"
});

/**
 * Analiza el estado de la capa de corte a partir del recorte o imagen completa.
 *
 * @param {Buffer} imageBuffer - Buffer de la imagen (JPEG, PNG o raw)
 * @param {Object|Array|null} [bbox] - Bounding box opcional [x1, y1, x2, y2] o { x, y, width, height }
 * @returns {Promise<{ hasCape: boolean, capeConfidence: number, colorUniformity: number, details: Object }>}
 */
export async function analyzeCapeState(imageBuffer, bbox = null) {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    return {
      hasCape: false,
      capeConfidence: 0,
      colorUniformity: 0,
      details: { error: "invalid_buffer" }
    };
  }

  let metadata;
  try {
    metadata = await sharp(imageBuffer).metadata();
  } catch (err) {
    return {
      hasCape: false,
      capeConfidence: 0,
      colorUniformity: 0,
      details: { error: `sharp_metadata_failed: ${err.message}` }
    };
  }

  const imgWidth = metadata.width || 0;
  const imgHeight = metadata.height || 0;

  if (imgWidth <= 0 || imgHeight <= 0) {
    return {
      hasCape: false,
      capeConfidence: 0,
      colorUniformity: 0,
      details: { error: "invalid_dimensions" }
    };
  }

  // Resolver coordenadas base de la persona
  let baseLeft = 0;
  let baseTop = 0;
  let baseWidth = imgWidth;
  let baseHeight = imgHeight;

  if (Array.isArray(bbox) && bbox.length >= 4) {
    const isNorm = bbox.every(v => typeof v === "number" && v <= 1.0);
    const x1 = isNorm ? bbox[0] * imgWidth : bbox[0];
    const y1 = isNorm ? bbox[1] * imgHeight : bbox[1];
    const x2 = isNorm ? bbox[2] * imgWidth : bbox[2];
    const y2 = isNorm ? bbox[3] * imgHeight : bbox[3];
    baseLeft = Math.min(x1, x2);
    baseTop = Math.min(y1, y2);
    baseWidth = Math.abs(x2 - x1);
    baseHeight = Math.abs(y2 - y1);
  } else if (bbox && typeof bbox === "object") {
    const bLeft = bbox.left ?? bbox.x ?? bbox.xmin ?? 0;
    const bTop = bbox.top ?? bbox.y ?? bbox.ymin ?? 0;
    const bWidth = bbox.width ?? bbox.w ?? (bbox.xmax !== undefined ? bbox.xmax - bLeft : imgWidth);
    const bHeight = bbox.height ?? bbox.h ?? (bbox.ymax !== undefined ? bbox.ymax - bTop : imgHeight);

    const isNorm = (bLeft <= 1.0 && bTop <= 1.0 && bWidth <= 1.0 && bHeight <= 1.0 && bWidth > 0);
    baseLeft = isNorm ? bLeft * imgWidth : bLeft;
    baseTop = isNorm ? bTop * imgHeight : bTop;
    baseWidth = isNorm ? bWidth * imgWidth : bWidth;
    baseHeight = isNorm ? bHeight * imgHeight : bHeight;
  }

  // Recortar región del torso / regazo (y: 0.35 a 0.85 de la persona, x: central 70%)
  const torsoLeft = Math.round(baseLeft + baseWidth * 0.15);
  const torsoTop = Math.round(baseTop + baseHeight * 0.35);
  const torsoWidth = Math.round(baseWidth * 0.70);
  const torsoHeight = Math.round(baseHeight * 0.50);

  const cropLeft = Math.max(0, Math.min(imgWidth - 2, torsoLeft));
  const cropTop = Math.max(0, Math.min(imgHeight - 2, torsoTop));
  const cropWidth = Math.max(2, Math.min(imgWidth - cropLeft, torsoWidth));
  const cropHeight = Math.max(2, Math.min(imgHeight - cropTop, torsoHeight));

  let rawData;
  let rawInfo;
  try {
    const rawResult = await sharp(imageBuffer)
      .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
      .raw()
      .toBuffer({ resolveWithObject: true });
    rawData = rawResult.data;
    rawInfo = rawResult.info;
  } catch (err) {
    return {
      hasCape: false,
      capeConfidence: 0,
      colorUniformity: 0,
      details: { error: `sharp_extract_failed: ${err.message}` }
    };
  }

  const channels = rawInfo.channels || 3;
  const numPixels = rawInfo.width * rawInfo.height;

  if (numPixels <= 0) {
    return {
      hasCape: false,
      capeConfidence: 0,
      colorUniformity: 0,
      details: { error: "zero_pixels_extracted" }
    };
  }

  // 1. Cálculo de medias RGB
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (let i = 0; i < rawData.length; i += channels) {
    sumR += rawData[i];
    sumG += rawData[i + 1];
    sumB += rawData[i + 2];
  }
  const meanR = sumR / numPixels;
  const meanG = sumG / numPixels;
  const meanB = sumB / numPixels;

  // 2. Varianza cromática y uniformidad de píxeles
  let sqDiffR = 0;
  let sqDiffG = 0;
  let sqDiffB = 0;
  let uniformPixels = 0;
  const COLOR_TOLERANCE = 32;

  for (let i = 0; i < rawData.length; i += channels) {
    const dr = rawData[i] - meanR;
    const dg = rawData[i + 1] - meanG;
    const db = rawData[i + 2] - meanB;
    sqDiffR += dr * dr;
    sqDiffG += dg * dg;
    sqDiffB += db * db;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    if (dist <= COLOR_TOLERANCE) {
      uniformPixels++;
    }
  }

  const stdevR = Math.sqrt(sqDiffR / numPixels);
  const stdevG = Math.sqrt(sqDiffG / numPixels);
  const stdevB = Math.sqrt(sqDiffB / numPixels);
  const avgStdev = (stdevR + stdevG + stdevB) / 3;
  const colorVariance = (stdevR * stdevR + stdevG * stdevG + stdevB * stdevB) / 3;
  const uniformRatio = uniformPixels / numPixels;

  // 3. Muestreo de rugosidad de gradiente / textura
  let gradientSum = 0;
  let gradientSamples = 0;
  const w = rawInfo.width;
  const h = rawInfo.height;
  for (let y = 0; y < h - 1; y += 2) {
    for (let x = 0; x < w - 1; x += 2) {
      const idx = (y * w + x) * channels;
      const idxR = (y * w + (x + 1)) * channels;
      const idxD = ((y + 1) * w + x) * channels;
      const dX = Math.abs(rawData[idx] - rawData[idxR]) +
                 Math.abs(rawData[idx + 1] - rawData[idxR + 1]) +
                 Math.abs(rawData[idx + 2] - rawData[idxR + 2]);
      const dY = Math.abs(rawData[idx] - rawData[idxD]) +
                 Math.abs(rawData[idx + 1] - rawData[idxD + 1]) +
                 Math.abs(rawData[idx + 2] - rawData[idxD + 2]);
      gradientSum += (dX + dY) / 6;
      gradientSamples++;
    }
  }
  const gradientScore = gradientSamples > 0 ? (gradientSum / gradientSamples) : 0;

  // 4. Índices sintéticos de Uniformidad y Confianza
  const stdevPenalty = Math.max(0, 1 - (avgStdev / 50));
  const gradientPenalty = Math.max(0, 1 - (gradientScore / 30));
  const colorUniformity = Number(
    Math.max(0, Math.min(1, (uniformRatio * 0.6) + (stdevPenalty * 0.25) + (gradientPenalty * 0.15))).toFixed(3)
  );

  let confidence = 0;
  if (avgStdev > 50) {
    confidence = Math.max(0, 0.3 * (1 - (avgStdev - 50) / 30));
  } else {
    const uniformityScore = Math.max(0, Math.min(1, (colorUniformity - 0.35) / 0.40));
    const stdevScore = Math.max(0, Math.min(1, (45 - avgStdev) / 30));
    confidence = (uniformityScore * 0.65) + (stdevScore * 0.35);
  }
  const capeConfidence = Number(Math.max(0, Math.min(1, confidence)).toFixed(3));
  const hasCape = capeConfidence >= 0.60;

  return {
    hasCape,
    capeConfidence,
    colorUniformity,
    details: {
      avgStdev: Number(avgStdev.toFixed(2)),
      stdevR: Number(stdevR.toFixed(2)),
      stdevG: Number(stdevG.toFixed(2)),
      stdevB: Number(stdevB.toFixed(2)),
      meanR: Number(meanR.toFixed(1)),
      meanG: Number(meanG.toFixed(1)),
      meanB: Number(meanB.toFixed(1)),
      colorVariance: Number(colorVariance.toFixed(1)),
      uniformPixelPercentage: Number((uniformRatio * 100).toFixed(1)),
      gradientScore: Number(gradientScore.toFixed(2)),
      dominantColor: {
        r: Math.round(meanR),
        g: Math.round(meanG),
        b: Math.round(meanB)
      },
      cropBounds: {
        left: cropLeft,
        top: cropTop,
        width: cropWidth,
        height: cropHeight
      }
    }
  };
}

/**
 * Gestiona la máquina de estados del ciclo de vida de la capa para una sesión de atención.
 *
 * Estados: NO_CAPE -> CAPE_ON -> CAPE_ACTIVE -> CAPE_REMOVED
 *
 * @param {Object} session - Objeto de sesión (visit / chair session)
 * @param {Object|string|boolean} currentCapeState - Resultado de analyzeCapeState o estado directo
 * @param {number} [timestampMs] - Timestamp en milisegundos (por defecto Date.now())
 * @returns {{ state: string, hasCapeRemoved: boolean, transitioned: boolean, previousState: string, event: Object|null }}
 */
export function trackCapeLifecycle(session, currentCapeState, timestampMs = Date.now()) {
  if (!session || typeof session !== "object") {
    return {
      state: CAPE_STATES.NO_CAPE,
      hasCapeRemoved: false,
      transitioned: false,
      previousState: CAPE_STATES.NO_CAPE,
      event: null
    };
  }

  // Parsear entrada de estado
  let hasCape = false;
  let confidence = 0.5;

  if (typeof currentCapeState === "boolean") {
    hasCape = currentCapeState;
    confidence = hasCape ? 1.0 : 0.0;
  } else if (typeof currentCapeState === "string") {
    const s = currentCapeState.toUpperCase();
    if (s === CAPE_STATES.CAPE_ON || s === CAPE_STATES.CAPE_ACTIVE) {
      hasCape = true;
      confidence = 1.0;
    } else if (s === CAPE_STATES.CAPE_REMOVED || s === CAPE_STATES.NO_CAPE) {
      hasCape = false;
      confidence = 0.0;
    }
  } else if (currentCapeState && typeof currentCapeState === "object") {
    hasCape = Boolean(currentCapeState.hasCape);
    if (typeof currentCapeState.capeConfidence === "number") {
      confidence = currentCapeState.capeConfidence;
    }
  }

  // Inicializar propiedades en la sesión si no existen
  if (!session.capeState) {
    session.capeState = CAPE_STATES.NO_CAPE;
  }
  if (session.hasCapeRemoved === undefined) {
    session.hasCapeRemoved = false;
  }
  if (!Array.isArray(session.capeHistory)) {
    session.capeHistory = [];
  }
  if (!session.capeStats || typeof session.capeStats !== "object") {
    session.capeStats = {
      consecutiveCapeDetections: 0,
      consecutiveCapeAbsences: 0,
      firstCapeOnAt: null,
      capeActiveAt: null,
      capeRemovedAt: null
    };
  }

  const previousState = session.capeState;
  let transitioned = false;
  let transitionEvent = null;

  switch (previousState) {
    case CAPE_STATES.NO_CAPE: {
      if (hasCape && confidence >= 0.5) {
        session.capeStats.consecutiveCapeDetections++;
        session.capeStats.consecutiveCapeAbsences = 0;
        session.capeState = CAPE_STATES.CAPE_ON;
        session.capeStats.firstCapeOnAt = timestampMs;
        transitioned = true;
        transitionEvent = {
          from: previousState,
          to: session.capeState,
          timestampMs,
          confidence,
          reason: "cape_detected"
        };
      } else {
        session.capeStats.consecutiveCapeAbsences++;
        session.capeStats.consecutiveCapeDetections = 0;
      }
      break;
    }

    case CAPE_STATES.CAPE_ON: {
      if (hasCape) {
        session.capeStats.consecutiveCapeDetections++;
        session.capeStats.consecutiveCapeAbsences = 0;
        const isExplicitActive = currentCapeState === CAPE_STATES.CAPE_ACTIVE || currentCapeState?.state === CAPE_STATES.CAPE_ACTIVE;
        if (session.capeStats.consecutiveCapeDetections >= 2 || isExplicitActive) {
          session.capeState = CAPE_STATES.CAPE_ACTIVE;
          session.capeStats.capeActiveAt = timestampMs;
          transitioned = true;
          transitionEvent = {
            from: previousState,
            to: session.capeState,
            timestampMs,
            confidence,
            reason: "cape_confirmed_active"
          };
        }
      } else {
        session.capeStats.consecutiveCapeAbsences++;
        session.capeStats.consecutiveCapeDetections = 0;
        if (session.capeStats.consecutiveCapeAbsences >= 2 || confidence <= 0.2) {
          session.capeState = CAPE_STATES.CAPE_REMOVED;
          session.hasCapeRemoved = true;
          session.capeStats.capeRemovedAt = timestampMs;
          transitioned = true;
          transitionEvent = {
            from: previousState,
            to: session.capeState,
            timestampMs,
            confidence,
            reason: "cape_removed_from_on"
          };
        }
      }
      break;
    }

    case CAPE_STATES.CAPE_ACTIVE: {
      if (hasCape) {
        session.capeStats.consecutiveCapeDetections++;
        session.capeStats.consecutiveCapeAbsences = 0;
      } else {
        session.capeStats.consecutiveCapeAbsences++;
        session.capeStats.consecutiveCapeDetections = 0;
        if (session.capeStats.consecutiveCapeAbsences >= 2 || (session.capeStats.consecutiveCapeAbsences >= 1 && confidence <= 0.2)) {
          session.capeState = CAPE_STATES.CAPE_REMOVED;
          session.hasCapeRemoved = true;
          session.capeStats.capeRemovedAt = timestampMs;
          transitioned = true;
          transitionEvent = {
            from: previousState,
            to: session.capeState,
            timestampMs,
            confidence,
            reason: "cape_removed_confirmed"
          };
        }
      }
      break;
    }

    case CAPE_STATES.CAPE_REMOVED: {
      session.hasCapeRemoved = true;
      if (hasCape && confidence >= 0.6) {
        session.capeStats.consecutiveCapeDetections++;
        session.capeStats.consecutiveCapeAbsences = 0;
        if (session.capeStats.consecutiveCapeDetections >= 2) {
          session.capeStats.newCapeDetectedAfterRemoval = true;
          transitionEvent = {
            from: previousState,
            to: "NEW_CAPE_AFTER_REMOVED",
            timestampMs,
            confidence,
            reason: "new_client_cape_detected"
          };
        }
      } else {
        session.capeStats.consecutiveCapeAbsences++;
        session.capeStats.consecutiveCapeDetections = 0;
      }
      break;
    }

    default:
      session.capeState = CAPE_STATES.NO_CAPE;
      break;
  }

  if (transitionEvent) {
    session.capeHistory.push(transitionEvent);
  }

  return {
    state: session.capeState,
    hasCapeRemoved: session.hasCapeRemoved,
    transitioned,
    previousState,
    event: transitionEvent
  };
}

/**
 * Evalúa si existe una barrera dura física de retiro de capa (Cape Removed)
 * entre dos sesiones o fragmentos, prohibiendo su fusión o consolidación.
 *
 * @param {Object} sessionA - Primera sesión o cita previa
 * @param {Object} sessionB - Segunda sesión o cita posterior
 * @returns {boolean} Retorna true si un retiro formal de capa prohíbe la fusión
 */
export function isCapeBarrierSeparating(sessionA, sessionB) {
  if (!sessionA || !sessionB || sessionA === sessionB) {
    return false;
  }

  const timeA = sessionA.startedAtEpoch || (sessionA.startedAt ? new Date(sessionA.startedAt).getTime() : 0);
  const timeB = sessionB.startedAtEpoch || (sessionB.startedAt ? new Date(sessionB.startedAt).getTime() : 0);

  // Determinar orden cronológico (si hay marcas temporales válidas)
  const earlier = (timeA > 0 && timeB > 0 && timeB < timeA) ? sessionB : sessionA;
  const later = earlier === sessionA ? sessionB : sessionA;

  // 1. Verificación directa de bandera hasCapeRemoved en la sesión previa
  if (earlier.hasCapeRemoved === true || earlier.capeState === CAPE_STATES.CAPE_REMOVED) {
    return true;
  }

  // 2. Historial de eventos de capa en la sesión previa
  if (Array.isArray(earlier.capeHistory)) {
    const hadRemovalEvent = earlier.capeHistory.some(
      e => e.to === CAPE_STATES.CAPE_REMOVED || e.state === CAPE_STATES.CAPE_REMOVED
    );
    if (hadRemovalEvent) return true;
  }

  // 3. Verificación de timestamp capeRemovedAt en capeStats
  if (earlier.capeStats?.capeRemovedAt) {
    return true;
  }

  // 4. Si la sesión posterior detectó una nueva capa tras un retiro previo
  if (later.capeStats?.newCapeDetectedAfterRemoval) {
    return true;
  }

  // 5. Bandera explícita de barrera de capa
  if (earlier.capeBarrierSeparating === true || later.capeBarrierSeparating === true) {
    return true;
  }

  return false;
}
