/**
 * Script de Saneamiento y Registro de Barbero
 * 1. Extrae los 19 ángulos del Barbero capturados el 7/8 de octubre desde Firestore 'test' (person_1791245977179_1).
 * 2. Registra formalmente al Barbero en SQLite ('test' y '(default)') y Firestore ('test' y '(default)').
 * 3. Restaura el perfil de Cliente #141 con sus 20 fotos legítimas originales (preservadas en barberia.db).
 */

import { initFirebaseAdmin } from "../src/infrastructure/firebase/firebase_admin.js";
import { getSqliteClient, blobToVector } from "../src/infrastructure/storage/sqlite_client.js";
import Database from "better-sqlite3";

async function main() {
  console.log("=== INICIANDO SANEAMIENTO Y REGISTRO DE BARBERO ===");

  // 1. Obtener datos del Barbero desde Firestore test
  const fbTest = initFirebaseAdmin({ databaseId: "test" });
  const client141TestDoc = await fbTest.db.doc("camera_catcher_people/person_1791245977179_1").get();
  
  if (!client141TestDoc.exists) {
    throw new Error("No se encontró el documento de Cliente #141 en Firestore test.");
  }

  const client141TestData = client141TestDoc.data();
  console.log(`Leído Cliente #141 de Firestore test. Total fotos: ${client141TestData.photos?.length}, embeddings: ${client141TestData.embeddings?.length}`);

  // Filtrar fotos y embeddings del Barbero (las capturadas el 7/8 de octubre)
  const barberPhotos = [];
  const barberEmbeddings = [];

  const photos = client141TestData.photos || [];
  const embeddings = client141TestData.embeddings || [];

  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    // La foto 0 es el cliente original del 5 de octubre; las fotos 1 a 19 son del barbero
    if (i > 0 && p.capturedAt && (p.capturedAt.includes("2026-10-07") || p.capturedAt.includes("2026-10-08"))) {
      barberPhotos.push(p);
      if (embeddings[i]) {
        barberEmbeddings.push(embeddings[i]);
      }
    }
  }

  console.log(`-> Extraídas ${barberPhotos.length} fotos y ${barberEmbeddings.length} embeddings del Barbero.`);

  if (barberPhotos.length === 0) {
    throw new Error("No se encontraron fotos del Barbero en el perfil.");
  }

  // 2. Construir perfil formal del Barbero
  const barberProfile = {
    id: "staff_barbero",
    name: "Barbero",
    isStaff: true,
    role: "barber",
    firstSeen: barberPhotos[0]?.capturedAt || new Date().toISOString(),
    lastSeen: barberPhotos[barberPhotos.length - 1]?.capturedAt || new Date().toISOString(),
    visitCount: 1,
    bestFaceScore: Math.max(...barberPhotos.map(p => p.sharpnessScore || 0)),
    thumbnailBase64: barberPhotos[0]?.thumbnailBase64 || null,
    photos: barberPhotos,
    embeddings: barberEmbeddings,
    embedding: Array.isArray(barberEmbeddings[0]) ? barberEmbeddings[0] : (barberEmbeddings[0]?.vector || null)
  };

  // 3. Obtener fotos y embeddings legítimos del Cliente #141 desde data/barberia.db
  const prodSqlite = new Database("data/barberia.db");
  const cleanClientRow = prodSqlite.prepare("SELECT * FROM customers WHERE id = 'person_1791245977179_1'").get();
  const cleanEmbeddingsRows = prodSqlite.prepare("SELECT * FROM customer_embeddings WHERE customer_id = 'person_1791245977179_1' ORDER BY embedding_index ASC").all();

  const cleanPhotos = cleanClientRow ? JSON.parse(cleanClientRow.photos_json || "[]") : [photos[0]];
  const cleanEmbeddings = cleanEmbeddingsRows.map(r => ({ vector: blobToVector(r.embedding_blob) }));
  if (cleanEmbeddings.length === 0 && embeddings[0]) {
    cleanEmbeddings.push(embeddings[0]);
  }

  console.log(`-> Restaurando Cliente #141 con ${cleanPhotos.length} fotos legítimas del 5/6 de octubre.`);

  const restoredClient = {
    id: "person_1791245977179_1",
    name: "Cliente #141",
    isStaff: false,
    role: "client",
    firstSeen: cleanClientRow?.first_seen || cleanPhotos[0]?.capturedAt || "2026-10-06T00:19:37.179Z",
    lastSeen: cleanClientRow?.last_seen || cleanPhotos[cleanPhotos.length - 1]?.capturedAt || "2026-10-06T01:22:48.549Z",
    visitCount: cleanClientRow?.visit_count || 24,
    bestFaceScore: cleanClientRow?.best_face_score || 100,
    thumbnailBase64: cleanPhotos[0]?.thumbnailBase64 || null,
    photos: cleanPhotos,
    embeddings: cleanEmbeddings,
    embedding: cleanEmbeddings[0]?.vector || null
  };

  // 4. Guardar en SQLite ('test' y '(default)')
  for (const envId of ["test", "(default)"]) {
    console.log(`\n--- Actualizando SQLite para entorno '${envId}' ---`);
    const sqliteClient = getSqliteClient(envId);

    // Guardar Barbero
    sqliteClient.upsertCustomer(barberProfile);
    console.log(`✔ Barbero registrado en SQLite '${envId}' (is_staff = 1, ${barberPhotos.length} fotos, ${barberEmbeddings.length} embeddings).`);

    // Restaurar Cliente #141
    sqliteClient.upsertCustomer(restoredClient);
    console.log(`✔ Cliente #141 restaurado en SQLite '${envId}' (${cleanPhotos.length} fotos legítimas).`);
  }

  // 5. Guardar en Firestore ('test' y '(default)')
  for (const envId of ["test", "(default)"]) {
    console.log(`\n--- Actualizando Firestore para entorno '${envId}' ---`);
    const { db } = initFirebaseAdmin({ databaseId: envId });

    // Guardar Barbero en camera_catcher_people
    await db.doc("camera_catcher_people/staff_barbero").set(barberProfile);
    console.log(`✔ Barbero guardado en Firestore '${envId}'/camera_catcher_people/staff_barbero.`);

    // Guardar en camera_catcher/staff
    await db.doc("camera_catcher/staff").set({
      members: [{
        id: barberProfile.id,
        name: barberProfile.name,
        role: barberProfile.role,
        isStaff: true,
        bestFaceScore: barberProfile.bestFaceScore,
        thumbnailBase64: barberProfile.thumbnailBase64,
        embedding: barberProfile.embedding,
        embeddings: barberProfile.embeddings,
        photos: barberProfile.photos
      }]
    });
    console.log(`✔ Barbero registrado en Firestore '${envId}'/camera_catcher/staff.`);

    // Restaurar Cliente #141 en camera_catcher_people
    await db.doc("camera_catcher_people/person_1791245977179_1").set(restoredClient);
    console.log(`✔ Cliente #141 restaurado en Firestore '${envId}'/camera_catcher_people/person_1791245977179_1.`);
  }

  console.log("\n🎉 ¡SANEAMIENTO COMPLETADO EXITOSAMENTE!");
}

main().catch(err => {
  console.error("Error en saneamiento:", err);
  process.exit(1);
});
