/**
 * scripts/enrich-barber-angles.js
 * 
 * Enriquece la galería de 'staff_barbero' con las fotos y vectores de ángulos inclinados
 * (tilted_down, tilted_down_right, semi_right) para que el reconocimiento biométrico
 * lo identifique inequívocamente (similitud > 0.50) desde cualquier perspectiva cenital.
 * 
 * Actualiza:
 * 1. data/barberia.db (SQLite producción)
 * 2. data/experiments.db (SQLite experimentos)
 * 3. Firestore test y (default)
 */

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { initFirebaseAdmin } from "../src/infrastructure/firebase/firebase_admin.js";
import { extractFaceEmbedding, computeCosineSimilarity } from "../src/face_recognizer.js";
import { blobToVector, vectorToBlob } from "../src/infrastructure/storage/sqlite_client.js";

const PROJECT_ROOT = path.resolve(process.cwd());

async function main() {
  console.log("===============================================================");
  console.log("   💈 ENRIQUECIMIENTO DE ÁNGULOS CENITALES DEL BARBERO");
  console.log("===============================================================");

  const prodDbPath = path.join(PROJECT_ROOT, "data", "barberia.db");
  const expDbPath = path.join(PROJECT_ROOT, "data", "experiments.db");

  if (!fs.existsSync(prodDbPath)) {
    throw new Error(`No existe ${prodDbPath}`);
  }

  const prodDb = new Database(prodDbPath);
  const staffRow = prodDb.prepare("SELECT * FROM customers WHERE id = 'staff_barbero'").get();
  if (!staffRow) {
    throw new Error("No se encontró 'staff_barbero' en data/barberia.db");
  }

  let photos = JSON.parse(staffRow.photos_json || "[]");
  const existingEmbRows = prodDb.prepare("SELECT * FROM customer_embeddings WHERE customer_id = 'staff_barbero' ORDER BY embedding_index ASC").all();
  let vectors = existingEmbRows.map(r => blobToVector(r.embedding_blob));

  console.log(`[Estado Inicial] 'staff_barbero' tiene ${photos.length} fotos y ${vectors.length} vectores.`);

  // 1. Obtener fotos de la auditoría audit_appt_1792785397377_43.json
  const auditPath = path.join(PROJECT_ROOT, "data", "audit_reports", "audit_appt_1792785397377_43.json");
  if (fs.existsSync(auditPath)) {
    const auditData = JSON.parse(fs.readFileSync(auditPath, "utf8"));
    const candidatePhotos = auditData.photosAfterClose || auditData.photosBeforeClose || [];
    for (const p of candidatePhotos) {
      if (!p.thumbnailBase64) continue;
      const rawBase64 = p.thumbnailBase64.replace(/^data:image\/[a-z]+;base64,/, "");
      const buf = Buffer.from(rawBase64, "base64");
      const emb = await extractFaceEmbedding(buf);
      if (emb && emb.length === 512) {
        // Verificar duplicidad
        const isDup = vectors.some(v => computeCosineSimilarity(emb, v) >= 0.95);
        if (!isDup) {
          vectors.push(emb);
          photos.push({
            thumbnailBase64: p.thumbnailBase64,
            sharpnessScore: p.sharpnessScore || 50,
            capturedAt: new Date().toISOString(),
            pose: p.pose || "tilted_down_right",
            poseLabel: p.poseLabel || "Inclinado Abajo Derecha"
          });
          console.log(`  ➕ Foto agregada desde auditoría: pose=${p.pose}, score=${p.sharpnessScore}`);
        }
      }
    }
  }

  // 2. Extraer recortes representativos del barbero en experiments.db (segundos 16718 a 16735)
  if (fs.existsSync(expDbPath)) {
    const expDb = new Database(expDbPath);
    const barberCrops = expDb.prepare(`
      SELECT face_crop_blob, embedding_blob, sharpness_score, pose, pose_label 
      FROM harvested_crops 
      WHERE video_second BETWEEN 16718 AND 16735 AND face_detected = 1 AND face_crop_blob IS NOT NULL
      ORDER BY sharpness_score DESC 
      LIMIT 3
    `).all();

    for (const c of barberCrops) {
      const emb = c.embedding_blob ? blobToVector(c.embedding_blob) : null;
      if (emb && emb.length === 512) {
        const isDup = vectors.some(v => computeCosineSimilarity(emb, v) >= 0.92);
        if (!isDup) {
          vectors.push(emb);
          photos.push({
            thumbnailBase64: `data:image/jpeg;base64,${c.face_crop_blob.toString("base64")}`,
            sharpnessScore: c.sharpness_score || 46,
            capturedAt: new Date().toISOString(),
            pose: c.pose || "tilted_down_right",
            poseLabel: c.pose_label || "Inclinado Abajo Derecha"
          });
          console.log(`  ➕ Foto agregada desde harvested_crops: pose=${c.pose}, score=${c.sharpness_score}`);
        }
      }
    }
  }

  console.log(`[Estado Enriquecido] 'staff_barbero' cuenta ahora con ${photos.length} fotos y ${vectors.length} vectores.`);

  // 3. Persistir en data/barberia.db
  const updateProd = prodDb.transaction(() => {
    prodDb.prepare(`
      UPDATE customers 
      SET photos_json = ?, best_face_score = ?, thumbnail_base64 = ? 
      WHERE id = 'staff_barbero'
    `).run(
      JSON.stringify(photos),
      Math.max(...photos.map(p => p.sharpnessScore || 0)),
      photos[0]?.thumbnailBase64 || null
    );

    prodDb.prepare("DELETE FROM customer_embeddings WHERE customer_id = 'staff_barbero'").run();
    const insertEmb = prodDb.prepare(`
      INSERT INTO customer_embeddings (customer_id, embedding_index, embedding_blob, sharpness_score, pose, pose_label)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (let i = 0; i < vectors.length; i++) {
      insertEmb.run(
        'staff_barbero', 
        i, 
        vectorToBlob(vectors[i]), 
        photos[i]?.sharpnessScore || 50, 
        photos[i]?.pose || 'frontal', 
        photos[i]?.poseLabel || 'Frontal'
      );
    }
  });
  updateProd();
  console.log("  ✅ Actualizado en data/barberia.db.");

  // 4. Persistir en data/experiments.db
  if (fs.existsSync(expDbPath)) {
    const expDb = new Database(expDbPath);
    try {
      expDb.prepare(`
        UPDATE experiment_customers 
        SET photos_json = ?, best_face_score = ?, thumbnail_base64 = ? 
        WHERE id = 'staff_barbero'
      `).run(
        JSON.stringify(photos),
        Math.max(...photos.map(p => p.sharpnessScore || 0)),
        photos[0]?.thumbnailBase64 || null
      );

      expDb.prepare("DELETE FROM experiment_customer_embeddings WHERE customer_id = 'staff_barbero'").run();
      const insertEmbExp = expDb.prepare(`
        INSERT INTO experiment_customer_embeddings (customer_id, embedding_index, embedding_blob, sharpness_score, pose, pose_label)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (let i = 0; i < vectors.length; i++) {
        insertEmbExp.run(
          'staff_barbero', 
          i, 
          vectorToBlob(vectors[i]), 
          photos[i]?.sharpnessScore || 50, 
          photos[i]?.pose || 'frontal', 
          photos[i]?.poseLabel || 'Frontal'
        );
      }
      console.log("  ✅ Actualizado en data/experiments.db.");
    } catch (e) {
      console.warn("  ⚠️ Error menor en experiment_customers:", e.message);
    }
  }

  // 5. Persistir en Firestore test y (default)
  try {
    const testAdmin = initFirebaseAdmin({ databaseId: "test" });
    const staffData = {
      id: "staff_barbero",
      name: "Barbero",
      role: "barber",
      isStaff: true,
      status: "staff",
      bestFaceScore: Math.max(...photos.map(p => p.sharpnessScore || 0)),
      thumbnailBase64: photos[0]?.thumbnailBase64 || null,
      photos: photos,
      embeddings: vectors.map((v, i) => ({
        vector: v,
        pose: photos[i]?.pose || "frontal",
        poseLabel: photos[i]?.poseLabel || "Frontal"
      })),
      embedding: vectors[0] || null,
      lastSeen: new Date().toISOString()
    };

    await testAdmin.db.doc("camera_catcher_people/staff_barbero").set(staffData, { merge: true });
    console.log("  ✅ Sincronizado en Firestore [test]/camera_catcher_people/staff_barbero.");

    const defaultAdmin = initFirebaseAdmin({ databaseId: "(default)" });
    await defaultAdmin.db.doc("camera_catcher_people/staff_barbero").set(staffData, { merge: true });
    console.log("  ✅ Sincronizado en Firestore [(default)]/camera_catcher_people/staff_barbero.");
  } catch (fbErr) {
    console.warn("  ⚠️ Advertencia al sincronizar con Firestore:", fbErr.message);
  }

  console.log("===============================================================");
  console.log("   🎉 ENRIQUECIMIENTO COMPLETADO CON ÉXITO");
  console.log("===============================================================");
}

main().catch(err => {
  console.error("❌ Error enriqueciendo barbero:", err);
  process.exit(1);
});
