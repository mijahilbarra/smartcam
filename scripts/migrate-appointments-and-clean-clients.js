/**
 * Script de Purga y Saneamiento Integral:
 * - Depura atenciones fantasma (< 10 min, 0 fotos, sin cliente identificado, o en confirmación)
 * - Sanea y deduplica fotos dentro de las atenciones legítimas (elimina las 15+ fotos repetidas)
 * - Registra formalmente al Barbero real con sus fotos y embeddings en staff_barbero
 * - Purgar perfiles falsos creados a partir del barbero (Cliente #578-#582, Cliente #112, etc.)
 * - Recalcula appointmentCount real para cada cliente legítimo
 *
 * Uso:
 *   node scripts/migrate-appointments-and-clean-clients.js --dry-run
 *   node scripts/migrate-appointments-and-clean-clients.js --apply --all-databases
 *   node scripts/migrate-appointments-and-clean-clients.js --database="(default)" --apply
 */

import { initFirebaseAdmin } from "../src/infrastructure/firebase/firebase_admin.js";
import { getSqliteClient } from "../src/infrastructure/storage/sqlite_client.js";
import { computeCosineSimilarity } from "../src/face_recognizer.js";

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

  // Obtener perfil oficial del Barbero desde '(default)' para asegurar consistencia
  let realBarberPhotos = [];
  let realBarberEmbeddings = [];
  try {
    const fbDef = initFirebaseAdmin({ databaseId: "(default)" });
    const snap25 = await fbDef.db.collection("camera_catcher_people").doc("person_1791417553339_2").get();
    if (snap25.exists) {
      const data25 = snap25.data();
      realBarberPhotos = Array.isArray(data25.photos) ? data25.photos.filter(isValidPhoto) : [];
      realBarberEmbeddings = Array.isArray(data25.embeddings) ? data25.embeddings : [];
      console.log(`💈 Perfil del verdadero Barbero recuperado (person_1791417553339_2): ${realBarberPhotos.length} fotos, ${realBarberEmbeddings.length} embeddings.`);
    }
  } catch (e) {
    console.warn(`[BarberBootstrap] Aviso leyendo perfil base del barbero:`, e.message);
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

    // 0. Preparar vectores del Barbero para exclusión
    const staffVectors = [];
    for (const e of realBarberEmbeddings) {
      const v = Array.isArray(e) ? e : (e?.vector || null);
      if (v) staffVectors.push(v);
    }

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
      embeddings: realBarberEmbeddings,
      embedding: Array.isArray(realBarberEmbeddings[0]) ? realBarberEmbeddings[0] : (realBarberEmbeddings[0]?.vector || null)
    };

    if (apply && realBarberPhotos.length > 0) {
      console.log(`💈 [Staff / Barbero] Sincronizando perfil oficial 'staff_barbero' (${realBarberPhotos.length} fotos)...`);
      if (sqliteClient.upsertCustomer) {
        try { sqliteClient.upsertCustomer(officialBarberProfile); } catch (e) {}
      }
      if (firestoreDb) {
        try {
          await firestoreDb.collection("camera_catcher_people").doc("staff_barbero").set(officialBarberProfile, { merge: true });
        } catch (e) {}
      }
    }

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

      if (isEphemeral || hasNoPhotos || isUnidentified || isPending) {
        apptsToDelete.add(apptId);
        console.log(`   🗑️  [Atención Fantasma] ID: ${apptId} | Cliente: "${clientName}" | Duración: ${duration}m | Fotos: ${rawPhotos.length}`);
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

    const sqliteCustomers = sqliteClient.getAllComparisonProfiles ? sqliteClient.getAllComparisonProfiles() : [];
    console.log(`[SQLite] Clientes encontrados: ${sqliteCustomers.length}`);

    const firestoreClientsMap = new Map();
    if (firestoreDb) {
      try {
        const snap = await firestoreDb.collection("camera_catcher_people").get();
        console.log(`[Firestore] Documentos en camera_catcher_people: ${snap.size}`);
        snap.docs.forEach(d => firestoreClientsMap.set(d.id, { id: d.id, ...d.data() }));
      } catch (err) {
        console.warn(`[Firestore] Error leyendo people:`, err.message);
      }
    }

    const allClientIds = new Set([...sqliteCustomers.map(c => c.id), ...firestoreClientsMap.keys()]);

    for (const cId of allClientIds) {
      const client = firestoreClientsMap.get(cId) || sqliteCustomers.find(c => c.id === cId);
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

      const clientName = String(client.name || "");
      const validPhotos = Array.isArray(client.photos) ? client.photos.filter(isValidPhoto) : [];
      const apptCountForClient = validAppts.filter(a => a.clientId === cId || a.personId === cId).length;

      // 1. Filtrar fotos y embeddings que coincidan con el Barbero real
      const nonStaffPhotos = [];
      const nonStaffEmbeddings = [];
      const origEmbeddings = Array.isArray(client.embeddings) ? client.embeddings : [];

      for (let pIdx = 0; pIdx < validPhotos.length; pIdx++) {
        const ph = validPhotos[pIdx];
        const emb = origEmbeddings[pIdx] || (pIdx === 0 && client.embedding ? client.embedding : null);
        let isStaffPhoto = false;

        if (emb && staffVectors.length > 0) {
          const v = Array.isArray(emb) ? emb : (emb.vector || null);
          if (v) {
            for (const sv of staffVectors) {
              if (computeCosineSimilarity(v, sv) >= 0.58) {
                isStaffPhoto = true;
                break;
              }
            }
          }
        }

        if (isStaffPhoto) {
          console.log(`   🚫 Foto del Barbero eliminada de "${clientName}" (${cId})`);
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
        console.log(`   🗑️  [Perfil Falso del Barbero / Sin fotos] ID: ${cId} | Nombre: "${clientName}" (Fotos no-staff: 0 / ${validPhotos.length}). Purgado.`);
      } else if (isPending || hasNoAppts) {
        clientsToDelete.add(cId);
        console.log(`   🗑️  [Cliente Falso/Provisional] ID: ${cId} | Nombre: "${clientName}" | Fotos válidas: ${nonStaffPhotos.length} | Citas válidas: ${apptCountForClient} (Razón: ${isPending ? 'en-confirmación ' : ''}${hasNoAppts ? 'sin-citas' : ''})`);
      } else {

        // Deduplicar fotos del cliente
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
        legitimateClients.push(client);
      }
    }

    console.log(`[Clientes] Total analizados: ${allClientIds.size} | Fantasmas a eliminar: ${clientsToDelete.size} | Legítimos conservados: ${legitimateClients.length}`);

    if (apply) {
      if (clientsToDelete.size > 0) {
        console.log(`[Clientes] Ejecutando eliminación en SQLite y Firestore...`);
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
              thumbnailBase64: client.photos[0]?.thumbnailBase64 || null
            }, { merge: true });
          } catch (e) {}
        }
      }
    }
  }

  console.log("\n=============================================================");
  if (dryRun) {
    console.log("🔍 Simulación completada (DRY-RUN). Ejecuta con '--apply --all-databases' para ejecutar la purga.");
  } else {
    console.log("🎉 ¡Purga y saneamiento ejecutados exitosamente con '--apply'!");
  }
  console.log("=============================================================\n");
}

runCleanup().catch(err => {
  console.error("❌ Error en script de purga:", err);
  process.exit(1);
});
