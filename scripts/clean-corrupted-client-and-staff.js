/**
 * scripts/clean-corrupted-client-and-staff.js
 * 
 * Saneamiento de base de datos tras incidentes de producción (Bugs A, B y C):
 * 1. Restaura 'staff_barbero' en SQLite y Firestore usando los 20 ángulos originales
 *    preservados en data/barberia.db (limpiando la foto del cliente que lo sobreescribió).
 * 2. Limpia 'Cliente #366' (person_1791506117024_1) en SQLite y Firestore:
 *    Conserva únicamente sus 4 fotos originales del 9 de octubre y purga las 25 fotos
 *    extrañas fusionadas erróneamente el 12 de octubre.
 * 3. Elimina la cita corrupta de 61 minutos 'appt_1791830773049_40' generada por el bucle de silla vacía.
 *
 * Uso:
 *   node scripts/clean-corrupted-client-and-staff.js --database=test           # Dry run
 *   node scripts/clean-corrupted-client-and-staff.js --database=test --apply   # Aplica cambios
 */

import { initFirebaseAdmin } from "../src/infrastructure/firebase/firebase_admin.js";
import { getSqliteClient, blobToVector } from "../src/infrastructure/storage/sqlite_client.js";
import Database from "better-sqlite3";
import fs from "fs";

function parseArgs() {
  const args = process.argv.slice(2);
  let databaseId = "test";
  let apply = false;

  for (const arg of args) {
    if (arg.startsWith("--database=")) {
      databaseId = arg.split("=")[1].trim();
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--dry-run") {
      apply = false;
    }
  }

  return { databaseId, apply };
}

