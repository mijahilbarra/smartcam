import sharp from "sharp";
import { captureSnapshotFromRtsp } from "../../infrastructure/camera/neolink_client.js";
import { calculateIoU } from "../../core/geometry.js";

let clearStreamDisabledUntil = 0;

export function getClearStreamDisabledUntil() {
  return clearStreamDisabledUntil;
}

export function setClearStreamDisabledUntil(timestamp) {
  clearStreamDisabledUntil = timestamp;
}

export function resolveMainRtspUrl(subUrl = process.env.RTSP_STREAM_URL) {
  if (process.env.RTSP_MAIN_STREAM_URL) return process.env.RTSP_MAIN_STREAM_URL;
  if (!subUrl) return "rtsp://127.0.0.1:8554/barberia/main";
  if (subUrl.includes("/sub")) return subUrl.replace(/\/sub(Stream|stream)?\/?$/, "/main");
  if (!subUrl.endsWith("/main")) return `${subUrl.replace(/\/+$/, "")}/main`;
  return subUrl;
}

/**
 * Adquisición bajo demanda del fotograma en alta resolución (Stream Clear / Mainstream 2560x1440).
 * Utiliza captureSnapshotFromRtsp sobre el stream RTSP principal.
 */
export async function acquireClearFrame({
  localOutputPath,
  rtspUrl = resolveMainRtspUrl(),
  timeoutMs = 3500
} = {}) {
  if (process.env.ENABLE_MAIN_STREAM === "false") {
    return null;
  }
  if (Date.now() < clearStreamDisabledUntil) {
    return null;
  }
  const effectiveRtspUrl = resolveMainRtspUrl(rtspUrl);
  const outputPath = localOutputPath || `/tmp/snap_clear_${Date.now()}.jpeg`;
  try {
    return await captureSnapshotFromRtsp({ rtspUrl: effectiveRtspUrl, localOutputPath: outputPath, timeoutMs });
  } catch (err) {
    clearStreamDisabledUntil = Date.now() + 30000; // 30 segundos de enfriamiento si falla la conexión RTSP
    console.warn(`[ClearStream] Aviso al capturar fotograma de alta resolución (${effectiveRtspUrl}). Cooldown 30s activado:`, err.message);
    return null;
  }
}

/**
 * 4b. Enriquecimiento reactivo de recortes con Stream Clear de alta resolución bajo demanda.
 * Evalúa tracks en sillas que carecen de rostro nítido y están fuera de cooldown,
 * captura el fotograma Clear 2560x1440, reescala las coordenadas y recorta con Sharp a 95% calidad.
 */
