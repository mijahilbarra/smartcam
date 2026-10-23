import path from "path";
import Database from "better-sqlite3";
import { initFirebaseAdmin } from "../src/infrastructure/firebase/firebase_admin.js";
import { blobToVector } from "../src/infrastructure/storage/sqlite_client.js";

const PROJECT_ROOT = process.cwd();

async function cleanFirestoreTest() {
  console.log("==================================================");
  console.log("[Firestore] 🧹 Iniciando limpieza de base de datos 'test'...");
  console.log("==================================================");

  // Forzar USE_FIREBASE=true
  process.env.USE_FIREBASE = "true";
  process.env.IS_LOCAL_SIMULATOR = "false";

  const { db } = initFirebaseAdmin({ databaseId: "test" });
  if (!db) {
    throw new Error("No se pudo inicializar Firestore test");
  }

  // 1. Limpiar camera_catcher_appointments
  const apptsSnap = await db.collection("camera_catcher_appointments").get();
  console.log(`[Firestore test] Documentos en camera_catcher_appointments: ${apptsSnap.size}`);
  let batch = db.batch();
  let count = 0;
  for (const doc of apptsSnap.docs) {
    batch.delete(doc.ref);
    count++;
    if (count % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (count % 400 !== 0) {
    await batch.commit();
  }
  console.log(`[Firestore test] ✅ Eliminadas ${count} citas en camera_catcher_appointments.`);

  // 2. Limpiar camera_catcher_visits
  const visitsSnap = await db.collection("camera_catcher_visits").get();
  console.log(`[Firestore test] Documentos en camera_catcher_visits: ${visitsSnap.size}`);
  batch = db.batch();
  count = 0;
  for (const doc of visitsSnap.docs) {
    batch.delete(doc.ref);
    count++;
    if (count % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (count % 400 !== 0) {
    await batch.commit();
  }
  console.log(`[Firestore test] ✅ Eliminadas ${count} visitas en camera_catcher_visits.`);

  // 3. Limpiar camera_catcher_people (excepto staff_barbero)
  const peopleSnap = await db.collection("camera_catcher_people").get();
  console.log(`[Firestore test] Documentos en camera_catcher_people: ${peopleSnap.size}`);
  batch = db.batch();
  count = 0;
  for (const doc of peopleSnap.docs) {
    if (doc.id !== "staff_barbero") {
      batch.delete(doc.ref);
      count++;
      if (count % 400 === 0) {
        await batch.commit();
        batch = db.batch();
      }
    }
  }
  if (count % 400 !== 0) {
    await batch.commit();
  }
  console.log(`[Firestore test] ✅ Eliminados ${count} clientes en camera_catcher_people (staff_barbero protegido).`);

  // 4. Sincronizar staff_barbero con las 22 fotos/embeddings de SQLite prod a Firestore test Y (default)
  const prodSqlitePath = path.join(PROJECT_ROOT, "data", "barberia.db");
  const prodDb = new Database(prodSqlitePath, { readonly: true });
  const staffRow = prodDb.prepare("SELECT * FROM customers WHERE id = 'staff_barbero'").get();
  if (staffRow) {
    const embRows = prodDb.prepare("SELECT * FROM customer_embeddings WHERE customer_id = 'staff_barbero' ORDER BY embedding_index ASC").all();
    const vectors = embRows.map(r => ({
      vector: blobToVector(r.embedding_blob),
      pose: r.pose || "frontal",
      poseLabel: r.pose_label || "Frontal",
      sharpnessScore: r.sharpness_score || 0
    })).filter(e => Array.isArray(e.vector));

    const photos = staffRow.photos_json ? JSON.parse(staffRow.photos_json) : [];

    const staffData = {
      id: "staff_barbero",
      name: staffRow.name || "Barbero",
      isStaff: true,
      role: staffRow.role || "barber",
      status: "verified",
      photos: photos,
      embeddings: vectors,
      embedding: vectors[0]?.vector || null,
      thumbnailBase64: staffRow.thumbnail_base64 || null,
      updatedAt: new Date().toISOString()
    };

    // Escribir a test
    await db.doc("camera_catcher_people/staff_barbero").set(staffData, { merge: true });
    console.log(`[Firestore test] 👤 Staff 'staff_barbero' actualizado con ${vectors.length} embeddings y ${photos.length} fotos.`);

    // Sincronizar también a (default) como solicitó el usuario
    try {
      const { db: defaultDb } = initFirebaseAdmin({ databaseId: "(default)" });
      if (defaultDb) {
        await defaultDb.doc("camera_catcher_people/staff_barbero").set(staffData, { merge: true });
        console.log(`[Firestore (default)] 👤 Staff 'staff_barbero' sincronizado con ${vectors.length} embeddings y ${photos.length} fotos.`);
      }
    } catch (defErr) {
      console.warn("[Firestore (default)] Aviso al sincronizar staff en (default):", defErr.message);
    }
  }
  prodDb.close();

  console.log("==================================================");
  console.log("[Firestore] ✨ Base de datos 'test' completamente lista e impecable.");
  console.log("==================================================");
}

cleanFirestoreTest()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error limpiando Firestore test:", err);
    process.exit(1);
  });
