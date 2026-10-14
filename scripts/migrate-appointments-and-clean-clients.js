/**
 * Script de Purga y Saneamiento Integral:
 * - Depura atenciones fantasma (< 10 min, 0 fotos, sin cliente identificado, o en confirmación)
 * - Sanea y deduplica fotos dentro de las atenciones legítimas (elimina las 15+ fotos repetidas)
 * - Registra formalmente al Barbero real con sus fotos y embeddings en staff_barbero
 * - Purgar perfiles falsos creados a partir del barbero (similitud >= 0.46)
 * - Recalcula appointmentCount real para cada cliente legítimo
 *
 * Uso:
 *   node scripts/migrate-appointments-and-clean-clients.js --dry-run
 *   node scripts/migrate-appointments-and-clean-clients.js --apply --database=test
 *   node scripts/migrate-appointments-and-clean-clients.js --apply --all-databases
 *   node scripts/migrate-appointments-and-clean-clients.js --database="(default)" --apply
 */

import { initFirebaseAdmin } from "../src/infrastructure/firebase/firebase_admin.js";
import { getSqliteClient, blobToVector } from "../src/infrastructure/storage/sqlite_client.js";
import { computeCosineSimilarity } from "../src/face_recognizer.js";
import Database from "better-sqlite3";
import fs from "fs";

function parseArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run") || !apply;

  let databaseId = "test";
  const dbArg = args.find(a => a.startsWith("--database="));
  if (dbArg) {
    databaseId = dbArg.split("=")[1].replace(/^["']|["']$/g, "").trim();
  }

  const allDatabases = args.includes("--all-databases");
  return { apply, dryRun, databaseId, allDatabases };
}

function isValidPhoto(p) {
  if (!p) return false;
  if (typeof p === "string" && (p.startsWith("data:image/") || p.startsWith("http"))) return true;
  const thumb = p.thumbnailBase64 || p.base64 || p.url;
  if (typeof thumb === "string" && (thumb.startsWith("data:image/") || thumb.startsWith("http"))) return true;
  if (p.thumbnailPath && typeof p.thumbnailPath === "string" && p.thumbnailPath.length > 5) return true;
  return false;
}

function getPhotoThumb(p) {
  if (!p) return "";
  if (typeof p === "string") return p;
  return p.thumbnailBase64 || p.base64 || p.url || "";
}

async function runCleanup() {
  const { apply, dryRun, databaseId, allDatabases } = parseArgs();

  console.log("=============================================================");
  console.log("✂️  Purga y Saneamiento Integral de Atenciones, Barbero y Clientes");
  console.log(`   Modo: ${dryRun ? "🔍 DRY-RUN (Simulación sin cambios)" : "⚡ APPLY (Escritura real activada)"}`);
  console.log("=============================================================\n");

  // Obtener perfil oficial del Barbero prioritariamente desde data/barberia.db (20 fotos legítimas)
  let realBarberPhotos = [];
  let realBarberEmbeddings = [];
  try {
    if (fs.existsSync("data/barberia.db")) {
      const prodDb = new Database("data/barberia.db");
      const staffRow = prodDb.prepare("SELECT * FROM customers WHERE id = 'staff_barbero'").get();
      const staffEmbRows = prodDb.prepare("SELECT * FROM customer_embeddings WHERE customer_id = 'staff_barbero' ORDER BY embedding_index ASC").all();
      if (staffRow) {
        realBarberPhotos = JSON.parse(staffRow.photos_json || "[]");
        realBarberEmbeddings = staffEmbRows.map(r => ({ vector: blobToVector(r.embedding_blob) }));
        console.log(`💈 Perfil del verdadero Barbero recuperado desde 'data/barberia.db': ${realBarberPhotos.length} fotos, ${realBarberEmbeddings.length} embeddings.`);
      }
      prodDb.close();
    }
  } catch (e) {
    console.warn(`[BarberBootstrap] Aviso leyendo perfil base de data/barberia.db:`, e.message);
  }

  const targets = allDatabases ? ["(default)", "test"] : [databaseId];

  for (const dbId of targets) {
    console.log(`\n-------------------------------------------------------------`);
    console.log(`📂 Procesando Base de Datos: "${dbId}"`);
    console.log(`-------------------------------------------------------------`);

    const sqliteClient = getSqliteClient(dbId);
    let firestoreDb = null;
    try {
      const fb = initFirebaseAdmin({ databaseId: dbId });
      firestoreDb = fb.db;
      console.log(`[Firestore] Conectado a base '${dbId}'`);
    } catch (err) {
      console.warn(`[Firestore] No se pudo conectar a Firebase para '${dbId}':`, err.message);
    }

    // 0. Preparar vectores del Barbero para exclusión y detección de contaminación
    const staffVectors = [];
    for (const e of realBarberEmbeddings) {
      const v = Array.isArray(e) ? e : (e?.vector || null);
      if (v) staffVectors.push(v);
    }

    // Complementar con staff_barbero local en SQLite si existe
    const localSqliteProfiles = sqliteClient.getAllComparisonProfiles ? sqliteClient.getAllComparisonProfiles() : [];
    const localSqliteStaff = localSqliteProfiles.find(p => p.id === "staff_barbero" || p.isStaff);
    if (localSqliteStaff?.embeddings) {
      for (const e of localSqliteStaff.embeddings) {
        const v = Array.isArray(e) ? e : (e?.vector || null);
        if (v && !staffVectors.some(sv => computeCosineSimilarity(v, sv) > 0.999)) {
          staffVectors.push(v);
        }
      }
    }
    if (localSqliteStaff?.photos && realBarberPhotos.length === 0) {
      realBarberPhotos = localSqliteStaff.photos.filter(isValidPhoto);
    }

    // Complementar con staff_barbero local en Firestore si existe
    if (firestoreDb) {
      try {
        const snapLocalStaff = await firestoreDb.collection("camera_catcher_people").doc("staff_barbero").get();
        if (snapLocalStaff.exists) {
          const d = snapLocalStaff.data();
          if (Array.isArray(d.embeddings)) {
            for (const e of d.embeddings) {
              const v = Array.isArray(e) ? e : (e?.vector || null);
              if (v && !staffVectors.some(sv => computeCosineSimilarity(v, sv) > 0.999)) {
                staffVectors.push(v);
              }
            }
          }
          if (Array.isArray(d.photos) && realBarberPhotos.length === 0) {
            realBarberPhotos = d.photos.filter(isValidPhoto);
          }
        }
      } catch (_) {}
    }

    console.log(`💈 [Staff / Barbero] Base de vectores cargada: ${staffVectors.length} vectores para detección del barbero.`);

    // Función de cálculo de similitud máxima con el Barbero
    const computeBarberSimilarity = (emb) => {
      if (!emb || staffVectors.length === 0) return 0;
      const v = Array.isArray(emb) ? emb : (emb?.vector || null);
      if (!v) return 0;
      let maxSim = 0;
      for (const sv of staffVectors) {
        const sim = computeCosineSimilarity(v, sv);
        if (sim > maxSim) maxSim = sim;
      }
      return maxSim;
    };

    const officialBarberProfile = {
      id: "staff_barbero",
      name: "Barbero",
      isStaff: true,
      role: "barber",
      firstSeen: realBarberPhotos[0]?.capturedAt || new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      visitCount: 1,
      appointmentCount: 0,
      bestFaceScore: Math.max(...realBarberPhotos.map(p => Number(p.sharpnessScore || 0)), 96),
      thumbnailBase64: realBarberPhotos[0]?.thumbnailBase64 || null,
      photos: realBarberPhotos,
      embeddings: realBarberEmbeddings.length > 0 ? realBarberEmbeddings : staffVectors,
      embedding: Array.isArray(realBarberEmbeddings[0]) ? realBarberEmbeddings[0] : (realBarberEmbeddings[0]?.vector || staffVectors[0] || null)
    };

    if (apply && (realBarberPhotos.length > 0 || staffVectors.length > 0)) {
      console.log(`💈 [Staff / Barbero] Sincronizando perfil oficial 'staff_barbero' (${realBarberPhotos.length} fotos, ${staffVectors.length} vectores)...`);
      if (sqliteClient.upsertCustomer) {
        try { sqliteClient.upsertCustomer(officialBarberProfile); } catch (e) {}
      }
      if (firestoreDb) {
        try {
          await firestoreDb.collection("camera_catcher_people").doc("staff_barbero").set(officialBarberProfile, { merge: true });
        } catch (e) {}
      }
    }

    // 0.1 Pre-escanear perfiles de clientes para detectar contaminación por el Barbero
    // Criterio: similitud con el barbero >= 0.46 en foto canónica o más del 50% de sus fotos
    const firestoreClientsMap = new Map();
    if (firestoreDb) {
      try {
        const snap = await firestoreDb.collection("camera_catcher_people").get();
        snap.docs.forEach(d => firestoreClientsMap.set(d.id, { id: d.id, ...d.data() }));
      } catch (err) {
        console.warn(`[Firestore] Error leyendo people:`, err.message);
      }
    }
    const allClientIds = new Set([...localSqliteProfiles.map(c => c.id), ...firestoreClientsMap.keys()]);
    const barberContaminatedClientIds = new Set();

    for (const cId of allClientIds) {
      if (cId === "staff_barbero") continue;
      if (cId === "person_1791417553339_2") {
        barberContaminatedClientIds.add(cId);
        continue;
      }
      const client = firestoreClientsMap.get(cId) || localSqliteProfiles.find(c => c.id === cId);
      if (!client || client.isStaff || client.role === "barber") continue;

      const clientName = String(client.name || "");
      const origEmbeddings = Array.isArray(client.embeddings) ? client.embeddings : [];
      const validPhotos = Array.isArray(client.photos) ? client.photos.filter(isValidPhoto) : [];

      const canonicalEmb = client.embedding || (origEmbeddings.length > 0 ? origEmbeddings[0] : null) || (validPhotos[0]?.embedding || null);
      const canonicalSim = computeBarberSimilarity(canonicalEmb);

      let staffPhotoMatches = 0;
      let totalEmbeddingsChecked = 0;
      for (const e of origEmbeddings) {
        totalEmbeddingsChecked++;
        if (computeBarberSimilarity(e) >= 0.46) {
          staffPhotoMatches++;
        }
      }
      if (totalEmbeddingsChecked === 0 && validPhotos.length > 0) {
        for (const p of validPhotos) {
          if (p.embedding) {
            totalEmbeddingsChecked++;
            if (computeBarberSimilarity(p.embedding) >= 0.46) {
              staffPhotoMatches++;
            }
          }
        }
      }

      const staffRatio = totalEmbeddingsChecked > 0 ? (staffPhotoMatches / totalEmbeddingsChecked) : 0;
      const isCanonicalBarber = canonicalSim >= 0.46;
      const isMajorityBarber = totalEmbeddingsChecked > 0 && staffRatio >= 0.5;

      if (isCanonicalBarber || isMajorityBarber) {
        barberContaminatedClientIds.add(cId);
        console.log(`   💈 ⚠️  [Detectado Perfil Contaminado por Barbero] ID: ${cId} | "${clientName}" | Similitud Canónica: ${canonicalSim.toFixed(3)} | Fotos Barbero: ${staffPhotoMatches}/${totalEmbeddingsChecked} (${(staffRatio * 100).toFixed(0)}%)`);
      }
    }

    console.log(`💈 Perfiles de clientes contaminados por el Barbero detectados: ${barberContaminatedClientIds.size}`);

    // ==========================================
    // 1. SANEAMIENTO Y DEDUPLICACIÓN DE ATENCIONES (APPOINTMENTS)
    // ==========================================
    console.log(`\n--- 1. Analizando y Saneando Atenciones (Appointments) ---`);
    const apptsToDelete = new Set();
    const apptsToUpdate = [];
    const validAppts = [];

    // 1.1 Leer de SQLite
    const sqliteAppts = sqliteClient.getAppointments ? sqliteClient.getAppointments({ limit: 1000 }) : [];
    console.log(`[SQLite] Atenciones encontradas: ${sqliteAppts.length}`);

    // 1.2 Leer de Firestore
    const firestoreApptsMap = new Map();
    if (firestoreDb) {
      try {
        const snap = await firestoreDb.collection("camera_catcher_appointments").get();
        console.log(`[Firestore] Documentos en camera_catcher_appointments: ${snap.size}`);
        snap.docs.forEach(d => firestoreApptsMap.set(d.id, { id: d.id, ...d.data() }));
      } catch (err) {
        console.warn(`[Firestore] Error leyendo appointments:`, err.message);
      }
    }

    // Unificar todos los IDs de atenciones
    const allApptIds = new Set([...sqliteAppts.map(a => a.id), ...firestoreApptsMap.keys()]);

    for (const apptId of allApptIds) {
      const appt = firestoreApptsMap.get(apptId) || sqliteAppts.find(a => a.id === apptId);
      if (!appt) continue;

      const rawPhotos = Array.isArray(appt.photos) ? appt.photos.filter(isValidPhoto) : [];
      const duration = Number(appt.durationMinutes || 0);
      const clientName = String(appt.clientName || appt.personName || "");
      const clientId = appt.clientId || appt.personId;

      const isEphemeral = duration < 10;
      const hasNoPhotos = rawPhotos.length === 0;
      const isUnidentified = !clientId || clientId.startsWith("unidentified_") || clientName.includes("sin identificar");
      const isPending = clientName.includes("confirmación");
      const isBarberAppt = clientId === "staff_barbero" || clientId === "person_1791417553339_2" || barberContaminatedClientIds.has(clientId);

      if (isEphemeral || hasNoPhotos || isUnidentified || isPending || isBarberAppt) {
        apptsToDelete.add(apptId);
        const reason = isBarberAppt ? "perfil-barbero" : (isEphemeral ? "duracion<10m" : (hasNoPhotos ? "sin-fotos" : (isUnidentified ? "no-identificado" : "en-confirmacion")));
        console.log(`   🗑️  [Atención Fantasma/Purgada] ID: ${apptId} | Cliente: "${clientName}" (${clientId}) | Duración: ${duration}m | Razón: ${reason}`);
      } else {
        // DEDUPLICACIÓN DE FOTOS DENTRO DE LA ATENCIÓN
        const cleanPhotos = [];
        for (const ph of rawPhotos) {
          const phThumb = getPhotoThumb(ph);
          // Verificar si ya existe miniatura idéntica
          const duplicateIdx = cleanPhotos.findIndex(cp => {
            const cpThumb = getPhotoThumb(cp);
            return phThumb && cpThumb && phThumb === cpThumb;
          });

          if (duplicateIdx !== -1) {
            // Reemplazar si tiene mayor nitidez
            if ((ph.sharpnessScore || 0) > (cleanPhotos[duplicateIdx].sharpnessScore || 0)) {
              cleanPhotos[duplicateIdx] = ph;
            }
          } else {
            cleanPhotos.push(ph);
          }
        }

        // Limitar a máximo 6 fotos representativas por atención
        const cappedPhotos = cleanPhotos.slice(0, 6);

        if (cappedPhotos.length < rawPhotos.length) {
          console.log(`   ✂️  [Atención Saneada] ID: ${apptId} | "${clientName}" | De ${rawPhotos.length} fotos a ${cappedPhotos.length} fotos únicas (eliminados ${rawPhotos.length - cappedPhotos.length} clones repetidos).`);
          apptsToUpdate.push({
            ...appt,
            photos: cappedPhotos,
            thumbnailBase64: cappedPhotos[0]?.thumbnailBase64 || appt.thumbnailBase64 || null
          });
        }

        validAppts.push({
          ...appt,
          photos: cappedPhotos
        });
      }
    }

    console.log(`[Atenciones] Total analizadas: ${allApptIds.size} | Fantasmas a eliminar: ${apptsToDelete.size} | Con fotos saneadas: ${apptsToUpdate.length} | Válidas conservadas: ${validAppts.length}`);

    if (apply) {
      if (apptsToDelete.size > 0) {
        console.log(`[Atenciones] Ejecutando eliminación de atenciones fantasmas...`);
        for (const id of apptsToDelete) {
          if (sqliteClient.deleteAppointment) {
            try { sqliteClient.deleteAppointment(id); } catch (e) {}
          }
          if (firestoreDb) {
            try {
              await firestoreDb.collection("camera_catcher_appointments").doc(id).delete();
              await firestoreDb.collection("camera_catcher_visits").doc(id).delete();
            } catch (e) {}
          }
        }
      }

      if (apptsToUpdate.length > 0) {
        console.log(`[Atenciones] Actualizando ${apptsToUpdate.length} atenciones saneadas sin fotos repetidas...`);
        for (const appt of apptsToUpdate) {
          if (sqliteClient.saveAppointment) {
            try { sqliteClient.saveAppointment(appt); } catch (e) {}
          }
          if (firestoreDb) {
            try {
              await firestoreDb.collection("camera_catcher_appointments").doc(appt.id).update({
                photos: appt.photos,
                thumbnailBase64: appt.thumbnailBase64
              });
            } catch (e) {}
          }
        }
      }
    }

    // ==========================================
    // 2. PURGA Y SANEAMIENTO DE CLIENTES
    // ==========================================
    console.log(`\n--- 2. Analizando Perfiles de Clientes ---`);
    const clientsToDelete = new Set();
    const legitimateClients = [];

    console.log(`[SQLite] Clientes encontrados: ${localSqliteProfiles.length}`);
    console.log(`[Firestore] Documentos en camera_catcher_people: ${firestoreClientsMap.size}`);

    for (const cId of allClientIds) {
      const client = firestoreClientsMap.get(cId) || localSqliteProfiles.find(c => c.id === cId);
      if (!client) continue;

      if (cId === "staff_barbero") {
        console.log(`   💈 [Staff / Barbero] 'staff_barbero' conservado intacto.`);
        continue;
      }

      // Si es el perfil duplicado de Cliente #25 del barbero, consolidar o eliminar
      if (cId === "person_1791417553339_2") {
        console.log(`   💈 [Staff / Barbero] '${cId}' consolidado en 'staff_barbero'. Purgando duplicado de cliente.`);
        clientsToDelete.add(cId);
        continue;
      }

      // Si fue marcado como contaminado por el barbero, aplicar Hard Delete
      if (barberContaminatedClientIds.has(cId)) {
        clientsToDelete.add(cId);
        console.log(`   💈 🗑️  [Perfil Contaminado por Barbero - Hard Delete] ID: ${cId} | Nombre: "${client.name}". Purgado.`);
        continue;
      }

      const clientName = String(client.name || "");
      const validPhotos = Array.isArray(client.photos) ? client.photos.filter(isValidPhoto) : [];
      const origEmbeddings = Array.isArray(client.embeddings) ? client.embeddings : [];
      const apptCountForClient = validAppts.filter(a => a.clientId === cId || a.personId === cId).length;

      // 1. Filtrar fotos y embeddings individuales que coincidan con el Barbero real (>= 0.46)
      const nonStaffPhotos = [];
      const nonStaffEmbeddings = [];

      for (let pIdx = 0; pIdx < validPhotos.length; pIdx++) {
        const ph = validPhotos[pIdx];
        const emb = origEmbeddings[pIdx] || (pIdx === 0 && client.embedding ? client.embedding : null) || ph.embedding || null;
        const sim = computeBarberSimilarity(emb);
        const isStaffPhoto = sim >= 0.46;

        if (isStaffPhoto) {
          console.log(`   🚫 Foto del Barbero eliminada de "${clientName}" (${cId}) - Similitud: ${sim.toFixed(3)}`);
        } else {
          nonStaffPhotos.push(ph);
          if (emb) nonStaffEmbeddings.push(emb);
        }
      }

      // 2. Criterios de purga
      const isPending = clientName.includes("confirmación");
      const hasNoValidPhotos = nonStaffPhotos.length === 0;
      const hasNoAppts = apptCountForClient === 0;

      if (hasNoValidPhotos) {
        clientsToDelete.add(cId);
        console.log(`   🗑️  [Perfil Falso del Barbero / Sin fotos válidas] ID: ${cId} | Nombre: "${clientName}" (Fotos no-staff: 0 / ${validPhotos.length}). Purgado.`);
      } else if (isPending || hasNoAppts) {
        clientsToDelete.add(cId);
        console.log(`   🗑️  [Cliente Falso/Provisional] ID: ${cId} | Nombre: "${clientName}" | Fotos válidas: ${nonStaffPhotos.length} | Citas válidas: ${apptCountForClient} (Razón: ${isPending ? 'en-confirmación ' : ''}${hasNoAppts ? 'sin-citas' : ''}). Purgado.`);
      } else {

        // Deduplicar fotos del cliente legítimo
        const cleanPhotos = [];
        const cleanEmbeddings = [];

        for (let pIdx = 0; pIdx < nonStaffPhotos.length; pIdx++) {
          const ph = nonStaffPhotos[pIdx];
          const emb = nonStaffEmbeddings[pIdx] || null;
          let isDuplicate = false;

          for (let j = 0; j < cleanPhotos.length; j++) {
            const existing = cleanPhotos[j];
            const existingEmb = cleanEmbeddings[j] || null;

            const sameThumb = getPhotoThumb(ph) && getPhotoThumb(existing) && getPhotoThumb(ph) === getPhotoThumb(existing);
            let highSim = sameThumb;

            if (emb && existingEmb) {
              const v1 = Array.isArray(emb) ? emb : (emb.vector || null);
              const v2 = Array.isArray(existingEmb) ? existingEmb : (existingEmb.vector || null);
              if (v1 && v2) {
                const sim = computeCosineSimilarity(v1, v2);
                const samePose = (ph.pose || 'frontal') === (existing.pose || 'frontal');
                if (sim >= 0.92 || (sim >= 0.88 && samePose)) highSim = true;
              }
            }

            if (highSim) {
              isDuplicate = true;
              if ((ph.sharpnessScore || 0) > (existing.sharpnessScore || 0)) {
                cleanPhotos[j] = ph;
                if (emb) cleanEmbeddings[j] = emb;
              }
              break;
            }
          }

          if (!isDuplicate) {
            cleanPhotos.push(ph);
            if (emb) cleanEmbeddings.push(emb);
          }
        }

        client.photos = cleanPhotos;
        if (cleanEmbeddings.length > 0) {
          client.embeddings = cleanEmbeddings;
          client.embedding = cleanEmbeddings[0];
        }
        client.bestFaceScore = Math.max(...cleanPhotos.map(p => Number(p.sharpnessScore || 0)), 0);
        client.thumbnailBase64 = cleanPhotos[0]?.thumbnailBase64 || client.thumbnailBase64 || null;
        client.appointmentCount = apptCountForClient;
        client.visitCount = Math.max(Number(client.visitCount || 1), apptCountForClient);

        legitimateClients.push(client);
      }
    }

    console.log(`[Clientes] Total analizados: ${allClientIds.size} | Purgados a eliminar: ${clientsToDelete.size} | Legítimos conservados: ${legitimateClients.length}`);

    if (apply) {
      if (clientsToDelete.size > 0) {
        console.log(`[Clientes] Ejecutando Hard Delete en SQLite y Firestore (${clientsToDelete.size} perfiles)...`);
        for (const id of clientsToDelete) {
          if (sqliteClient.deleteCustomer) {
            try { sqliteClient.deleteCustomer(id); } catch (e) {}
          }
          if (firestoreDb) {
            try {
              await firestoreDb.collection("camera_catcher_people").doc(id).delete();
            } catch (e) {}
          }
        }
      }

      console.log(`[Clientes] Sincronizando ${legitimateClients.length} clientes legítimos...`);
      for (const client of legitimateClients) {
        if (sqliteClient.upsertCustomer) {
          try { sqliteClient.upsertCustomer(client); } catch (e) {}
        }
        if (firestoreDb) {
          try {
            await firestoreDb.collection("camera_catcher_people").doc(client.id).set({
              photos: client.photos,
              appointmentCount: client.appointmentCount,
              visitCount: client.visitCount,
              thumbnailBase64: client.photos[0]?.thumbnailBase64 || null
            }, { merge: true });
          } catch (e) {}
        }
      }
    }
  }

  console.log("\n=============================================================");
  if (dryRun) {
    console.log("🔍 Simulación completada (DRY-RUN). Ejecuta con '--apply --database=test' o '--apply --all-databases' para ejecutar la purga.");
  } else {
    console.log("🎉 ¡Purga y saneamiento ejecutados exitosamente con '--apply'!");
  }
  console.log("=============================================================\n");
}

runCleanup().catch(err => {
  console.error("❌ Error en script de purga:", err);
  process.exit(1);
});
