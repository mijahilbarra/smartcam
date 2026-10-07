/**
 * Script de Migración de Clientes y Embeddings desde Firestore hacia SQLite
 *
 * Sigue las Reglas de Oro de Agent.md:
 * - Paridad total de entornos ('test' y '(default)')
 * - Persistencia local transaccional rápida en SQLite (better-sqlite3 en modo WAL)
 * - Serialización binaria de Float32Array para embeddings (512-dim ArcFace MobileFaceNet)
 * - Preservación íntegra de metadatos (fotos, miniaturas, sharpnessScore, visitCount, lastSeen, staff)
 *
 * Uso:
 *   node scripts/migrate-to-sqlite.js
 *   node scripts/migrate-to-sqlite.js --database=test
 *   node scripts/migrate-to-sqlite.js --database="(default)"
 *   npm run migrate:sqlite -- --database=test
 */

import net from "node:net";
if (net.setDefaultAutoSelectFamily) {
  net.setDefaultAutoSelectFamily(false);
}

import fs from "fs";
import { performance } from "perf_hooks";
import { initFirebaseAdmin } from "../src/infrastructure/firebase/firebase_admin.js";
import { getSqliteClient } from "../src/infrastructure/storage/sqlite_client.js";

/**
 * Parsea el parámetro --database o toma 'test' por defecto en local
 * @returns {string}
 */
