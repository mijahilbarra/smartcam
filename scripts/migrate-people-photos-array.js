/**
 * Script de Migración de Esquema: Unificación Canónica de Galería de Fotos y Embeddings
 * Colección: camera_catcher_people
 *
 * Regla 7 (Agent.md): Cero coexistencia de paradigmas.
 * Transforma perfiles que posean 'thumbnailBase64' y no 'photos' (o vacío)
 * en la estructura canónica 'photos: [{ thumbnailBase64, sharpnessScore, capturedAt }]'.
 * Garantiza que 'embeddings' sea un array de vectores.
 *
 * Uso:
 *   node scripts/migrate-people-photos-array.js
 *   node scripts/migrate-people-photos-array.js --database=test
 *   node scripts/migrate-people-photos-array.js --database="(default)"
 *   node scripts/migrate-people-photos-array.js --all
 */

import { initFirebaseAdmin } from "../src/infrastructure/firebase/firebase_admin.js";

const BATCH_CHUNK_SIZE = 400; // Límite seguro inferior al tope de 500 de Firestore

/**
 * Migra una colección de personas en la base de datos especificada.
 * @param {string} databaseId
 * @returns {Promise<{ total: number, updated: number, skipped: number }>}
 */
export async function migratePeopleCollection(databaseId) {
  console.log(`\n========================================================`);
  console.log(`🚀 Iniciando migración en Firestore [Database: ${databaseId}]`);
  console.log(`========================================================`);

  const { db } = initFirebaseAdmin({ databaseId });
  const peopleRef = db.collection("camera_catcher_people");
  const snapshot = await peopleRef.get();

  const total = snapshot.size;
  console.log(`[Migración] Documentos encontrados en 'camera_catcher_people': ${total}`);

  if (total === 0) {
    console.log(`[Migración] No hay documentos para procesar en ${databaseId}.`);
    return { total: 0, updated: 0, skipped: 0 };
  }

  const pendingUpdates = [];

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const updates = {};
    let needsUpdate = false;

    // 1. Unificación de galería de fotos
    const hasPhotosArray = Array.isArray(data.photos) && data.photos.length > 0;
    if (!hasPhotosArray) {
      if (data.thumbnailBase64) {
        updates.photos = [{
          thumbnailBase64: data.thumbnailBase64,
          sharpnessScore: data.bestFaceScore || 0,
          capturedAt: data.firstSeen || data.lastSeen || new Date().toISOString()
        }];
        needsUpdate = true;
      } else if (!Array.isArray(data.photos)) {
        updates.photos = [];
        needsUpdate = true;
      }
    }

    // 2. Garantizar que embeddings sea un array de vectores
    const hasEmbeddingsArray = Array.isArray(data.embeddings) && data.embeddings.length > 0;
    if (!hasEmbeddingsArray) {
      if (Array.isArray(data.embedding) && data.embedding.length > 0) {
        updates.embeddings = [data.embedding];
        needsUpdate = true;
      } else if (!Array.isArray(data.embeddings)) {
        updates.embeddings = [];
        needsUpdate = true;
      }
    }

    if (needsUpdate) {
      pendingUpdates.push({
        ref: doc.ref,
        id: doc.id,
        updates
      });
    }
  }

  const updatedCount = pendingUpdates.length;
  const skippedCount = total - updatedCount;

  console.log(`[Migración] Documentos a actualizar: ${updatedCount} | Ya conformes (omitidos): ${skippedCount}`);

  if (updatedCount === 0) {
    console.log(`✅ Colección en '${databaseId}' ya está completamente sincronizada con el esquema canónico.`);
    return { total, updated: 0, skipped: skippedCount };
  }

  // Ejecutar commits en batches de máximo 400 operaciones
  let committed = 0;
  for (let i = 0; i < pendingUpdates.length; i += BATCH_CHUNK_SIZE) {
    const chunk = pendingUpdates.slice(i, i + BATCH_CHUNK_SIZE);
    let batch = db.batch();

    for (const item of chunk) {
      batch.set(item.ref, item.updates, { merge: true });
    }

    try {
      await batch.commit();
    } catch (err) {
      if (err.message && err.message.includes("Nested arrays are not allowed")) {
        console.warn(`[Migración] Base de datos no admite matrices anidadas directas. Adaptando a [{ vector }] para compatibilidad nativa de Firestore...`);
        batch = db.batch();
        for (const item of chunk) {
          const adaptedUpdates = { ...item.updates };
          if (Array.isArray(adaptedUpdates.embeddings)) {
            adaptedUpdates.embeddings = adaptedUpdates.embeddings.map(e => Array.isArray(e) ? { vector: e } : e);
          }
          batch.set(item.ref, adaptedUpdates, { merge: true });
        }
        await batch.commit();
      } else {
        throw err;
      }
    }
    committed += chunk.length;
    console.log(`[Migración] Batch commit exitoso: ${committed}/${updatedCount} documentos actualizados.`);
  }

  console.log(`🎉 Migración en '${databaseId}' finalizada con éxito (${committed} documentos migrados).`);
  return { total, updated: committed, skipped: skippedCount };
}

async function run() {
  const args = process.argv.slice(2);
  let databasesToMigrate = [];

  const dbArg = args.find(a => a.startsWith("--database="));
  const allArg = args.includes("--all");

  if (allArg) {
    databasesToMigrate = ["test", "(default)"];
  } else if (dbArg) {
    const specifiedDb = dbArg.split("=")[1];
    databasesToMigrate = [specifiedDb];
  } else {
    // Por defecto migrar tanto 'test' como '(default)' para asegurar ambos entornos
    databasesToMigrate = ["test", "(default)"];
  }

  console.log(`[Migración] Bases de datos objetivo: ${databasesToMigrate.join(", ")}`);

  try {
    for (const dbId of databasesToMigrate) {
      await migratePeopleCollection(dbId);
    }
    console.log("\n✨ Todas las migraciones fueron ejecutadas satisfactoriamente.");
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Error durante la ejecución de la migración:", err);
    process.exit(1);
  }
}

// Ejecutar si es invocado directamente desde CLI
if (process.argv[1] && process.argv[1].endsWith("migrate-people-photos-array.js")) {
  run();
}
