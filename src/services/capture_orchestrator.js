/**
 * Orquestador del Proceso de Captura y Análisis (Capture Orchestrator)
 * Coordina todo el ciclo de vida: Neolink -> ML/YOLO -> Storage -> Biometría -> Firestore -> Telemetría
 */

import admin from "firebase-admin";
import path from "path";
import { captureSnapshotWithDocker, killCaptureContainer } from "../infrastructure/camera/neolink_client.js";
import { uploadRawSnapshot, uploadClientCrop } from "../infrastructure/firebase/storage_client.js";
import { sanitizeForFirestore } from "../infrastructure/firebase/firestore_sanitizer.js";
import { daemonReporter } from "../daemon_reporter.js";
import { detectObjectsAndQuadrants } from "../detector.js";
import { processPeopleRecognition } from "./people_service.js";

export class CaptureOrchestrator {
  constructor({ db, bucket, tomlPath, scheduler }) {
    this.db = db;
    this.bucket = bucket;
    this.tomlPath = tomlPath;
    this.scheduler = scheduler;
    this.isCapturing = false;
  }

  /**
   * Ejecuta el ciclo integral de captura y análisis
   * @param {string} triggerSource - "scheduled" | "manual" | "startup"
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
      console.log(`\n========================================`);
      console.log(`[1/5] Ejecutando captura P2P (${docId})...`);

      // 1. Notificar Fase 1: Se activa consulta a la cámara de seguridad
      await daemonReporter.reportCameraQuery(triggerSource);

      // 2. Captura mediante Docker Neolink
      const buffer = await captureSnapshotWithDocker({
        tomlPath: this.tomlPath,
        localOutputPath
      });
      console.log(`[2/5] Fotograma capturado: ${buffer.length} bytes.`);

      // 3. Subir imagen original a Firebase Storage
      const storagePath = `camera_catcher/photos/${docId}.jpg`;
      console.log(`[Storage] Subiendo imagen original a Firebase Storage: ${storagePath}...`);
      await uploadRawSnapshot(this.bucket, storagePath, buffer);

      // 4. Notificar Fase 2: Imagen recibida en vivo
      await daemonReporter.reportImageReceived({
        storagePath,
        width: 1024,
        height: 576,
        sizeBytes: buffer.length,
        docId
      });

      // 5. Inferencia de Visión Local (ONNX Runtime / YOLO)
      console.log(`[3/5] Analizando fotograma con Machine Learning local (ONNX Runtime)...`);
      const mlResult = await detectObjectsAndQuadrants(buffer);
      console.log(`[ML] Inferencia completada en ${mlResult.inferenceMs} ms. Cuadrantes detectados: ${mlResult.quadrants.length}`);

      // Notificar Fase 3: Cuadrantes activos
      await daemonReporter.reportQuadrantsActive(mlResult.quadrants);

      // Notificar Fase 4: Detección de humanos
      await daemonReporter.reportHumanDetection(mlResult);

      // 6. Subir recortes de clientes sentados detectados
      const clientRecords = [];
      if (mlResult.clientCrops && mlResult.clientCrops.length > 0) {
        for (let i = 0; i < mlResult.clientCrops.length; i++) {
          const crop = mlResult.clientCrops[i];
          const clientStoragePath = `camera_catcher/photos/${docId}_client_${i + 1}.jpg`;
          console.log(`[Storage] Subiendo recorte de cliente sentado (${i + 1}/${mlResult.clientCrops.length}): ${clientStoragePath}...`);

          await uploadClientCrop(this.bucket, clientStoragePath, crop.buffer);

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

      // 7. Reconocimiento y Re-identificación Facial
      let identifiedPeople = [];
      if (mlResult.clientCrops && mlResult.clientCrops.length > 0) {
        console.log(`[FaceRecognition] Evaluando biometría de personas detectadas...`);
        identifiedPeople = await processPeopleRecognition(this.db, clientRecords, mlResult.clientCrops);
      }

      // Notificar Fase 5: Clasificación biométrica
      await daemonReporter.reportPeopleIdentified(identifiedPeople, clientRecords);

      // 8. Preparar resumen analítico
      console.log(`[4/5] Preparando resumen analítico...`);
      const clientsCountStr = clientRecords.length > 0 ? ` (${clientRecords.length} cliente(s) sentado(s) extraído(s))` : "";
      const peopleStr = identifiedPeople.length > 0 ? ` | Personas: ${identifiedPeople.map(p => `${p.name} (${p.isStaff ? 'Staff' : p.isFrequent ? 'Frecuente' : 'Nuevo'})`).join(", ")}` : "";
      const summaryText = `ML Local: ${mlResult.quadrants.map(q => `${q.label} [${q.status}]`).join(", ")}${clientsCountStr}${peopleStr}`;
      console.log(`[Resumen] ${summaryText}`);

      // 9. Persistir documento en Firestore: camera_catcher/photos/photos/<docId>
      const docRef = this.db.doc(`camera_catcher/photos/photos/${docId}`);
      const record = {
        id: docId,
        imageStoragePath: storagePath,
        clients: clientRecords,
        identifiedPeople: identifiedPeople,
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

      try {
        await this.db.doc("camera_catcher/status").set({
          service: "camera-catcher",
          status: "ok",
          lastCaptureAt: new Date().toISOString(),
          lastDocId: docId
        }, { merge: true });
      } catch (_) {}

      return record;
    } catch (err) {
      console.error(`[Capture Error] Falló el proceso de captura:`, err.message);
      await daemonReporter.reportError(err);
      try {
        await this.db.doc("camera_catcher/status").set({
          service: "camera-catcher",
          status: "error",
          lastError: err.message,
          lastErrorAt: new Date().toISOString()
        }, { merge: true });
      } catch (_) {}
      throw err;
    } finally {
      this.isCapturing = false;
      await killCaptureContainer();
    }
  }
}
