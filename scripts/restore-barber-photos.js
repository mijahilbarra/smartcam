/**
 * Script de Restauración y Blindaje de las 20 Fotos y Embeddings del Barbero
 * 
 * Lee la galería original auténtica de 20 fotos y 20 vectores desde data/barberia.db
 * y la sincroniza en:
 *  - SQLite: data/barberia.db y data/barberia_test.db
 *  - Firestore: databases '(default)' y 'test'
 * 
 * Uso:
 *   node scripts/restore-barber-photos.js --apply
 */

import { initFirebaseAdmin } from "../src/infrastructure/firebase/firebase_admin.js";
import { getSqliteClient, blobToVector } from "../src/infrastructure/storage/sqlite_client.js";
import Database from "better-sqlite3";
import fs from "fs";

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`================================================================`);
  console.log(`  RESTAURACIÓN Y BLINDAJE DE LAS 20 FOTOS DEL BARBERO (staff_barbero)`);
  console.log(`  Modo: ${apply ? "🔴 APLICAR CAMBIOS EN VIVO" : "🟡 SIMULACIÓN (DRY-RUN)"}`);
  console.log(`================================================================\n`);

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
  const cleanStaffEmbeddings = staffEmbRows.map((r, idx) => ({
    vector: blobToVector(r.embedding_blob),
    pose: cleanStaffPhotos[idx]?.pose || 'frontal',
    poseLabel: cleanStaffPhotos[idx]?.poseLabel || 'Frontal',
    sharpnessScore: cleanStaffPhotos[idx]?.sharpnessScore || r.sharpness_score || 0
  }));

  console.log(`[Staff] 💈 Fotos auténticas en data/barberia.db: ${cleanStaffPhotos.length} fotos, ${cleanStaffEmbeddings.length} vectores con pose.`);
  prodDb.close();

  if (cleanStaffPhotos.length !== 20 || cleanStaffEmbeddings.length !== 20) {
    console.warn(`[Staff] Advertencia: la cantidad no es 20 (fotos: ${cleanStaffPhotos.length}, embs: ${cleanStaffEmbeddings.length}).`);
  }

  const staffCleanProfile = {
    id: "staff_barbero",
    name: "Barbero",
    isStaff: true,
    role: "barber",
    firstSeen: staffRow.first_seen || cleanStaffPhotos[0]?.capturedAt || "2026-10-08T00:02:23.398Z",
    lastSeen: staffRow.last_seen || cleanStaffPhotos[cleanStaffPhotos.length - 1]?.capturedAt || new Date().toISOString(),
    visitCount: 1,
    appointmentCount: 0,
    bestFaceScore: staffRow.best_face_score || 98,
    thumbnailBase64: cleanStaffPhotos[0]?.thumbnailBase64 || null,
    photos: cleanStaffPhotos,
    embeddings: cleanStaffEmbeddings,
    embedding: cleanStaffEmbeddings[0]?.vector || null
  };

  const databases = ["(default)", "test"];

  for (const dbId of databases) {
    console.log(`\n--- Sincronizando Base de Datos: "${dbId}" ---`);
    const sqliteClient = getSqliteClient(dbId);

    // 1. SQLite
    if (apply) {
      sqliteClient.upsertCustomer(staffCleanProfile);
      console.log(`  ✔ SQLite (${dbId}): 'staff_barbero' guardado con ${cleanStaffPhotos.length} fotos.`);
    } else {
      console.log(`  [DRY-RUN] Se guardaría en SQLite (${dbId}).`);
    }

    // 2. Firestore
    try {
      const fb = initFirebaseAdmin({ databaseId: dbId });
      if (apply) {
        await fb.db.collection("camera_catcher_people").doc("staff_barbero").set(staffCleanProfile);
        console.log(`  ✔ Firestore (${dbId}): 'staff_barbero' guardado con ${cleanStaffPhotos.length} fotos y ${cleanStaffEmbeddings.length} vectores.`);
      } else {
        const currentDoc = await fb.db.collection("camera_catcher_people").doc("staff_barbero").get();
        console.log(`  [DRY-RUN] Firestore (${dbId}) actual tiene: ${currentDoc.data()?.photos?.length || 0} fotos.`);
      }
    } catch (err) {
      console.error(`  ❌ Error en Firestore (${dbId}):`, err.message);
    }
  }

  console.log(`\n================================================================`);
  console.log(`  ${apply ? "✅ PROCESO COMPLETADO EXITOSAMENTE" : "🔍 DRY-RUN COMPLETADO (Ejecuta con --apply para guardar)"}`);
  console.log(`================================================================`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
