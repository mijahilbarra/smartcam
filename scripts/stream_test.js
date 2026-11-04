/**
 * Lanza la prueba de streaming (video mock, una sola pasada) tras borrar de
 * Firebase (base `test`) y SQLite (`barberia_test.db`) los datos de la fecha elegida.
 *
 * Uso:
 *   npm run stream:test                          -> borra desde hoy en adelante (America/Lima) en avance rápido
 *   npm run stream:test -- --realtime            -> corre a cadencia real sincronizada con prod (10 FPS video, ~180ms IA)
 *   npm run stream:test -- --date 2026-10-24     -> borra solo esa fecha
 *   npm run stream:test -- --no-clean            -> no borra nada
 *   npm run stream:test -- --video data/recordings/otro.mp4 --start 2420 --fps 10
 *
 * Qué borra para la fecha: citas (camera_catcher_appointments) y visitas
 * (camera_catcher_visits) con inicio en ese día, y los clientes que queden sin
 * ninguna cita. Nunca borra a `staff_barbero`. Solo toca la base `test`.
 */
import path from "path";
import { spawn } from "child_process";
import Database from "better-sqlite3";

const TZ = "America/Lima";
const LIMA_OFFSET_HOURS = 5; // Lima = UTC-5, sin horario de verano

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-clean") out.noClean = true;
    else if (a.startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[++i];
    } else if (a.startsWith("--")) out[a.slice(2)] = true;
  }
  return out;
}

function todayInLima() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}

function dayRangeLima(dateStr, { openEnded = false } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`Fecha inválida "${dateStr}". Usa el formato YYYY-MM-DD.`);
  }
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  start.setUTCHours(start.getUTCHours() + LIMA_OFFSET_HOURS);
  // La simulación avanza el reloj virtual más rápido que el real, por lo que sus citas
  // pueden quedar en días posteriores: sin --date se borra desde hoy en adelante.
  const end = openEnded ? new Date(8.64e15) : new Date(start.getTime() + 24 * 3600 * 1000);
  return { start, end };
}

const inRange = (value, { start, end }) => {
  if (!value) return false;
  const t = typeof value?.toDate === "function" ? value.toDate().getTime() : new Date(value).getTime();
  return Number.isFinite(t) && t >= start.getTime() && t < end.getTime();
};

