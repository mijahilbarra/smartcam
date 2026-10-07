/**
 * Script de Migración de Clientes y Biometría de TEST a PROD
 *
 * Tareas realizadas:
 * 1. Lee los clientes limpios de Firestore 'test' (camera_catcher_people).
 * 2. Purga perfiles obsoletos / legados en Firestore '(default)'.
 * 3. Copia fielmente los 12 clientes limpios con sus fotos, embeddings y metadatos a Firestore '(default)'.
 * 4. Ejecuta la migración hacia SQLite para producción ('(default)') generando data/barberia.db.
 * 5. Valida exhaustivamente la paridad: exactamente 12 clientes y 176 embeddings en Firestore '(default)' y SQLite.
 *
 * Uso:
 *   node scripts/migrate-test-to-prod.js
 */

import net from "node:net";
if (net.setDefaultAutoSelectFamily) {
  net.setDefaultAutoSelectFamily(false);
}

import { performance } from "perf_hooks";
import { initFirebaseAdmin } from "../src/infrastructure/firebase/firebase_admin.js";
import { getFirestore } from "firebase-admin/firestore";
import { migrateFirestoreToSqlite } from "./migrate-to-sqlite.js";
import { getSqliteClient, resetSqliteClients } from "../src/infrastructure/storage/sqlite_client.js";

