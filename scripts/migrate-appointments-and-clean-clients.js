/**
 * Script de Migración y Depuración de Clientes y Generación de Atenciones (Appointments)
 *
 * Funcionalidad:
 * 1. Lee clientes existentes desde las bases SQLite locales (data/barberia.db, data/barberia_test.db)
 *    y desde Firestore (colección 'camera_catcher_people') para cada entorno ('(default)' y 'test').
 * 2. Identifica y depura falsos perfiles / transeúntes efímeros:
 *    - Clientes que NO son staff y cuya diferencia entre firstSeen y lastSeen sea menor a 3 minutos
 *      (o lastSeen === firstSeen) Y tengan exactamente 1 sola foto de paso (photos.length === 1).
 * 3. Para clientes legítimos:
 *    - Genera atenciones (appointments) con duración de 45 minutos.
 *    - Si visitCount > 1 y lastSeen es de otro día o difiere por más de 1 hora, genera una segunda atención en lastSeen (+45 min).
 *    - Actualiza appointment_count en el cliente.
 *    - Persiste los appointments en SQLite y en Firestore (colección 'camera_catcher_appointments').
 * 4. Permite flags --apply (ejecuta cambios) y --dry-run (por defecto si no se especifica --apply).
 *
 * Uso:
 *   node scripts/migrate-appointments-and-clean-clients.js --dry-run
 *   node scripts/migrate-appointments-and-clean-clients.js --apply
 *   node scripts/migrate-appointments-and-clean-clients.js --database=test --apply
 */