async function cleanDate(dateStr, wipeAll = false) {
  const range = wipeAll ? { start: new Date(0), end: new Date(8.64e15) } : dayRangeLima(dateStr, { openEnded: false });
  console.log(`[StreamTest] 🧹 Borrando ${wipeAll ? "TODOS los datos de la base test (excepto staff_barbero)" : `datos de test del ${dateStr} (${TZ})`}...`);

  process.env.USE_FIREBASE = "true";
  process.env.IS_LOCAL_SIMULATOR = "false";
  const { initFirebaseAdmin } = await import("../src/infrastructure/firebase/firebase_admin.js");
  const { db } = initFirebaseAdmin({ databaseId: "test" });
  if (!db) throw new Error("No se pudo inicializar Firestore test");

  // Nota: se borra documento por documento (en lote, commit() se cuelga en este entorno).
  const deleteDocs = (docs) => Promise.all(docs.map((d) => d.ref.delete()));

  const apptSnap = await db.collection("camera_catcher_appointments").get();
  const apptsToDelete = wipeAll ? apptSnap.docs : apptSnap.docs.filter((d) => inRange(d.data().startedAt || d.data().startTime, range));
  await deleteDocs(apptsToDelete);
  const remainingClientIds = new Set(
    apptSnap.docs
      .filter((d) => !apptsToDelete.includes(d))
      .map((d) => d.data().clientId || d.data().personId)
      .filter(Boolean)
  );
  console.log(`[StreamTest] Firestore: ${apptsToDelete.length} citas eliminadas (de ${apptSnap.size}).`);

  const visitsSnap = await db.collection("camera_catcher_visits").get();
  const visitsToDelete = wipeAll
    ? visitsSnap.docs
    : visitsSnap.docs.filter((d) => {
        const v = d.data();
        return inRange(v.startedAt || v.startTime || v.createdAt, range);
      });
  await deleteDocs(visitsToDelete);
  console.log(`[StreamTest] Firestore: ${visitsToDelete.length} visitas eliminadas.`);

  const peopleSnap = await db.collection("camera_catcher_people").get();
  const peopleToDelete = peopleSnap.docs.filter(
    (d) => d.id !== "staff_barbero" && !d.data().isStaff && (wipeAll || !remainingClientIds.has(d.id))
  );
  await deleteDocs(peopleToDelete);
  console.log(`[StreamTest] Firestore: ${peopleToDelete.length} clientes sin citas eliminados.`);

  // SQLite local de test
  const sqlite = new Database(path.join(process.cwd(), "data", "barberia_test.db"));
  const rows = sqlite.prepare("SELECT id, started_at FROM appointments").all();
  const delAppt = sqlite.prepare("DELETE FROM appointments WHERE id = ?");
  let sqliteAppts = 0;
  for (const r of rows) {
    if (wipeAll || inRange(r.started_at, range)) {
      delAppt.run(r.id);
      sqliteAppts++;
    }
  }
  const orphanIds = sqlite
    .prepare(
      wipeAll
        ? "SELECT id FROM customers WHERE id != 'staff_barbero' AND COALESCE(is_staff,0)=0"
        : "SELECT id FROM customers WHERE id != 'staff_barbero' AND COALESCE(is_staff,0)=0 AND id NOT IN (SELECT client_id FROM appointments WHERE client_id IS NOT NULL)"
    )
    .all()
    .map((r) => r.id);
  for (const id of orphanIds) {
    sqlite.prepare("DELETE FROM customer_embeddings WHERE customer_id = ?").run(id);
    sqlite.prepare("DELETE FROM customers WHERE id = ?").run(id);
  }

  // Restaurar el perfil puro de staff_barbero desde data/barberia.db (30 vectores canónicos)
  // tanto en barberia_test.db como en Firestore test para eliminar cualquier vector contaminado previo
  const prodPath = path.join(process.cwd(), "data", "barberia.db");
  const { blobToVector } = await import("../src/infrastructure/storage/sqlite_client.js");
  const prodDb = new Database(prodPath, { readonly: true });
  const staffRow = prodDb.prepare("SELECT * FROM customers WHERE id = 'staff_barbero' OR is_staff = 1 LIMIT 1").get();
  const staffEmbRows = staffRow
    ? prodDb.prepare("SELECT * FROM customer_embeddings WHERE customer_id = ? ORDER BY embedding_index ASC").all(staffRow.id)
    : [];
  prodDb.close();

  if (staffRow && staffEmbRows.length > 0) {
    sqlite.prepare("DELETE FROM customer_embeddings WHERE customer_id = ?").run(staffRow.id);
    sqlite.prepare("DELETE FROM customers WHERE id = ?").run(staffRow.id);
    sqlite.prepare(`
      INSERT INTO customers (id, name, status, is_staff, role, first_seen, last_seen, visit_count, appointment_count, best_face_score, thumbnail_path, thumbnail_base64, photos_json)
      VALUES (@id, @name, @status, @is_staff, @role, @first_seen, @last_seen, @visit_count, @appointment_count, @best_face_score, @thumbnail_path, @thumbnail_base64, @photos_json)
    `).run(staffRow);
    const insEmb = sqlite.prepare(`
      INSERT INTO customer_embeddings (customer_id, embedding_index, embedding_blob, sharpness_score, pose, pose_label)
      VALUES (@customer_id, @embedding_index, @embedding_blob, @sharpness_score, @pose, @pose_label)
    `);
    for (const emb of staffEmbRows) {
      insEmb.run(emb);
    }

    const cleanPhotos = staffRow.photos_json ? JSON.parse(staffRow.photos_json) : [];
    const cleanEmbeddings = staffEmbRows.map(r => ({
      vector: blobToVector(r.embedding_blob),
      pose: r.pose || "frontal",
      poseLabel: r.pose_label || "Frontal",
      sharpnessScore: r.sharpness_score || 0
    }));
    await db.collection("camera_catcher_people").doc(staffRow.id).set({
      id: staffRow.id,
      name: staffRow.name || "Barbero",
      isStaff: true,
      role: "barber",
      status: "frequent",
      bestFaceScore: staffRow.best_face_score || 0,
      thumbnailBase64: staffRow.thumbnail_base64 || null,
      photos: cleanPhotos,
      embeddings: cleanEmbeddings,
      embedding: cleanEmbeddings[0]?.vector || null
    }, { merge: false });
    console.log(`[StreamTest] 💈 Perfil 'staff_barbero' restaurado limpio desde data/barberia.db (${cleanEmbeddings.length} vectores).`);
  }

  sqlite.close();
  console.log(`[StreamTest] SQLite: ${sqliteAppts} citas y ${orphanIds.length} clientes sin citas eliminados.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.noClean) {
    const hasDate = typeof args.date === "string";
    await cleanDate(hasDate ? args.date : todayInLima(), !hasDate);
  } else {
    console.log("[StreamTest] --no-clean: no se borra ningún dato.");
  }

  const isLoop = args.loop === true;
  const isRealtime = args.realtime === true;
  console.log(`[StreamTest] 🎬 Modo: ${isLoop ? "Bucle continuo (--loop)" : "Una sola pasada (SIN BUCLE). El video correrá una vez y quedará pausado al finalizar."}`);
  console.log(`[StreamTest] ⏱️ Cadencia: ${isRealtime ? "Tiempo Real (~180ms inferencia, 10 FPS video)" : "Avance Rápido (FAST_FORWARD, 0ms intervalo)"}`);

  const targetDateStr = typeof args.date === "string" ? args.date : todayInLima();
  // Anclar el inicio comercial de la prueba a las 10:00:00 AM hora local de Lima (UTC-5)
  const baseLocal10Am = new Date(`${targetDateStr}T10:00:00.000-05:00`);
  const seekOffsetSec = parseInt(typeof args.start === "string" ? args.start : "2420", 10) || 0;
  const mockStartEpoch = baseLocal10Am.getTime() + (seekOffsetSec * 1000);
  console.log(`[StreamTest] 🕒 Reloj virtual anclado en: ${baseLocal10Am.toLocaleString("es-PE", { timeZone: TZ })} (Seek: ${seekOffsetSec}s -> inicio a las ${new Date(mockStartEpoch).toLocaleTimeString("es-PE", { timeZone: TZ })}).`);

  const env = {
    ...process.env,
    USE_FIREBASE: "true",
    FIRESTORE_DATABASE_ID: "test",
    STORAGE_BUCKET: "skip-bigotes-test",
    IS_LOCAL_SIMULATOR: "true",
    STREAM_START_EPOCH: String(mockStartEpoch),
    MOCK_VIDEO_PATH: typeof args.video === "string" ? args.video : "data/recordings/barberia_stream_7h.mp4",
    MOCK_VIDEO_START_SS: typeof args.start === "string" ? args.start : "2420",
    MOCK_VIDEO_DURATION_SS: typeof args.duration === "string" ? args.duration : (process.env.MOCK_VIDEO_DURATION_SS || ""),
    STREAM_FPS: typeof args.fps === "string" ? args.fps : (process.env.STREAM_FPS || "10"),
    ONNX_PROVIDER: "coreml",
    MOCK_VIDEO_LOOP: isLoop ? "true" : "false",
    STREAM_FAST_FORWARD: isRealtime ? "false" : "true",
    ENABLE_GDRIVE_RECORDING: "false",
    REALTIME_INTERVAL_MS: isRealtime ? (typeof args.interval === "string" ? args.interval : "180") : "0",
    PORT: "8085"
  };

  const entry = args.dev ? "scripts/dev-local.js" : "src/index.js";
  const maxMem = process.env.NODE_MAX_MEM || "4096";
  const nodeArgs = [`--max-old-space-size=${maxMem}`, entry];
  const child = spawn("node", nodeArgs, { env, stdio: "inherit" });
  const forward = (sig) => () => child.kill(sig);
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error("[StreamTest] Error:", err.message);
  process.exit(1);
});
