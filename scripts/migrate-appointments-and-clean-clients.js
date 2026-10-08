/**
 * Script de Purga y Saneamiento Integral:
 * - Depura atenciones fantasma (< 10 min, 0 fotos, sin cliente identificado, o en confirmación)
 * - Depura perfiles de clientes corruptos o provisionales ("Cliente en confirmación", sin fotos válidas)
 * - Sanea fotos con miniaturas nulas
 * - Recalcula appointmentCount real para cada cliente legítimo
 *
 * Uso:
 *   node scripts/migrate-appointments-and-clean-clients.js --dry-run
 *   node scripts/migrate-appointments-and-clean-clients.js --apply --all-databases
 *   node scripts/migrate-appointments-and-clean-clients.js --database="(default)" --apply
 */

import { initFirebaseAdmin } from "../src/infrastructure/firebase/firebase_admin.js";
import { getSqliteClient } from "../src/infrastructure/storage/sqlite_client.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run") || !apply;

  let databaseId = "(default)";
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

async function runCleanup() {
  const { apply, dryRun, databaseId, allDatabases } = parseArgs();

  console.log("=============================================================");
  console.log("✂️  Purga y Saneamiento de Atenciones y Clientes de la Barbería");
  console.log(`   Modo: ${dryRun ? "🔍 DRY-RUN (Simulación sin cambios)" : "⚡ APPLY (Escritura real activada)"}`);
  console.log("=============================================================\n");

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

    // ==========================================
    // 1. PURGA DE ATENCIONES (APPOINTMENTS) FANTASMAS
    // ==========================================
    console.log(`\n--- 1. Analizando Atenciones (Appointments) ---`);
    const apptsToDelete = new Set();
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

      const photos = Array.isArray(appt.photos) ? appt.photos.filter(isValidPhoto) : [];
      const duration = Number(appt.durationMinutes || 0);
      const clientName = String(appt.clientName || appt.personName || "");
      const clientId = appt.clientId || appt.personId;

      // Criterios de atencion fantasma:
      // 1. Duración < 10 min
      // 2. 0 fotos válidas
      // 3. Cliente sin identificar o nulo
      // 4. Nombre provisional en confirmación
      const isEphemeral = duration < 10;
      const hasNoPhotos = photos.length === 0;
      const isUnidentified = !clientId || clientId.startsWith("unidentified_") || clientName.includes("sin identificar");
      const isPending = clientName.includes("confirmación");

      if (isEphemeral || hasNoPhotos || isUnidentified || isPending) {
        apptsToDelete.add(apptId);
        console.log(`   🗑️  [Atención Fantasma] ID: ${apptId} | Cliente: "${clientName}" | Duración: ${duration}m | Fotos válidas: ${photos.length} (Razón: ${isEphemeral ? '<10m ' : ''}${hasNoPhotos ? 'sin-fotos ' : ''}${isUnidentified ? 'no-id ' : ''}${isPending ? 'en-confirmación' : ''})`);
      } else {
        validAppts.push({ ...appt, photos });
      }
    }

    console.log(`[Atenciones] Total analizadas: ${allApptIds.size} | Fantasmas a eliminar: ${apptsToDelete.size} | Válidas conservadas: ${validAppts.length}`);

    if (apply && apptsToDelete.size > 0) {
      console.log(`[Atenciones] Ejecutando eliminación en SQLite y Firestore...`);
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

    // ==========================================
    // 2. PURGA DE CLIENTES FANTASMAS O PROVISIONALES
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

      const isStaff = client.isStaff === true || client.role === "staff" || client.role === "barber" || String(client.id).startsWith("staff_");
      if (isStaff) {
        console.log(`   💈 [Staff / Barbero] ID: ${client.id} | "${client.name}" conservado intacto.`);
        continue;
      }

      const clientName = String(client.name || "");
      const validPhotos = Array.isArray(client.photos) ? client.photos.filter(isValidPhoto) : [];
      const apptCountForClient = validAppts.filter(a => a.clientId === cId || a.personId === cId).length;

      // Criterios de cliente corrupto:
      // 1. Nombre contiene "confirmación"
      // 2. 0 fotos válidas con imagen
      // 3. Cliente efímero con 0 atenciones legítimas
      const isPending = clientName.includes("confirmación");
      const hasNoValidPhotos = validPhotos.length === 0;
      const hasNoAppts = apptCountForClient === 0;

      if (isPending || hasNoValidPhotos || hasNoAppts) {
        clientsToDelete.add(cId);
        console.log(`   🗑️  [Cliente Falso/Provisional] ID: ${cId} | Nombre: "${clientName}" | Fotos válidas: ${validPhotos.length} | Citas válidas: ${apptCountForClient} (Razón: ${isPending ? 'en-confirmación ' : ''}${hasNoValidPhotos ? 'sin-fotos ' : ''}${hasNoAppts ? 'sin-citas' : ''})`);
      } else {
        client.photos = validPhotos;
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

      // Actualizar clientes legítimos con sus fotos limpias y contador real
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