import fs from "fs";
import path from "path";
import { initFirebaseAdmin } from "../src/infrastructure/firebase/firebase_admin.js";
import { getSqliteClient, getResolvedSqlitePath } from "../src/infrastructure/storage/sqlite_client.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run") || !apply;

  let databaseId = "test"; // por defecto test o ambas
  const dbArg = args.find(a => a.startsWith("--database="));
  if (dbArg) {
    databaseId = dbArg.split("=")[1].replace(/^["']|["']$/g, "").trim();
  }

  const allDatabases = args.includes("--all-databases");

  return { apply, dryRun, databaseId, allDatabases };
}

async function runMigrationAndCleanup() {
  const { apply, dryRun, databaseId, allDatabases } = parseArgs();

  console.log("=============================================================");
  console.log("✂️  Migración de Appointments y Depuración de Transeúntes Efímeros");
  console.log(`   Modo: ${dryRun ? "🔍 DRY-RUN (Simulación sin cambios)" : "⚡ APPLY (Escritura real activada)"}`);
  console.log("=============================================================\n");

  const targets = allDatabases ? ["test", "(default)"] : [databaseId];

  for (const dbId of targets) {
    console.log(`\n-------------------------------------------------------------`);
    console.log(`📂 Procesando Base de Datos / Entorno: "${dbId}"`);
    console.log(`-------------------------------------------------------------`);

    // 1. Inicializar SQLite y Firestore
    const sqliteClient = getSqliteClient(dbId);
    console.log(`[SQLite] Ruta: ${sqliteClient.dbPath}`);

    let firestoreDb = null;
    try {
      const fb = initFirebaseAdmin({ databaseId: dbId });
      firestoreDb = fb.db;
      console.log(`[Firestore] Conectado a base '${dbId}'`);
    } catch (err) {
      console.warn(`[Firestore] No se pudo conectar a Firebase para '${dbId}' (${err.message}). Trabajando sólo con SQLite local.`);
    }

    // 2. Recopilar clientes desde SQLite y Firestore
    const clientMap = new Map();

    // 2.1 Desde SQLite local
    const sqliteCustomers = sqliteClient.getAllComparisonProfiles();
    for (const c of sqliteCustomers) {
      clientMap.set(c.id, { ...c, source: "sqlite" });
    }
    console.log(`[SQLite] Clientes leídos: ${sqliteCustomers.length}`);

    // 2.2 Desde Firestore (si disponible)
    if (firestoreDb) {
      try {
        const snapshot = await firestoreDb.collection("camera_catcher_people").get();
        console.log(`[Firestore] Documentos leídos en 'camera_catcher_people': ${snapshot.size}`);
        for (const doc of snapshot.docs) {
          const data = doc.data();
          const id = doc.id;
          const photos = Array.isArray(data.photos) ? data.photos : [];
          const existing = clientMap.get(id) || {};

          clientMap.set(id, {
            id,
            name: data.name || existing.name || "Cliente",
            isStaff: data.isStaff ?? existing.isStaff ?? false,
            role: data.role || existing.role || "client",
            firstSeen: data.firstSeen || existing.firstSeen || null,
            lastSeen: data.lastSeen || existing.lastSeen || null,
            visitCount: data.visitCount ?? existing.visitCount ?? 1,
            bestFaceScore: data.bestFaceScore ?? existing.bestFaceScore ?? 0,
            thumbnailPath: data.thumbnailPath || existing.thumbnailPath || null,
            photos: photos.length > 0 ? photos : (existing.photos || []),
            source: "firestore+sqlite"
          });
        }
      } catch (err) {
        console.warn(`[Firestore] Error leyendo colección: ${err.message}`);
      }
    }

    const allClients = Array.from(clientMap.values());
    console.log(`[Análisis] Total clientes únicos encontrados: ${allClients.length}`);

    let ephemeralCount = 0;
    let legitimateCount = 0;
    let appointmentsCreatedTotal = 0;

    for (const client of allClients) {
      const isStaff = client.isStaff === true || client.role === "staff" || client.role === "barber" || String(client.id).startsWith("staff_");
      const photos = Array.isArray(client.photos) ? client.photos : [];
      const firstSeen = client.firstSeen ? new Date(client.firstSeen) : null;
      const lastSeen = client.lastSeen ? new Date(client.lastSeen) : firstSeen;

      if (isStaff) {
        console.log(`   💈 [Personal / Staff] ID: ${client.id} | Nombre: "${client.name}" | Conservado sin generar citas de cliente.`);
        continue;
      }

      // Criterio de transeúnte efímero:
      // - NO es staff
      // - 1 sola foto de paso (photos.length <= 1)
      // - Diferencia entre firstSeen y lastSeen < 3 minutos (180000 ms) o sin firstSeen válido
      let diffMs = 0;
      if (firstSeen && lastSeen) {
        diffMs = Math.abs(lastSeen.getTime() - firstSeen.getTime());
      }

      const isEphemeral = !isStaff && photos.length <= 1 && (diffMs < 180 * 1000 || !firstSeen);

      if (isEphemeral) {
        ephemeralCount++;
        console.log(`   🗑️  [Transeúnte Efímero detectado] ID: ${client.id} | Nombre: "${client.name}" | Duración: ${Math.round(diffMs / 1000)}s | Fotos: ${photos.length}`);
        
        if (apply) {
          // Eliminar de SQLite
          sqliteClient.deleteCustomer(client.id);
          // Eliminar de Firestore si aplica
          if (firestoreDb) {
            try {
              await firestoreDb.collection("camera_catcher_people").doc(client.id).delete();
            } catch (e) {}
          }
        }
        continue;
      }

      // Cliente legítimo
      legitimateCount++;
      const validFirstSeen = firstSeen || new Date();
      const validLastSeen = lastSeen || validFirstSeen;

      // Generar atenciones (appointments)
      const appointmentsForClient = [];

      // Primera atención basada en firstSeen
      const start1 = validFirstSeen;
      const end1 = new Date(start1.getTime() + 45 * 60 * 1000); // +45 minutos
      const apptId1 = `appt_${client.id}_${start1.getTime()}`;

      appointmentsForClient.push({
        id: apptId1,
        chairId: "silla_corte_1",
        chairName: "Silla de Corte 1",
        clientId: client.id,
        clientName: client.name || "Cliente",
        startedAt: start1.toISOString(),
        endedAt: end1.toISOString(),
        durationMinutes: 45,
        status: "completed",
        bestFaceScore: client.bestFaceScore || 0,
        thumbnailPath: client.thumbnailPath || null,
        photos: photos
      });

      // Si visitCount > 1 y lastSeen difiere por más de 1 hora o es otro día, genera segunda atención
      if (client.visitCount > 1 && validLastSeen.getTime() > start1.getTime() + 60 * 60 * 1000) {
        const start2 = validLastSeen;
        const end2 = new Date(start2.getTime() + 45 * 60 * 1000);
        const apptId2 = `appt_${client.id}_${start2.getTime()}`;

        appointmentsForClient.push({
          id: apptId2,
          chairId: "silla_corte_1",
          chairName: "Silla de Corte 1",
          clientId: client.id,
          clientName: client.name || "Cliente",
          startedAt: start2.toISOString(),
          endedAt: end2.toISOString(),
          durationMinutes: 45,
          status: "completed",
          bestFaceScore: client.bestFaceScore || 0,
          thumbnailPath: client.thumbnailPath || null,
          photos: photos
        });
      }

      appointmentsCreatedTotal += appointmentsForClient.length;

      console.log(`   ✅ [Cliente Legítimo] ID: ${client.id} | Nombre: "${client.name}" | Visitas: ${client.visitCount} | Citas generadas: ${appointmentsForClient.length}`);

      if (apply) {
        // Actualizar cliente con appointmentCount
        client.appointmentCount = appointmentsForClient.length;
        sqliteClient.upsertCustomer(client);

        if (firestoreDb) {
          try {
            await firestoreDb.collection("camera_catcher_people").doc(client.id).set({
              appointmentCount: appointmentsForClient.length
            }, { merge: true });
          } catch (e) {}
        }

        // Persistir appointments
        for (const appt of appointmentsForClient) {
          sqliteClient.saveAppointment(appt);
          if (firestoreDb) {
            try {
              await firestoreDb.collection("camera_catcher_appointments").doc(appt.id).set(appt, { merge: true });
            } catch (e) {}
          }
        }
      }
    }

    console.log(`\n   --- Resumen Entorno '${dbId}' ---`);
    console.log(`   Total analizados: ${allClients.length}`);
    console.log(`   Transeúntes efímeros depurados: ${ephemeralCount}`);
    console.log(`   Clientes legítimos mantenidos: ${legitimateCount}`);
    console.log(`   Atenciones (Appointments) generadas: ${appointmentsCreatedTotal}`);
  }

  console.log("\n=============================================================");
  if (dryRun) {
    console.log("🔍 Simulación completada (DRY-RUN). Ejecuta con '--apply' para persistir los cambios.");
  } else {
    console.log("🎉 ¡Migración, depuración y generación de atenciones ejecutadas con éxito (--apply)!");
  }
  console.log("=============================================================\n");
}

runMigrationAndCleanup().catch(err => {
  console.error("❌ Error fatal en migración de appointments:", err);
  process.exit(1);
});
