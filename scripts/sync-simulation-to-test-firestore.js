import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { initFirebaseAdmin } from "../src/infrastructure/firebase/firebase_admin.js";
import { getFirestore } from "firebase-admin/firestore";
import { sanitizeForFirestore } from "../src/infrastructure/firebase/firestore_sanitizer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

const { admin } = initFirebaseAdmin();
const dbTest = getFirestore(admin.app(), "test");

const expDb = new Database(path.join(PROJECT_ROOT, "data", "experiments.db"), { readonly: true });

// 1. Purgar citas y unidades antiguas en Firestore test
console.log("Limpiando citas obsoletas en Firestore test...");
const oldApptsSnap = await dbTest.collection("camera_catcher_appointments").get();
for (const doc of oldApptsSnap.docs) {
  await doc.ref.delete();
}
const oldUnitsSnap = await dbTest.collection("camera_catcher_attention_units").get();
for (const doc of oldUnitsSnap.docs) {
  await doc.ref.delete();
}
console.log(`Eliminadas ${oldApptsSnap.size} citas y ${oldUnitsSnap.size} unidades antiguas.`);

// 2. Obtener todas las citas y unidades de experiments.db
const expAppts = expDb.prepare("SELECT * FROM experiment_appointments ORDER BY started_epoch ASC").all();
const expUnits = expDb.prepare("SELECT * FROM experiment_attention_units WHERE status = 'completed' ORDER BY started_epoch ASC").all();

console.log(`Encontradas ${expAppts.length} citas y ${expUnits.length} unidades completadas en experiments.db.`);

// Mapear base date al día de hoy (2026-11-05) manteniendo los horarios de la tarde (15:00 a 20:30 UTC)
const firstExpStart = expAppts[0].started_epoch;
const targetBaseEpoch = new Date("2026-11-05T15:24:40.000Z").getTime();
const epochOffset = targetBaseEpoch - firstExpStart;

const clientNames = ["Cliente #1", "Cliente #2", "Cliente #3", "Cliente #4", "Cliente #5", "Cliente #6"];

// 3. Insertar citas y sus unidades
for (let i = 0; i < expAppts.length; i++) {
  const row = expAppts[i];
  const newStartEpoch = row.started_epoch + epochOffset;
  const newEndEpoch = row.ended_epoch + epochOffset;
  const newStartedAt = new Date(newStartEpoch).toISOString();
  const newEndedAt = new Date(newEndEpoch).toISOString();
  const clientName = clientNames[i] || `Cliente #${i+1}`;
  const clientId = `person_canon_${i+1}`;

  // Unidades de esta cita
  const unitsForRow = expUnits.filter(u => u.appointment_id === row.id).map((u, uIdx) => {
    const uStartEpoch = u.started_epoch + epochOffset;
    const uEndEpoch = u.ended_epoch + epochOffset;
    const uStartedAt = new Date(uStartEpoch).toISOString();
    const uEndedAt = new Date(uEndEpoch).toISOString();
    const rawPhotos = JSON.parse(u.photos_json || "[]");
    const bestThumb = u.thumbnail_base64 || rawPhotos[0]?.thumbnailBase64 || null;
    const lightweightPhotos = rawPhotos.slice(0, 2).map((p, pIdx) => ({
      sharpnessScore: p.sharpnessScore || 0,
      pose: p.pose || "frontal",
      capturedAt: p.capturedAt || uStartedAt,
      thumbnailBase64: pIdx === 0 ? bestThumb : undefined
    }));

    return {
      id: `unit_${row.id}_${uIdx+1}`,
      appointmentId: row.id,
      chairId: "silla_barbero_puesto2",
      chairName: "Silla 2",
      clientId,
      clientName,
      startedAt: uStartedAt,
      endedAt: uEndedAt,
      startedEpoch: uStartEpoch,
      endedEpoch: uEndEpoch,
      durationMinutes: u.duration_minutes,
      durationSeconds: u.duration_seconds || (u.duration_minutes * 60),
      status: "completed",
      bestFaceScore: u.best_face_score,
      thumbnailPath: u.thumbnail_path,
      thumbnailBase64: bestThumb,
      photos: lightweightPhotos,
      embeddingsCount: u.embeddings_count
    };
  });

  const rawApptPhotos = JSON.parse(row.photos_json || "[]");
  const apptThumb = unitsForRow[0]?.thumbnailBase64 || rawApptPhotos[0]?.thumbnailBase64 || null;
  const lightweightApptPhotos = rawApptPhotos.slice(0, 3).map((p, pIdx) => ({
    sharpnessScore: p.sharpnessScore || 0,
    pose: p.pose || "frontal",
    capturedAt: p.capturedAt || newStartedAt,
    thumbnailBase64: pIdx === 0 ? apptThumb : undefined
  }));
  const totalDuration = unitsForRow.reduce((acc, u) => acc + (u.durationMinutes || 0), 0);

  const apptDoc = {
    id: row.id,
    chairId: "silla_barbero_puesto2",
    chairName: "Silla 2",
    clientId,
    clientName,
    clientBadge: i === 0 ? "Cliente Frecuente" : "Nuevo Cliente",
    startTime: newStartedAt,
    endTime: newEndedAt,
    startedAt: newStartedAt,
    endedAt: newEndedAt,
    startedEpoch: newStartEpoch,
    endedEpoch: newEndEpoch,
    durationMinutes: totalDuration,
    status: "completed",
    bestFaceScore: row.best_face_score,
    thumbnailPath: row.thumbnail_path,
    thumbnailBase64: apptThumb,
    photos: lightweightApptPhotos,
    unitsCount: unitsForRow.length,
    attentionUnits: unitsForRow,
    createdAt: newStartedAt
  };

  await dbTest.collection("camera_catcher_appointments").doc(apptDoc.id).set(sanitizeForFirestore(apptDoc));
  console.log(`✅ [Cita ${i+1}] ${clientName} (${apptDoc.durationMinutes} min, ${unitsForRow.length} unidades) subida a camera_catcher_appointments`);

  // Subir también cada unidad a camera_catcher_attention_units
  for (const u of unitsForRow) {
    await dbTest.collection("camera_catcher_attention_units").doc(u.id).set(sanitizeForFirestore(u));
  }
}

// Subir los clientes correspondientes a camera_catcher_people si no existen
for (let i = 0; i < expAppts.length; i++) {
  const clientId = `person_canon_${i+1}`;
  const clientName = clientNames[i] || `Cliente #${i+1}`;
  const personDoc = {
    id: clientId,
    name: clientName,
    role: "client",
    status: "confirmed",
    isStaff: false,
    visitCount: i === 0 ? 3 : 1,
    createdAt: new Date().toISOString()
  };
  await dbTest.collection("camera_catcher_people").doc(clientId).set(sanitizeForFirestore(personDoc), { merge: true });
}

console.log("\n🎉 ¡Sincronización completada! 6 citas canónicas y 20 unidades atómicas disponibles en Firestore test.");
process.exit(0);
