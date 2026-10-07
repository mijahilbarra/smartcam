import admin from "firebase-admin";
import sharp from "sharp";
import { captureSnapshotAdaptive, captureSnapshotFromRtsp } from "../infrastructure/camera/neolink_client.js";
import { uploadRawSnapshot, uploadClientCrop } from "../infrastructure/firebase/storage_client.js";
import { sanitizeForFirestore } from "../infrastructure/firebase/firestore_sanitizer.js";
import { daemonReporter } from "../daemon_reporter.js";
import { detectObjectsAndQuadrants } from "../detector.js";
import { processPeopleRecognition } from "./people_service.js";
import { telemetryStream } from "../infrastructure/streaming/telemetry_stream.js";
import { calculateIoU } from "../core/geometry.js";
import { isServiceChair, isTransitZone } from "../core/barbershop_rules.js";

/**
 * Adquisición bajo demanda del fotograma en alta resolución (Stream Clear / Mainstream 2560x1440).
 * Utiliza captureSnapshotFromRtsp sobre el stream RTSP principal.
 */
export async function acquireClearFrame({
  localOutputPath,
  rtspUrl = "rtsp://127.0.0.1:8554/barberia/main",
  timeoutMs = 8000
} = {}) {
  const outputPath = localOutputPath || `/tmp/snap_clear_${Date.now()}.jpeg`;
  try {
    return await captureSnapshotFromRtsp({ rtspUrl, localOutputPath: outputPath, timeoutMs });
  } catch (err) {
    console.warn(`[ClearStream] Aviso al capturar fotograma de alta resolución (${rtspUrl}):`, err.message);
    return null;
  }
}

/**
 * 1. Adquisición del fotograma: en tiempo real obtiene el buffer en RAM (0 ms);
 *    en modo manual ejecuta la captura adaptativa P2P con Neolink.
 */
export async function acquireFrame({
  streamServer,
  tomlPath,
  docId,
  isRealtime = false,
  triggerSource = "manual",
  localOutputPath
}) {
  if (!isRealtime) {
    console.log(`\n========================================`);
    console.log(`[1/5] Ejecutando captura P2P (${docId})...`);
    await daemonReporter.reportCameraQuery(triggerSource);
  }

  let buffer = streamServer?.getLatestFrame?.();
  if (!buffer) {
    if (isRealtime) {
      // Esperar a que el stream FFmpeg entregue el primer fotograma en memoria
      return null;
    }
    buffer = await captureSnapshotAdaptive({
      tomlPath,
      localOutputPath: localOutputPath || `/tmp/snap_${docId}.jpeg`
    });
  }

  if (!isRealtime && buffer) {
    console.log(`[2/5] Fotograma capturado: ${buffer.length} bytes.`);
  }

  return buffer;
}

/**
 * 2. Subida de imagen diagnóstica a Firebase Storage (solo capturas manuales o de arranque).
 */
export async function uploadDiagnosticSnapshot({ bucket, docId, buffer, isManual = false }) {
  if (!isManual) return null;

  const storagePath = `camera_catcher/photos/${docId}.jpg`;
  console.log(`[Storage] Subiendo imagen diagnóstica a Firebase Storage: ${storagePath}...`);
  if (bucket) {
    await uploadRawSnapshot(bucket, storagePath, buffer);
  }

  await daemonReporter.reportImageReceived({
    storagePath,
    width: 1024,
    height: 576,
    sizeBytes: buffer.length,
    docId
  });

  return storagePath;
}

/**
 * 3. Inferencia de Visión Local (ONNX Runtime / YOLO) y activación de cuadrantes.
 */
export async function detectScene(buffer, { isRealtime = false } = {}) {
  if (!isRealtime) console.log(`[3/5] Analizando fotograma con Machine Learning local (ONNX Runtime)...`);
  const mlResult = await detectObjectsAndQuadrants(buffer);
  if (!isRealtime) console.log(`[ML] Inferencia completada en ${mlResult.inferenceMs} ms. Cuadrantes detectados: ${mlResult.quadrants.length}`);

  if (!isRealtime) {
    await daemonReporter.reportQuadrantsActive(mlResult.quadrants);
    await daemonReporter.reportHumanDetection(mlResult);
  }

  return mlResult;
}

/**
 * 4. Actualización del seguimiento temporal de personas (PersonTracker).
 */