export function parseCommandLineDatabaseId() {
  const args = process.argv.slice(2);
  const dbArg = args.find(a => a.startsWith("--database="));
  if (dbArg) {
    const rawVal = dbArg.split("=")[1];
    return rawVal.replace(/^["']|["']$/g, "").trim();
  }
  return "test";
}

/**
 * Normaliza y extrae los embeddings de un documento de Firestore
 * Soporta arrays directos [0.1, ...], subobjetos { vector: [...], sharpnessScore: ... }
 * y extrae la nitidez correspondiente desde fotos o metadatos del cliente.
 *
 * @param {Object} data
 * @param {number} fallbackScore
 * @param {Array} photos
 * @returns {Array<{ index: number, vector: Array<number>, sharpnessScore: number }>}
 */
export function extractAndNormalizeEmbeddings(data, fallbackScore = 0, photos = []) {
  let rawList = [];
  if (Array.isArray(data.embeddings) && data.embeddings.length > 0) {
    rawList = data.embeddings;
  } else if (Array.isArray(data.embedding) && data.embedding.length > 0) {
    rawList = [data.embedding];
  }

  const normalized = [];

  for (let idx = 0; idx < rawList.length; idx++) {
    const item = rawList[idx];
    let vector = null;
    let sharpnessScore = fallbackScore || 0;

    if (Array.isArray(item)) {
      vector = item;
      if (photos[idx] && typeof photos[idx].sharpnessScore === "number") {
        sharpnessScore = photos[idx].sharpnessScore;
      }
    } else if (item && typeof item === "object") {
      if (Array.isArray(item.vector)) {
        vector = item.vector;
      }
      if (typeof item.sharpnessScore === "number") {
        sharpnessScore = item.sharpnessScore;
      } else if (photos[idx] && typeof photos[idx].sharpnessScore === "number") {
        sharpnessScore = photos[idx].sharpnessScore;
      }
    }

    if (vector && vector.length > 0) {
      normalized.push({
        index: idx,
        vector,
        sharpnessScore: Number(sharpnessScore || 0)
      });
    }
  }

  return normalized;
}

/**
 * Ejecuta la migración de Firestore hacia SQLite para la base de datos especificada
 * @param {string} [targetDatabaseId]
 * @returns {Promise<{
 *   databaseId: string,
 *   dbPath: string,
 *   totalRead: number,
 *   totalMigrated: number,
 *   staffMigrated: number,
 *   embeddingsSaved: number,
 *   elapsedMs: number,
 *   fileSizeBytes: number
 * }>}
 */
export async function migrateFirestoreToSqlite(targetDatabaseId) {
  const databaseId = targetDatabaseId || parseCommandLineDatabaseId();
  const startTime = performance.now();

  console.log(`\n============================================================`);
  console.log(`🚀 Iniciando Migración Firestore -> SQLite`);
  console.log(`   Base de Datos Firestore: "${databaseId}"`);
  console.log(`============================================================\n`);

  // 1. Conexión a Firestore
  const { db } = initFirebaseAdmin({ databaseId });

  // 2. Obtener cliente SQLite para ese databaseId
  const sqliteClient = getSqliteClient(databaseId);
  const dbPath = sqliteClient.dbPath;
  console.log(`[SQLite] Conectado a la base local: ${dbPath}`);

  // 3. Obtener colección camera_catcher_people de Firestore
  console.log(`[Firestore] Leyendo colección 'camera_catcher_people' en '${databaseId}'...`);
  const snapshot = await db.collection("camera_catcher_people").get();
  const totalRead = snapshot.size;
  console.log(`[Firestore] Documentos encontrados: ${totalRead}`);

  const preparedPeople = [];

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const photos = Array.isArray(data.photos) ? data.photos : [];
    const bestFaceScore = typeof data.bestFaceScore === "number" ? data.bestFaceScore : 0;
    const visitCount = typeof data.visitCount === "number" ? data.visitCount : 1;
    const embeddings = extractAndNormalizeEmbeddings(data, bestFaceScore, photos);

    preparedPeople.push({
      customer: {
        id: doc.id,
        name: data.name || "Cliente",
        isStaff: Boolean(data.isStaff),
        role: data.role || (data.isStaff ? "barber" : "client"),
        firstSeen: data.firstSeen || null,
        lastSeen: data.lastSeen || new Date().toISOString(),
        visitCount,
        bestFaceScore,
        thumbnailBase64: data.thumbnailBase64 || (photos[0]?.thumbnailBase64 || null),
        thumbnailPath: data.thumbnailPath || null,
        photos,
        // Proporcionar lista limpia de vectores para que upsertCustomer mantenga paridad
        embeddings: embeddings.map(e => ({ vector: e.vector, sharpnessScore: e.sharpnessScore }))
      },
      embeddings
    });
  }

  // 4. Leer miembros de camera_catcher/staff si existen y tienen embeddings
  console.log(`[Firestore] Comprobando documento de staff 'camera_catcher/staff'...`);
  const preparedStaff = [];
  try {
    const staffDoc = await db.doc("camera_catcher/staff").get();
    if (staffDoc && staffDoc.exists) {
      const staffData = staffDoc.data();
      const members = Array.isArray(staffData?.members) ? staffData.members : [];
      console.log(`[Firestore] Miembros en staff: ${members.length}`);

      for (const member of members) {
        const staffPhotos = Array.isArray(member.photos) ? member.photos : [];
        const staffBestScore = typeof member.bestFaceScore === "number" ? member.bestFaceScore : 0;
        const embeddings = extractAndNormalizeEmbeddings(member, staffBestScore, staffPhotos);

        if (embeddings.length > 0) {
          const staffId = member.id || `staff_${(member.name || "member").toLowerCase().replace(/\s+/g, "_")}`;
          preparedStaff.push({
            customer: {
              id: staffId,
              name: member.name || "Staff",
              isStaff: true,
              role: member.role || "barber",
              firstSeen: member.firstSeen || null,
              lastSeen: member.lastSeen || new Date().toISOString(),
              visitCount: typeof member.visitCount === "number" ? member.visitCount : 1,
              bestFaceScore: staffBestScore,
              thumbnailBase64: member.thumbnailBase64 || (staffPhotos[0]?.thumbnailBase64 || null),
              thumbnailPath: member.thumbnailPath || null,
              photos: staffPhotos,
              embeddings: embeddings.map(e => ({ vector: e.vector, sharpnessScore: e.sharpnessScore }))
            },
            embeddings
          });
        }
      }
    } else {
      console.log(`[Firestore] Documento 'camera_catcher/staff' no existe o está vacío en '${databaseId}'.`);
    }
  } catch (staffErr) {
    console.warn(`[Firestore] Aviso al consultar staff: ${staffErr.message}`);
  }

  // 5. Realizar la migración en una transacción SQLite rápida y segura
  console.log(`\n[SQLite] Ejecutando transacción atómica de migración...`);
  let totalMigrated = 0;
  let staffMigrated = 0;
  let embeddingsSaved = 0;

  const migrationTx = sqliteClient.db.transaction(() => {
    // Migrar personas
    for (const item of preparedPeople) {
      sqliteClient.upsertCustomer(item.customer);
      for (const emb of item.embeddings) {
        sqliteClient.saveEmbedding(item.customer.id, emb.index, emb.vector, emb.sharpnessScore);
        embeddingsSaved++;
      }
      totalMigrated++;
    }

    // Migrar staff
    for (const item of preparedStaff) {
      sqliteClient.upsertCustomer(item.customer);
      for (const emb of item.embeddings) {
        sqliteClient.saveEmbedding(item.customer.id, emb.index, emb.vector, emb.sharpnessScore);
        embeddingsSaved++;
      }
      staffMigrated++;
    }
  });

  migrationTx();

  const elapsedMs = Math.round(performance.now() - startTime);

  // Obtener tamaño final del archivo SQLite en disco
  let fileSizeBytes = 0;
  if (fs.existsSync(dbPath)) {
    fileSizeBytes = fs.statSync(dbPath).size;
  }
  const fileSizeKb = (fileSizeBytes / 1024).toFixed(2);

  console.log(`\n============================================================`);
  console.log(`📊 RESUMEN DETALLADO DE MIGRACIÓN`);
  console.log(`============================================================`);
  console.log(`• Base de datos Firestore origen:   ${databaseId}`);
  console.log(`• Archivo SQLite destino:          ${dbPath}`);
  console.log(`• Tamaño de la base de datos:       ${fileSizeKb} KB (${fileSizeBytes} bytes)`);
  console.log(`• Clientes leídos en Firestore:     ${totalRead}`);
  console.log(`• Clientes migrados a SQLite:       ${totalMigrated}`);
  console.log(`• Miembros de staff migrados:       ${staffMigrated}`);
  console.log(`• Total entidades almacenadas:      ${totalMigrated + staffMigrated}`);
  console.log(`• Embeddings biométricos guardados: ${embeddingsSaved}`);
  console.log(`• Tiempo total transcurrido:        ${elapsedMs} ms`);
  console.log(`============================================================\n`);

  return {
    databaseId,
    dbPath,
    totalRead,
    totalMigrated,
    staffMigrated,
    embeddingsSaved,
    elapsedMs,
    fileSizeBytes
  };
}

// Ejecutar automáticamente si es invocado directamente desde CLI
if (process.argv[1] && process.argv[1].endsWith("migrate-to-sqlite.js")) {
  migrateFirestoreToSqlite()
    .then(() => {
      console.log("✅ Proceso de migración finalizado exitosamente.");
      process.exit(0);
    })
    .catch((err) => {
      console.error("\n❌ Error crítico durante la migración a SQLite:", err);
      process.exit(1);
    });
}
