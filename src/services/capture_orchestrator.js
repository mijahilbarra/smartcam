import admin from "firebase-admin";
import path from "path";
import { captureSnapshotAdaptive, captureSnapshotWithDocker, killCaptureContainer } from "../infrastructure/camera/neolink_client.js";
import { uploadRawSnapshot, uploadClientCrop } from "../infrastructure/firebase/storage_client.js";
import { sanitizeForFirestore } from "../infrastructure/firebase/firestore_sanitizer.js";
import { daemonReporter } from "../daemon_reporter.js";
import { detectObjectsAndQuadrants } from "../detector.js";
import { processPeopleRecognition } from "./people_service.js";
import { PersonTracker } from "../core/person_tracker.js";
import { VisitSessionService } from "./visit_session_service.js";
import { telemetryStream } from "../infrastructure/streaming/telemetry_stream.js";
import { calculateIoU } from "../core/geometry.js";
import { isServiceChair, isTransitZone } from "../core/barbershop_rules.js";

export class CaptureOrchestrator {
  constructor({ db, bucket, tomlPath, scheduler, streamServer }) {
    this.db = db;
    this.bucket = bucket;
    this.tomlPath = tomlPath;
    this.scheduler = scheduler;
    this.streamServer = streamServer;
    this.isCapturing = false;
    this.tracker = new PersonTracker();
    this.visitService = new VisitSessionService({ db, bucket });
  }

  /**
   * Ejecuta el ciclo integral de captura y análisis
   * @param {string} triggerSource - "scheduled" | "manual" | "startup" | "realtime"
   * @returns {Promise<Object>}
   */
  async execute(triggerSource = "scheduled") {
    if (this.isCapturing) {
      console.log("[Capture] Ya hay una captura en curso. Omitiendo ejecución concurrente.");
      return { status: "already_running" };
    }

    this.isCapturing = true;
    const timestamp = Date.now();
    const docId = `photo_${timestamp}`;
    const localOutputPath = `/tmp/snap_${timestamp}.jpeg`;

    try {
      const isRealtime = triggerSource === "realtime";
      const isManual = triggerSource === "manual" || triggerSource === "startup";

      if (!isRealtime) {
        console.log(`\n========================================`);
        console.log(`[1/5] Ejecutando captura P2P (${docId})...`);
        await daemonReporter.reportCameraQuery(triggerSource);
      }

      // 2. Captura: En tiempo real, utilizar exclusivamente el fotograma en RAM del StreamServer (0 ms)
      let buffer = this.streamServer?.getLatestFrame();
      if (!buffer) {
        if (isRealtime) {
          // Esperar a que el stream FFmpeg entregue el primer fotograma en memoria
          return { status: "waiting_for_frame" };
        }
        buffer = await captureSnapshotAdaptive({
          tomlPath: this.tomlPath,
          localOutputPath
        });
      }

      if (!isRealtime) {
        console.log(`[2/5] Fotograma capturado: ${buffer.length} bytes.`);
      }

      // 3. Subir imagen original solo en capturas manuales/de arranque para diagnósticos
      let storagePath = null;
      if (isManual) {
        storagePath = `camera_catcher/photos/${docId}.jpg`;
        console.log(`[Storage] Subiendo imagen diagnóstica a Firebase Storage: ${storagePath}...`);
        await uploadRawSnapshot(this.bucket, storagePath, buffer);
      }

      // 4. Notificar Fase 2 solo en modo manual
      if (!isRealtime) {
        await daemonReporter.reportImageReceived({
          storagePath,
          width: 1024,
          height: 576,
          sizeBytes: buffer.length,
          docId
        });
      }

      // 5. Inferencia de Visión Local (ONNX Runtime / YOLO)
      if (!isRealtime) console.log(`[3/5] Analizando fotograma con Machine Learning local (ONNX Runtime)...`);
      const mlResult = await detectObjectsAndQuadrants(buffer);
      if (!isRealtime) console.log(`[ML] Inferencia completada en ${mlResult.inferenceMs} ms. Cuadrantes detectados: ${mlResult.quadrants.length}`);

      if (!isRealtime) {
        await daemonReporter.reportQuadrantsActive(mlResult.quadrants);
        await daemonReporter.reportHumanDetection(mlResult);
      }

      // 6. Actualizar seguimiento de personas (Person Tracker)
      const activeTracks = this.tracker.update(
        mlResult.rawDetections,
        mlResult.quadrants,
        mlResult.imageDimensions.width,
        mlResult.imageDimensions.height
      );
      console.log(`[Tracker] Personas rastreadas activas (${activeTracks.length}): ${activeTracks.map(t => `#${t.trackId} [${t.currentQuadrant?.label || 'General'}]`).join(", ") || 'Ninguna'}`);

      // 7. Subir recortes de clientes sentados detectados (solo si manual o arranque)
      const clientRecords = [];
      if (mlResult.clientCrops && mlResult.clientCrops.length > 0) {
        for (let i = 0; i < mlResult.clientCrops.length; i++) {
          const crop = mlResult.clientCrops[i];
          let clientStoragePath = null;

          if (isManual) {
            clientStoragePath = `camera_catcher/photos/${docId}_client_${i + 1}.jpg`;
            await uploadClientCrop(this.bucket, clientStoragePath, crop.buffer);
          }

          clientRecords.push({
            id: crop.id || `crop_${i + 1}`,
            storagePath: clientStoragePath,
            box: crop.box,
            confidence: crop.confidence,
            role: crop.role || "client",
            isStaffHint: crop.isStaffHint === true,
            status: crop.status || "en_corte",
            detectedAt: new Date().toISOString()
          });
        }
      }

      // 8. Reconocimiento y Re-identificación Facial (Filtrando nucas con RFB-320 y midiendo nitidez)
      let identifiedPeople = [];
      if (mlResult.clientCrops && mlResult.clientCrops.length > 0) {
        console.log(`[FaceRecognition] Evaluando biometría de personas detectadas...`);
        identifiedPeople = await processPeopleRecognition(this.db, clientRecords, mlResult.clientCrops);
      }

      // Asociar identidades al tracker mediante superposición espacial IoU (NUNCA por índice de array)
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

        // Si se encuentra un track con coincidencia espacial suficiente (IoU >= 0.20)
        if (bestTrack && maxIoU >= 0.20) {
          matchedTrackIds.add(bestTrack.trackId);
          this.tracker.updateIdentityAndFace(bestTrack.trackId, {
            identity: person,
            faceBuffer: person.faceBuffer,
            faceBoxNorm: person.faceBoxNorm,
            sharpnessScore: person.sharpnessScore
          });
          console.log(`[Tracker] Identidad "${person.name}" asociada a Track #${bestTrack.trackId} vía IoU (${(maxIoU * 100).toFixed(1)}%).`);
        }
      }

      // Procesar sesiones de visita activas
      for (const track of activeTracks) {
        await this.visitService.processTrack(track);
      }

      // Cerrar visitas de personas que salieron de la silla
      for (const lostTrack of this.tracker.historyTracks) {
        await this.visitService.closeSession(lostTrack.trackId);
      }
      this.tracker.historyTracks = [];

      // Calcular métricas de ocupación en tiempo real de forma dinámica
      const clientsInCut = mlResult.quadrants.filter(q =>
        isServiceChair(q) && (q.status === 'en_corte' || q.status === 'ocupada')
      ).length;
      const clientsWaiting = mlResult.quadrants.filter(q =>
        (q.type === 'waiting_chair' || q.status === 'en_espera') && !isTransitZone(q)
      ).length;
      const activeBarbers = identifiedPeople.filter(p => p.isStaff).length ||
        mlResult.quadrants.filter(q => q.status === 'en_servicio' || q.type === 'barber_workstation').length;
      const totalHumans = (mlResult.rawDetections || []).filter(d => d.class === 'person').length;

      const occupancy = {
        clientsInCut,
        clientsWaiting,
        activeBarbers,
        totalHumans
      };

      const frameWidth = mlResult.origWidth || mlResult.imageDimensions?.width || 640;
      const frameHeight = mlResult.origHeight || mlResult.imageDimensions?.height || 360;

      // Transmitir telemetría de visión YOLO directamente a clientes web SSE (Baja latencia < 20ms)
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
        peopleIdentified: identifiedPeople.map(p => ({
          name: p.name,
          isStaff: p.isStaff === true,
          isFrequent: p.isFrequent === true,
          visitCount: p.visitCount || 1,
          box: p.box
        })),
        occupancy
      });