export async function enrichCropsWithClearStream({
  activeTracks = [],
  mlResult = {},
  options = {},
  context = {},
  docId,
  localOutputPath
} = {}) {
  const isCustomAcquire = Boolean(options.acquireClearFrame || context.acquireClearFrame);
  if ((process.env.ENABLE_MAIN_STREAM === "false" || process.env.MOCK_VIDEO_PATH || context.streamServer?.mockVideoPath) && !isCustomAcquire) {
    return;
  }
  const acquireClearFn = options.acquireClearFrame || context.acquireClearFrame || acquireClearFrame;
  const defaultClearRtspUrl = resolveMainRtspUrl();
  const clearRtspUrl = options.rtspUrl || (context.rtspUrl ? resolveMainRtspUrl(context.rtspUrl) : defaultClearRtspUrl);
  const effectiveLocalOutputPath = localOutputPath || context.localOutputPath;
  const now = Date.now();
  const CLEAR_COOLDOWN_MS = 20000; // 20 segundos de enfriamiento por track

  const tracksNeedingClear = (!isCustomAcquire && now < clearStreamDisabledUntil) ? [] : activeTracks.filter(track => {
    if (track.isStaffHint || track.role === "staff") return false;
    const quad = track.currentQuadrant;
    if (!quad) return false;
    const isCaptureZone = quad.capturePerson !== false && (
      quad.capturePerson === true ||
      quad.type === "barber_chair" ||
      quad.type === "waiting_chair" ||
      quad.type === "barber_workstation" ||
      quad.category === "cliente" ||
      quad.category === "personal"
    );
    if (!isCaptureZone) return false;

    const currentSharpness = track.bestFace?.sharpnessScore || track.sharpnessScore || 0;
    const lacksClearFace = !track.bestFace || currentSharpness < 60;
    const offCooldown = !track.lastClearCaptureTime || (now - track.lastClearCaptureTime > CLEAR_COOLDOWN_MS);

    return lacksClearFace && offCooldown;
  });

  if (tracksNeedingClear.length === 0) {
    return;
  }

  console.log(`[ClearStream] Se detectaron ${tracksNeedingClear.length} persona(s) que requieren captura Clear: Tracks [${tracksNeedingClear.map(t => `#${t.trackId}`).join(", ")}].`);

  tracksNeedingClear.forEach(t => {
    t.lastClearCaptureTime = now;
  });

  const processClearCapture = async () => {
    try {
      const clearBuffer = await acquireClearFn({
        localOutputPath: effectiveLocalOutputPath ? `${effectiveLocalOutputPath}_clear.jpeg` : `/tmp/snap_clear_${docId || now}.jpeg`,
        rtspUrl: clearRtspUrl
      });

      if (clearBuffer) {
        const clearMeta = await sharp(clearBuffer).metadata();
        const clearW = clearMeta.width || 2560;
        const clearH = clearMeta.height || 1440;
        const origW = mlResult.origWidth || mlResult.imageDimensions?.width || 640;
        const origH = mlResult.origHeight || mlResult.imageDimensions?.height || 360;

        const scaleX = clearW / origW;
        const scaleY = clearH / origH;

        for (const track of tracksNeedingClear) {
          let cx1, cy1, cx2, cy2;
          if (track.boxNorm && track.boxNorm.length === 4) {
            cy1 = Math.round(track.boxNorm[0] * clearH);
            cx1 = Math.round(track.boxNorm[1] * clearW);
            cy2 = Math.round(track.boxNorm[2] * clearH);
            cx2 = Math.round(track.boxNorm[3] * clearW);
          } else if (track.box) {
            cx1 = Math.round(track.box[0] * scaleX);
            cy1 = Math.round(track.box[1] * scaleY);
            cx2 = Math.round(track.box[2] * scaleX);
            cy2 = Math.round(track.box[3] * scaleY);
          } else {
            continue;
          }

          cx1 = Math.max(0, Math.min(clearW - 1, cx1));
          cy1 = Math.max(0, Math.min(clearH - 1, cy1));
          cx2 = Math.max(cx1 + 1, Math.min(clearW, cx2));
          cy2 = Math.max(cy1 + 1, Math.min(clearH, cy2));

          const cropW = cx2 - cx1;
          const cropH = cy2 - cy1;

          if (cropW > 10 && cropH > 10) {
            const highResCropBuffer = await sharp(clearBuffer)
              .extract({ left: cx1, top: cy1, width: cropW, height: cropH })
              .jpeg({ quality: 95 })
              .toBuffer();

            let matchedCrop = (mlResult.clientCrops || []).find(c => {
              if (c.zoneId && track.currentQuadrant?.id && c.zoneId === track.currentQuadrant.id) return true;
              if (c.box && track.box) return calculateIoU(c.box, track.box) > 0.30;
              return false;
            });

            if (matchedCrop) {
              matchedCrop.buffer = highResCropBuffer;
              matchedCrop.isHighRes = true;
              matchedCrop.scaleFactor = { scaleX, scaleY };
              console.log(`[ClearStream] Recorte de Track #${track.trackId} actualizado a alta resolución (${cropW}x${cropH}).`);
            } else {
              const role = track.currentQuadrant?.role || "client";
              mlResult.clientCrops = mlResult.clientCrops || [];
              mlResult.clientCrops.push({
                id: `${role}_clear_${track.trackId}`,
                role,
                isStaffHint: role === "staff",
                zoneId: track.currentQuadrant?.id || null,
                zoneType: track.currentQuadrant?.type || "custom_zone",
                box: track.box,
                confidence: track.confidence,
                status: role === "staff" ? "en_servicio" : "en_corte",
                capturePerson: true,
                requiresClearCapture: true,
                isHighRes: true,
                buffer: highResCropBuffer
              });
              console.log(`[ClearStream] Nuevo recorte de alta resolución generado para Track #${track.trackId}.`);
            }
            if (mlResult.skippedDueToNoChange) {
              mlResult.skippedDueToNoChange = false;
            }
          }
        }
      } else {
        console.warn(`[ClearStream] Fotograma Clear no disponible. Continuando con recortes ligeros.`);
      }
    } catch (err) {
      console.warn(`[ClearStream] Fallo al capturar fotograma Clear (${err.message}). Continuando con recortes ligeros.`);
    }
  };

  if (options.asyncClear === true) {
    processClearCapture();
  } else {
    await processClearCapture();
  }
}

export const STEP_NAME = "Enriquecimiento en Alta Resolución";
export const STEP_DESCRIPTION = (highResCount = 0) =>
  `Captura reactiva bajo demanda en 2560x1440 para ${highResCount} recortes faciales con nitidez mejorada.`;
export const formatStepSummary = (imagesCount = 0, appointmentsCount = 0, details = "") =>
  `**${STEP_NAME}:** ${imagesCount.toLocaleString()} imágenes, ${appointmentsCount} atenciones.${details ? `\n   - *${details}*` : ""}`;