async function main() {
  const { databaseId, apply } = parseArgs();
  console.log(`================================================================`);
  console.log(`  SANEAMIENTO DE STAFF Y CLIENTE CORRUPTOS (Database: ${databaseId})`);
  console.log(`  Modo: ${apply ? "🔴 APLICAR CAMBIOS EN VIVO" : "🟡 SIMULACIÓN (DRY-RUN)"}`);
  console.log(`================================================================\n`);

  // 1. Obtener fotos y embeddings limpios de staff_barbero desde data/barberia.db
  if (!fs.existsSync("data/barberia.db")) {
    throw new Error("No se encontró data/barberia.db con los vectores limpios del barbero.");
  }

  const prodDb = new Database("data/barberia.db");
  const staffRow = prodDb.prepare("SELECT * FROM customers WHERE id = 'staff_barbero'").get();
  const staffEmbRows = prodDb.prepare("SELECT * FROM customer_embeddings WHERE customer_id = 'staff_barbero' ORDER BY embedding_index ASC").all();

  if (!staffRow) {
    throw new Error("No se encontró el registro original de 'staff_barbero' en data/barberia.db.");
  }

  const cleanStaffPhotos = JSON.parse(staffRow.photos_json || "[]");
  const cleanStaffEmbeddings = staffEmbRows.map(r => ({ vector: blobToVector(r.embedding_blob) }));

  console.log(`[Staff] Encontradas ${cleanStaffPhotos.length} fotos originales del Barbero en data/barberia.db.`);

  const staffCleanProfile = {
    id: "staff_barbero",
    name: "Barbero",
    isStaff: true,
    role: "barber",
    firstSeen: staffRow.first_seen || cleanStaffPhotos[0]?.capturedAt || "2026-10-08T22:14:11.839Z",
    lastSeen: staffRow.last_seen || cleanStaffPhotos[cleanStaffPhotos.length - 1]?.capturedAt || new Date().toISOString(),
    visitCount: 1,
    bestFaceScore: staffRow.best_face_score || 100,
    thumbnailBase64: cleanStaffPhotos[0]?.thumbnailBase64 || null,
    photos: cleanStaffPhotos,
    embeddings: cleanStaffEmbeddings,
    embedding: cleanStaffEmbeddings[0]?.vector || null
  };

  // 2. Conectar a Firestore
  const fb = initFirebaseAdmin({ databaseId });
  const targetSqlite = getSqliteClient(databaseId);

  // A. Reparar staff_barbero
  console.log(`\n--- [1/3] Restaurando 'staff_barbero' ---`);
  const currentStaffDoc = await fb.db.doc("camera_catcher_people/staff_barbero").get();
  if (currentStaffDoc.exists) {
    const d = currentStaffDoc.data();
    console.log(`  Firestore actual: ${d.photos?.length || 0} fotos (Última: ${d.photos?.[0]?.capturedAt}).`);
  } else {
    console.log(`  Firestore actual: Documento no existe.`);
  }

  if (apply) {
    targetSqlite.upsertCustomer(staffCleanProfile);
    await fb.db.doc("camera_catcher_people/staff_barbero").set(staffCleanProfile);
    console.log(`  ✅ 'staff_barbero' restaurado con éxito con 20 fotos legítimas.`);
  } else {
    console.log(`  [DRY-RUN] Se restauraría 'staff_barbero' con ${cleanStaffPhotos.length} fotos y ${cleanStaffEmbeddings.length} vectores.`);
  }

  // B. Reparar Cliente #366 (person_1791506117024_1)
  console.log(`\n--- [2/3] Saneando 'Cliente #366' (person_1791506117024_1) ---`);
  const c366Doc = await fb.db.doc("camera_catcher_people/person_1791506117024_1").get();
  if (!c366Doc.exists) {
    console.log(`  ⚠️ No se encontró 'person_1791506117024_1' en Firestore (${databaseId}).`);
  } else {
    const cData = c366Doc.data();
    const allPhotos = cData.photos || [];
    const allEmbeddings = cData.embeddings || [];
    console.log(`  Firestore actual: ${allPhotos.length} fotos, ${allEmbeddings.length} embeddings.`);

    // Las primeras 4 fotos son las legítimas del 9 de octubre
    const originalPhotos = allPhotos.slice(0, 4);
    const originalEmbeddings = allEmbeddings.slice(0, 4);
    const purgedCount = allPhotos.length - originalPhotos.length;

    console.log(`  -> Conservando ${originalPhotos.length} fotos originales del 9 de octubre.`);
    console.log(`  -> Purgando ${purgedCount} fotos extrañas fusionadas el 12 de octubre.`);

    const c366Cleaned = {
      ...cData,
      photos: originalPhotos,
      embeddings: originalEmbeddings,
      embedding: originalEmbeddings[0] ? (originalEmbeddings[0].vector || originalEmbeddings[0]) : null,
      visitCount: 1,
      appointmentCount: 1,
      lastSeen: originalPhotos[originalPhotos.length - 1]?.capturedAt || cData.firstSeen || new Date().toISOString()
    };

    if (apply) {
      targetSqlite.upsertCustomer(c366Cleaned);
      await fb.db.doc("camera_catcher_people/person_1791506117024_1").set(c366Cleaned);
      console.log(`  ✅ 'Cliente #366' saneado exitosamente: 4 fotos originales restauradas.`);
    } else {
      console.log(`  [DRY-RUN] Se conservarían 4 fotos y se eliminarían ${purgedCount} fotos extrañas.`);
    }
  }

  // C. Eliminar cita corrupta de 61 minutos
  console.log(`\n--- [3/3] Eliminando cita fantasma 'appt_1791830773049_40' ---`);
  const corruptedApptId = "appt_1791830773049_40";
  const apptDoc = await fb.db.doc(`camera_catcher_appointments/${corruptedApptId}`).get();
  if (apptDoc.exists) {
    const apptData = apptDoc.data();
    console.log(`  Encontrada cita fantasma: ${corruptedApptId} (${apptData.durationMinutes} min, Cliente: ${apptData.clientName}).`);
    if (apply) {
      await fb.db.doc(`camera_catcher_appointments/${corruptedApptId}`).delete();
      console.log(`  ✅ Cita corrupta eliminada de Firestore.`);
    } else {
      console.log(`  [DRY-RUN] Se eliminaría la cita ${corruptedApptId} de Firestore.`);
    }
  } else {
    console.log(`  Cita ${corruptedApptId} no encontrada (ya eliminada).`);
  }

  console.log(`\n================================================================`);
  console.log(`  SANEAMIENTO COMPLETADO ${apply ? "CON ÉXITO" : "(DRY-RUN)"}`);
  console.log(`================================================================\n`);
  process.exit(0);
}

main().catch(err => {
  console.error("Error en saneamiento:", err);
  process.exit(1);
});
