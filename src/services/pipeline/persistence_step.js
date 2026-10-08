import admin from "firebase-admin";
import { sanitizeForFirestore } from "../../infrastructure/firebase/firestore_sanitizer.js";
import { daemonReporter } from "../../daemon_reporter.js";

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