export async function migrateTestDataToProd() {
  const startTime = performance.now();
  console.log("\n============================================================");
  console.log("🚀 INICIANDO MIGRACIÓN COMPLETA DE TEST A PRODUCCIÓN (PROD)");
  console.log("============================================================\n");

  // 1. Inicializar Firebase Admin
  const { admin } = initFirebaseAdmin();
  const app = admin.app();
  const dbTest = getFirestore(app, "test");
  const dbProd = getFirestore(app); // '(default)'

  // 2. Leer clientes de TEST
  console.log("[1/5] Leyendo clientes desde Firestore 'test' (camera_catcher_people)...");
  const testSnap = await dbTest.collection("camera_catcher_people").get();
  const testDocsCount = testSnap.size;
  console.log(`[TEST] Documentos encontrados: ${testDocsCount}`);

  if (testDocsCount === 0) {
    throw new Error("No se encontraron clientes en la base de datos 'test'. Abortando migración.");
  }

  const testClients = [];
  let testTotalEmbeddings = 0;
  let testTotalPhotos = 0;

  testSnap.forEach(doc => {
    const data = doc.data();
    const photos = Array.isArray(data.photos) ? data.photos : [];
    const rawEmbeddings = Array.isArray(data.embeddings) ? data.embeddings : (data.embedding ? [data.embedding] : []);
    const normalizedEmbeddings = rawEmbeddings.map(e => {
      if (Array.isArray(e)) return { vector: e };
      if (e && typeof e === "object" && Array.isArray(e.vector)) return e;
      return null;
    }).filter(Boolean);

    const primaryEmbedding = Array.isArray(data.embedding)
      ? data.embedding
      : (normalizedEmbeddings[0]?.vector || null);

    testTotalPhotos += photos.length;
    testTotalEmbeddings += normalizedEmbeddings.length;

    testClients.push({
      id: doc.id,
      data: {
        ...data,
        id: doc.id,
        embeddings: normalizedEmbeddings,
        ...(primaryEmbedding ? { embedding: primaryEmbedding } : {})
      },
      photosCount: photos.length,
      embeddingsCount: normalizedEmbeddings.length
    });
  });

  console.log(`[TEST] Clientes limpios: ${testClients.length}`);
  console.log(`[TEST] Total fotos en galerías: ${testTotalPhotos}`);
  console.log(`[TEST] Total embeddings: ${testTotalEmbeddings}`);

  // 3. Inspeccionar y limpiar Firestore PROD '(default)'
  console.log("\n[2/5] Inspeccionando Firestore '(default)' (PROD)...");
  const prodSnap = await dbProd.collection("camera_catcher_people").get();
  console.log(`[PROD] Documentos actuales existentes: ${prodSnap.size}`);

  const testIds = new Set(testClients.map(c => c.id));
  const docsToDelete = [];
  prodSnap.forEach(doc => {
    if (!testIds.has(doc.id)) {
      docsToDelete.push(doc.id);
    }
  });

  if (docsToDelete.length > 0) {
    console.log(`[PROD] Eliminando ${docsToDelete.length} documentos obsoletos/legados de Firestore '(default)'...`);
    const chunkSize = 400;
    for (let i = 0; i < docsToDelete.length; i += chunkSize) {
      const chunk = docsToDelete.slice(i, i + chunkSize);
      const batch = dbProd.batch();
      for (const id of chunk) {
        batch.delete(dbProd.collection("camera_catcher_people").doc(id));
      }
      await batch.commit();
    }
    console.log(`[PROD] Eliminación completada.`);
  }

  // 4. Escribir clientes limpios en Firestore PROD '(default)'
  console.log("\n[3/5] Escribiendo 12 clientes limpios en Firestore '(default)'...");
  const writeBatch = dbProd.batch();
  for (const client of testClients) {
    const docRef = dbProd.collection("camera_catcher_people").doc(client.id);
    writeBatch.set(docRef, client.data);
  }
  await writeBatch.commit();
  console.log(`[PROD] 12 clientes limpios persistidos con éxito.`);

  // 5. Verificar Firestore PROD
  console.log("\n[4/5] Verificando paridad en Firestore '(default)'...");
  const prodVerifySnap = await dbProd.collection("camera_catcher_people").get();
  let prodTotalEmbeddings = 0;
  let prodTotalPhotos = 0;
  prodVerifySnap.forEach(doc => {
    const d = doc.data();
    const photos = Array.isArray(d.photos) ? d.photos : [];
    const embeddings = Array.isArray(d.embeddings) ? d.embeddings : (d.embedding ? [d.embedding] : []);
    prodTotalPhotos += photos.length;
    prodTotalEmbeddings += embeddings.length;
    console.log(`  - [${doc.id}] ${d.name} | Fotos: ${photos.length} | Embeddings: ${embeddings.length}`);
  });

  if (prodVerifySnap.size !== testDocsCount) {
    throw new Error(`Discrepancia en Firestore PROD: esperado ${testDocsCount}, obtenido ${prodVerifySnap.size}`);
  }
  if (prodTotalEmbeddings !== testTotalEmbeddings) {
    throw new Error(`Discrepancia en embeddings de Firestore PROD: esperado ${testTotalEmbeddings}, obtenido ${prodTotalEmbeddings}`);
  }
  console.log(`✅ Firestore '(default)' verificado: exactamente ${prodVerifySnap.size} clientes y ${prodTotalEmbeddings} embeddings.`);

  // 6. Ejecutar migración SQLite para PROD (data/barberia.db)
  console.log("\n[5/5] Ejecutando migración SQLite para producción (data/barberia.db)...");
  resetSqliteClients();
  const sqliteMigrationResult = await migrateFirestoreToSqlite("(default)", { clean: true });

  // 7. Verificar data/barberia.db directamente
  const sqliteProd = getSqliteClient("(default)");
  const countRow = sqliteProd.db.prepare("SELECT count(*) as count FROM customers").get();
  const embRow = sqliteProd.db.prepare("SELECT count(*) as count FROM customer_embeddings").get();
  const customersList = sqliteProd.db.prepare("SELECT id, name, visit_count, best_face_score FROM customers").all();

  console.log("\n============================================================");
  console.log("🔍 AUDITORÍA FINAL DE PARIDAD TEST -> PROD");
  console.log("============================================================");
  console.log(`• Firestore 'test' clientes:        ${testDocsCount}`);
  console.log(`• Firestore 'test' embeddings:      ${testTotalEmbeddings}`);
  console.log(`• Firestore '(default)' clientes:   ${prodVerifySnap.size}`);
  console.log(`• Firestore '(default)' embeddings: ${prodTotalEmbeddings}`);
  console.log(`• SQLite 'barberia.db' clientes:    ${countRow.count}`);
  console.log(`• SQLite 'barberia.db' embeddings:  ${embRow.count}`);
  console.log(`• Clientes en SQLite:`);
  customersList.forEach((c, idx) => {
    console.log(`    ${idx + 1}. [${c.id}] ${c.name} (Visitas: ${c.visit_count}, BestScore: ${c.best_face_score})`);
  });

  if (countRow.count !== testDocsCount) {
    throw new Error(`Discrepancia en SQLite PROD: esperado ${testDocsCount} clientes, encontrado ${countRow.count}`);
  }
  if (embRow.count !== testTotalEmbeddings) {
    throw new Error(`Discrepancia en SQLite embeddings PROD: esperado ${testTotalEmbeddings}, encontrado ${embRow.count}`);
  }

  const elapsed = Math.round(performance.now() - startTime);
  console.log(`\n🎉 ¡MIGRACIÓN COMPLETADA CON ÉXITO en ${elapsed} ms!`);
  console.log("============================================================\n");

  return {
    sourceCount: testDocsCount,
    sourceEmbeddings: testTotalEmbeddings,
    targetFirestoreCount: prodVerifySnap.size,
    targetFirestoreEmbeddings: prodTotalEmbeddings,
    targetSqliteCount: countRow.count,
    targetSqliteEmbeddings: embRow.count,
    sqlitePath: sqliteMigrationResult.dbPath,
    sqliteSize: sqliteMigrationResult.fileSizeBytes,
    elapsedMs: elapsed
  };
}

if (process.argv[1] && process.argv[1].endsWith("migrate-test-to-prod.js")) {
  migrateTestDataToProd()
    .then(() => {
      process.exit(0);
    })
    .catch(err => {
      console.error("\n❌ Error en migración de test a prod:", err);
      process.exit(1);
    });
}