      if (isRealtime) {
        // En tiempo real: Sincronización atómica única a Firestore sin escribir fotos innecesarias
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

      // 9. Preparar resumen analítico
      console.log(`[4/5] Preparando resumen analítico...`);
      const clientsCountStr = clientRecords.length > 0 ? ` (${clientRecords.length} cliente(s) sentado(s) extraído(s))` : "";
      const peopleStr = identifiedPeople.length > 0 ? ` | Personas: ${identifiedPeople.map(p => `${p.name} (${p.isStaff ? 'Staff' : p.isFrequent ? 'Frecuente' : 'Nuevo'})`).join(", ")}` : "";
      const activeVisitsCount = this.visitService.getActiveSessions().length;
      const visitsStr = activeVisitsCount > 0 ? ` | Visitas en curso: ${activeVisitsCount}` : "";
      const summaryText = `ML Local: ${mlResult.quadrants.map(q => `${q.label} [${q.status}]`).join(", ")}${clientsCountStr}${peopleStr}${visitsStr}`;
      console.log(`[Resumen] ${summaryText}`);

      // 9. Persistir documento en Firestore: camera_catcher/photos/photos/<docId>
      const docRef = this.db.doc(`camera_catcher/photos/photos/${docId}`);
      const peopleClean = identifiedPeople.map(({ faceBuffer, ...rest }) => rest);
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

      const sanitizedRecord = sanitizeForFirestore(record);
      await docRef.set(sanitizedRecord);
      console.log(`[5/5] [Firestore] Documento guardado exitosamente en camera_catcher/photos/photos/${docId}`);
      console.log(`========================================\n`);

      // 10. Notificar Fase 6: Ciclo completado y programar siguiente contador
      const intervalMinutes = this.scheduler?.currentIntervalMinutes || 15;
      const nextCaptureDate = new Date(Date.now() + Math.round(intervalMinutes * 60 * 1000));
      await daemonReporter.reportCycleCompleted({
        docId,
        summary: summaryText,
        nextCaptureDate,
        intervalMinutes
      });

      return record;
    } catch (err) {
      console.error(`[Capture Error] Falló el proceso de captura:`, err.message);
      await daemonReporter.reportError(err);
      throw err;
    } finally {
      this.isCapturing = false;
      if (triggerSource !== "realtime") {
        await killCaptureContainer();
      }
    }
  }
}