export function trackEntities(tracker, mlResult) {
  if (!tracker) return [];
  const activeTracks = tracker.update(
    mlResult.rawDetections || [],
    mlResult.quadrants || [],
    mlResult.imageDimensions?.width,
    mlResult.imageDimensions?.height
  );
  console.log(`[Tracker] Personas rastreadas activas (${activeTracks.length}): ${activeTracks.map(t => `#${t.trackId} [${t.currentQuadrant?.label || 'General'}]`).join(", ") || 'Ninguna'}`);
  return activeTracks;
}

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
 * @returns {Promise<Array>} Personas identificadas
 */
export async function reidentifyPeople({ db, clientRecords = [], clientCrops = [], activeSessions = [] }) {
  if (!clientCrops || clientCrops.length === 0) return [];
  console.log(`[FaceRecognition] Evaluando biometría de personas detectadas...`);
  return await processPeopleRecognition(db, clientRecords, clientCrops, activeSessions);
}

/**
 * 6. Asociación de identidades al tracker mediante superposición espacial IoU.
 */
export function matchIdentitiesToTracks({ tracker, activeTracks = [], identifiedPeople = [], iouThreshold = 0.20 }) {
  if (!tracker) return new Set();
  const matchedTrackIds = new Set();

  for (const person of identifiedPeople) {
    let bestTrack = null;
    let maxIoU = 0;

    if (person.box) {
      for (const track of activeTracks) {
        if (matchedTrackIds.has(track.trackId)) continue;
        const iou = calculateIoU(person.box, track.box);
        if (iou > maxIoU) {
          maxIoU = iou;
          bestTrack = track;
        }
      }
    }

    // Coincidencia espacial suficiente
    if (bestTrack && maxIoU >= iouThreshold) {
      matchedTrackIds.add(bestTrack.trackId);
      tracker.updateIdentityAndFace(bestTrack.trackId, {
        identity: person,
        faceBuffer: person.faceBuffer,
        faceBoxNorm: person.faceBoxNorm,
        sharpnessScore: person.sharpnessScore
      });
      console.log(`[Tracker] Identidad "${person.name}" asociada a Track #${bestTrack.trackId} vía IoU (${(maxIoU * 100).toFixed(1)}%).`);
    }
  }

  return matchedTrackIds;
}

/**
 * 7. Gestión del ciclo de vida de sesiones de visita (apertura, actualización y cierre).
 */
export async function updateVisits({ visitService, tracker, activeTracks = [] }) {
  if (!visitService) return;

  for (const track of activeTracks) {
    await visitService.processTrack(track);
  }

  if (tracker?.historyTracks) {
    for (const lostTrack of tracker.historyTracks) {
      await visitService.closeSession(lostTrack.trackId);
    }
    tracker.historyTracks = [];
  }
}

/**
 * 8. Cálculo de métricas de ocupación en tiempo real.
 */
export function computeOccupancy({ quadrants = [], identifiedPeople = [], rawDetections = [] } = {}) {
  const clientsInCut = quadrants.filter(q =>
    isServiceChair(q) && (q.status === 'en_corte' || q.status === 'ocupada')
  ).length;

  const clientsWaiting = quadrants.filter(q =>
    (q.type === 'waiting_chair' || q.status === 'en_espera') && !isTransitZone(q)
  ).length;

  const activeBarbers = identifiedPeople.filter(p => p.isStaff).length ||
    quadrants.filter(q => q.status === 'en_servicio' || q.type === 'barber_workstation').length;

  const totalHumans = rawDetections.filter(d => d.class === 'person').length;

  return {
    clientsInCut,
    clientsWaiting,
    activeBarbers,
    totalHumans
  };
}

/**
 * 9. Emisión de telemetría de baja latencia por Server-Sent Events (SSE).
 */
export function broadcastTelemetry({ docId, mlResult, activeTracks = [], identifiedPeople = [], occupancy }) {
  const frameWidth = mlResult.origWidth || mlResult.imageDimensions?.width || 640;
  const frameHeight = mlResult.origHeight || mlResult.imageDimensions?.height || 360;

  telemetryStream.broadcast({
    type: "yolo_telemetry",
    docId,
    inferenceMs: mlResult.inferenceMs,
    frameWidth,
    frameHeight,
    humanBoxes: (mlResult.rawDetections || []).filter(d => d.class === "person").map(d => d.box),
    rawDetections: mlResult.rawDetections || [],
    tracks: activeTracks
      .filter(t => (t.missedFrames || 0) <= 1)
      .map(t => ({
        trackId: t.trackId,
        box: t.box,
        boxNorm: t.boxNorm || [
          Number((t.box[1] / frameHeight).toFixed(4)),
          Number((t.box[0] / frameWidth).toFixed(4)),
          Number((t.box[3] / frameHeight).toFixed(4)),
          Number((t.box[2] / frameWidth).toFixed(4))
        ],
        centroid: t.centroid,
        confidence: t.confidence,
        quadrant: t.currentQuadrant?.label || t.currentQuadrant?.name || null,
        quadrantId: t.currentQuadrant?.id || null,
        identity: t.identity ? {
          name: t.identity.name,
          isStaff: t.identity.isStaff === true,
          isFrequent: t.identity.isFrequent === true,
          visitCount: t.identity.visitCount || 1,
          confidence: t.identity.confidence || 0
        } : null,
        sharpnessScore: t.sharpnessScore || 0,
        missedFrames: t.missedFrames || 0
      })),
    quadrants: mlResult.quadrants || [],
    peopleIdentified: (identifiedPeople || []).map(p => ({
      name: p.name,
      isStaff: p.isStaff === true,
      isFrequent: p.isFrequent === true,
      visitCount: p.visitCount || 1,
      box: p.box
    })),
    occupancy
  });
}

/**
 * 10. Persistencia y reporte final del ciclo.
 * En tiempo real: reporte tick atómico a Firestore sin fotos duplicadas.
 * En modo manual: persistencia completa del documento de foto y reporte de ciclo completado.
 */
export async function persistCycleData({
  db,
  docId,
  timestamp,
  storagePath,
  clientRecords = [],
  identifiedPeople = [],
  mlResult,
  visitService,
  activeTracks = [],
  occupancy,
  isRealtime = false
}) {
  if (isRealtime) {
    await daemonReporter.reportRealtimeTick({
      docId,
      quadrants: mlResult.quadrants,
      mlResult,
      identifiedPeople,
      activeTracks,
      occupancy
    });

    return {
      status: "ok",
      mode: "realtime",
      tracks: activeTracks.length,
      occupancy
    };
  }

  // Notificar Fase 5: Clasificación biométrica (Modo manual / programado)
  await daemonReporter.reportPeopleIdentified(identifiedPeople, clientRecords);

  // Preparar resumen analítico
  console.log(`[4/5] Preparando resumen analítico...`);
  const clientsCountStr = clientRecords.length > 0 ? ` (${clientRecords.length} cliente(s) sentado(s) extraído(s))` : "";
  const peopleStr = identifiedPeople.length > 0 ? ` | Personas: ${identifiedPeople.map(p => `${p.name} (${p.isStaff ? 'Staff' : p.isFrequent ? 'Frecuente' : 'Nuevo'})`).join(", ")}` : "";
  const activeVisitsCount = visitService?.getActiveSessions?.()?.length || 0;
  const visitsStr = activeVisitsCount > 0 ? ` | Visitas en curso: ${activeVisitsCount}` : "";
  const summaryText = `ML Local: ${(mlResult.quadrants || []).map(q => `${q.label} [${q.status}]`).join(", ")}${clientsCountStr}${peopleStr}${visitsStr}`;
  console.log(`[Resumen] ${summaryText}`);

  // Persistir documento en Firestore: camera_catcher/photos/photos/<docId>
  const peopleClean = (identifiedPeople || []).map(({ faceBuffer, ...rest }) => rest);
  const record = {
    id: docId,
    imageStoragePath: storagePath,
    clients: clientRecords,
    identifiedPeople: peopleClean,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: new Date().toISOString(),
    epoch: timestamp,
    analysis: summaryText,
    ml: {
      engine: "onnxruntime-node",
      inferenceMs: mlResult.inferenceMs,
      imageDimensions: mlResult.imageDimensions,
      quadrants: mlResult.quadrants,
      rawDetections: mlResult.rawDetections,
      clientCount: clientRecords.length,
      identifiedPeopleCount: identifiedPeople.length
    },
    camera: "barberia",
    source: "gcp-e2-micro"
  };

  if (db) {
    const docRef = db.doc(`camera_catcher/photos/photos/${docId}`);
    const sanitizedRecord = sanitizeForFirestore(record);
    await docRef.set(sanitizedRecord);
    console.log(`[5/5] [Firestore] Documento guardado exitosamente en camera_catcher/photos/photos/${docId}`);
  }
  console.log(`========================================\n`);

  // Notificar Fase 6: Ciclo completado
  await daemonReporter.reportCycleCompleted({
    docId,
    summary: summaryText
  });

  return record;
}

/**
 * Pipeline principal de ejecución: orquesta el flujo paso a paso
 * de manera lineal, limpia y declarativa.
 *
 * @param {Object} context - Dependencias del ciclo (db, bucket, tracker, visitService, streamServer, tomlPath)
 * @param {Object} options - Parámetros del ciclo (triggerSource: 'realtime' | 'manual' | 'startup')
 * @returns {Promise<Object>} Resultado del ciclo
 */
export async function runProcessCycle(context = {}, options = {}) {
  const {
    db,
    bucket,
    tomlPath,
    streamServer,
    tracker,
    visitService,
    localOutputPath
  } = context;

  const triggerSource = options.triggerSource || "manual";
  const isRealtime = triggerSource === "realtime";
  const isManual = !isRealtime;

  const timestamp = Date.now();
  const docId = `photo_${timestamp}`;

  // 1. Adquisición del fotograma (RAM 0ms en realtime o P2P Neolink adaptativo)
  const buffer = await acquireFrame({
    streamServer,
    tomlPath,
    docId,
    isRealtime,
    triggerSource,
    localOutputPath
  });

  if (!buffer) {
    return { status: "waiting_for_frame" };
  }

  // 2. Subida diagnóstica a Firebase Storage (solo manual / arranque)
  const storagePath = await uploadDiagnosticSnapshot({ bucket, docId, buffer, isManual });

  // 3. Percepción e inferencia de visión local (ONNX / YOLO)
  const mlResult = await detectScene(buffer, { isRealtime });

  // 4. Seguimiento temporal y espacial de entidades (PersonTracker)
  const activeTracks = trackEntities(tracker, mlResult);

  // 4b. Adquisición reactiva de fotograma en alta resolución (Stream Clear) bajo demanda
  const acquireClearFn = options.acquireClearFrame || context.acquireClearFrame || acquireClearFrame;
  const clearRtspUrl = options.clearRtspUrl || context.clearRtspUrl || "rtsp://127.0.0.1:8554/barberia/main";
  const now = Date.now();
  const CLEAR_COOLDOWN_MS = 12000; // 12 segundos de enfriamiento por track

  const tracksNeedingClear = activeTracks.filter(track => {
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

  if (tracksNeedingClear.length > 0) {
    console.log(`[ClearStream] Se detectaron ${tracksNeedingClear.length} persona(s) que requieren captura Clear: Tracks [${tracksNeedingClear.map(t => `#${t.trackId}`).join(", ")}].`);

    tracksNeedingClear.forEach(t => {
      t.lastClearCaptureTime = now;
    });

    try {
      const clearBuffer = await acquireClearFn({
        localOutputPath: localOutputPath ? `${localOutputPath}_clear.jpeg` : `/tmp/snap_clear_${docId}.jpeg`,
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
          }
        }
      } else {
        console.warn(`[ClearStream] Fotograma Clear no disponible. Continuando con recortes ligeros.`);
      }
    } catch (err) {
      console.warn(`[ClearStream] Fallo al capturar fotograma Clear (${err.message}). Continuando con recortes ligeros.`);
    }
  }

  // 5. Recortes y re-identificación biométrica facial gobernada por sesión
  const activeSessions = visitService?.getActiveSessions?.() || [];
  const clientRecords = await extractClientCrops({ bucket, clientCrops: mlResult.clientCrops, docId, isManual });
  const identifiedPeople = await reidentifyPeople({
    db,
    clientRecords,
    clientCrops: mlResult.clientCrops,
    activeSessions
  });

  // 6. Asociación de identidades y caras nítidas a tracks vía IoU
  matchIdentitiesToTracks({ tracker, activeTracks, identifiedPeople });

  // 7. Gestión del ciclo de vida de visitas y sesiones en sillas
  await updateVisits({ visitService, tracker, activeTracks });

  // 8. Cálculo dinámico de métricas de ocupación
  const occupancy = computeOccupancy({
    quadrants: mlResult.quadrants,
    identifiedPeople,
    rawDetections: mlResult.rawDetections
  });

  // 9. Emisión de telemetría en tiempo real por SSE
  broadcastTelemetry({ docId, mlResult, activeTracks, identifiedPeople, occupancy });

  // 10. Persistencia atómica y reporte de estado (SSE / Firestore)
  return await persistCycleData({
    db,
    docId,
    timestamp,
    storagePath,
    clientRecords,
    identifiedPeople,
    mlResult,
    visitService,
    activeTracks,
    occupancy,
    isRealtime
  });
}
