import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
import {
  parseArgs,
  getTimezoneOffsetString,
  calculateTimeWindow,
  parseChunkTimestamp,
  queryAppointments,
  queryLogs,
  findVideoChunks,
  formatReport,
  runIncidentQuery
} from "../scripts/query-incident.js";

const execFileAsync = promisify(execFile);

console.log("=== Suite de Pruebas: Herramienta CLI de Consulta de Incidentes ===");

// ----------------------------------------------------------------------------
// 1. Argument Parsing Tests
// ----------------------------------------------------------------------------
console.log("\n[1] Probando parseArgs...");
{
  const defaults = parseArgs([]);
  assert.strictEqual(defaults.date, null);
  assert.strictEqual(defaults.from, "00:00");
  assert.strictEqual(defaults.to, "23:59");
  assert.strictEqual(defaults.tz, "America/Lima");
  assert.strictEqual(defaults.db, "auto");
  assert.strictEqual(defaults.firestore, false);
  assert.strictEqual(defaults.gdrive, false);
  assert.strictEqual(defaults.allLogs, false);
  assert.strictEqual(defaults.json, false);

  const custom = parseArgs([
    "--date", "2026-10-24",
    "--from", "15:20",
    "--to", "16:10",
    "--tz", "America/Lima",
    "--db", "test",
    "--firestore",
    "--gdrive",
    "--all-logs",
    "--max-logs", "50",
    "--json",
    "--no-color"
  ]);

  assert.strictEqual(custom.date, "2026-10-24");
  assert.strictEqual(custom.from, "15:20");
  assert.strictEqual(custom.to, "16:10");
  assert.strictEqual(custom.tz, "America/Lima");
  assert.strictEqual(custom.db, "test");
  assert.strictEqual(custom.firestore, true);
  assert.strictEqual(custom.gdrive, true);
  assert.strictEqual(custom.allLogs, true);
  assert.strictEqual(custom.maxLogs, 50);
  assert.strictEqual(custom.json, true);
  assert.strictEqual(custom.noColor, true);

  // Sintaxis --flag=value
  const equalSyntax = parseArgs([
    "--date=2026-10-23",
    "--from=14:00",
    "--to=18:00",
    "--db=prod",
    "--max-logs=25"
  ]);
  assert.strictEqual(equalSyntax.date, "2026-10-23");
  assert.strictEqual(equalSyntax.from, "14:00");
  assert.strictEqual(equalSyntax.to, "18:00");
  assert.strictEqual(equalSyntax.db, "prod");
  assert.strictEqual(equalSyntax.maxLogs, 25);
  console.log("  ✓ parseArgs procesa banderas por espacio y por '=' con valores por defecto correctos");
}

// ----------------------------------------------------------------------------
// 2. Timezone & Window Calculation Tests
// ----------------------------------------------------------------------------
console.log("\n[2] Probando calculateTimeWindow y cálculo horario en America/Lima...");
{
  const offset = getTimezoneOffsetString("America/Lima", "2026-10-24");
  assert.strictEqual(offset, "-05:00", "Offset de Lima debe ser -05:00");

  const window = calculateTimeWindow({
    date: "2026-10-24",
    from: "15:20",
    to: "16:10",
    tz: "America/Lima"
  });

  // 15:20 Lima (UTC-5) -> 20:20 UTC
  // 16:10:59.999 Lima -> 21:10:59.999 UTC
  assert.strictEqual(window.startIsoUtc, "2026-10-24T20:20:00.000Z");
  assert.strictEqual(window.endIsoUtc, "2026-10-24T21:10:59.999Z");
  assert.strictEqual(window.folderDay1, "2026-10-24");
  assert.strictEqual(window.folderDay2, "2026-10-25");

  // Validaciones de error
  assert.throws(() => {
    calculateTimeWindow({ date: "fecha-invalida" });
  }, /formato YYYY-MM-DD/);

  assert.throws(() => {
    calculateTimeWindow({ date: "2026-10-24", from: "18:00", to: "12:00" });
  }, /no puede ser posterior/);

  console.log("  ✓ calculateTimeWindow calcula correctamente ventana UTC-5 y valida entradas");
}

// ----------------------------------------------------------------------------
// 3. Chunk Timestamp Parsing Tests
// ----------------------------------------------------------------------------
console.log("\n[3] Probando parseChunkTimestamp...");
{
  const parsed = parseChunkTimestamp("chunk_20261024_160005.mp4");
  assert.ok(parsed);
  assert.strictEqual(parsed.year, 2026);
  assert.strictEqual(parsed.month, 10);
  assert.strictEqual(parsed.day, 24);
  assert.strictEqual(parsed.hour, 16);
  assert.strictEqual(parsed.min, 0);
  assert.strictEqual(parsed.sec, 5);
  assert.strictEqual(parsed.epoch, Date.UTC(2026, 9, 24, 16, 0, 5));

  assert.strictEqual(parseChunkTimestamp("random_file.mp4"), null);
  assert.strictEqual(parseChunkTimestamp(""), null);
  assert.strictEqual(parseChunkTimestamp(null), null);
  console.log("  ✓ parseChunkTimestamp deserializa timestamps UTC de nombres de video");
}

// ----------------------------------------------------------------------------
// 4. SQLite Appointments Query Tests
// ----------------------------------------------------------------------------
console.log("\n[4] Probando queryAppointments con SQLite en memoria / temporal...");
{
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "incident_test_"));
  const tempDbPath = path.join(tempDir, "test_barberia.db");

  const db = new Database(tempDbPath);
  db.exec(`
    CREATE TABLE customers (
      id TEXT PRIMARY KEY,
      name TEXT,
      role TEXT,
      status TEXT,
      is_staff INTEGER DEFAULT 0,
      visit_count INTEGER DEFAULT 1
    );

    CREATE TABLE appointments (
      id TEXT PRIMARY KEY,
      chair_id TEXT NOT NULL,
      chair_name TEXT,
      client_id TEXT,
      client_name TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      started_epoch INTEGER,
      ended_epoch INTEGER,
      duration_minutes INTEGER DEFAULT 0,
      status TEXT DEFAULT 'completed',
      best_face_score REAL DEFAULT 0,
      photos_json TEXT
    );
  `);

  // Insertar cliente
  db.prepare(`
    INSERT INTO customers (id, name, role, status, is_staff, visit_count)
    VALUES ('cust_101', 'Carlos Gómez', 'client', 'frequent', 0, 4)
  `).run();

  // Insertar citas:
  // Cita 1: 15:30 a 16:00 Lima (20:30 a 21:00 UTC) -> DENTRO
  db.prepare(`
    INSERT INTO appointments (
      id, chair_id, chair_name, client_id, client_name, started_at, ended_at,
      started_epoch, ended_epoch, duration_minutes, status, best_face_score, photos_json
    ) VALUES (
      'appt_01', 'silla_puesto2', 'Silla 2', 'cust_101', 'Carlos Gómez',
      '2026-10-24T20:30:00.000Z', '2026-10-24T21:00:00.000Z',
      1792873800000, 1792875600000, 30, 'completed', 82.5,
      '[{"photo": "1"}, {"photo": "2"}, {"photo": "3"}]'
    )
  `).run();

  // Cita 2: 15:00 a 15:35 Lima (20:00 a 20:35 UTC) -> SOLAPADA AL INICIO
  db.prepare(`
    INSERT INTO appointments (
      id, chair_id, chair_name, client_id, client_name, started_at, ended_at,
      started_epoch, ended_epoch, duration_minutes, status, best_face_score, photos_json
    ) VALUES (
      'appt_02', 'silla_puesto1', 'Silla 1', NULL, 'Cliente Anónimo',
      '2026-10-24T20:00:00.000Z', '2026-10-24T20:35:00.000Z',
      1792872000000, 1792874100000, 35, 'completed', 74.0, '[]'
    )
  `).run();

  // Cita 3: 12:00 a 12:40 Lima (17:00 a 17:40 UTC) -> ANTES (FUERA)
  db.prepare(`
    INSERT INTO appointments (
      id, chair_id, chair_name, client_id, client_name, started_at, ended_at,
      started_epoch, ended_epoch, duration_minutes, status, best_face_score, photos_json
    ) VALUES (
      'appt_03', 'silla_puesto1', 'Silla 1', NULL, 'Cliente Madrugador',
      '2026-10-24T17:00:00.000Z', '2026-10-24T17:40:00.000Z',
      1792861200000, 1792863600000, 40, 'completed', 65.0, '[]'
    )
  `).run();

  // Cita 4: 18:00 a 18:30 Lima (23:00 a 23:30 UTC) -> DESPUÉS (FUERA)
  db.prepare(`
    INSERT INTO appointments (
      id, chair_id, chair_name, client_id, client_name, started_at, ended_at,
      started_epoch, ended_epoch, duration_minutes, status, best_face_score, photos_json
    ) VALUES (
      'appt_04', 'silla_puesto1', 'Silla 1', NULL, 'Cliente Tardío',
      '2026-10-24T23:00:00.000Z', '2026-10-24T23:30:00.000Z',
      1792882800000, 1792884600000, 30, 'completed', 70.0, '[]'
    )
  `).run();

  db.close();

  // Consultar ventana 15:20 a 16:10 Lima
  const windowInfo = calculateTimeWindow({
    date: "2026-10-24",
    from: "15:20",
    to: "16:10",
    tz: "America/Lima"
  });

  const appointments = queryAppointments(tempDbPath, windowInfo);
  assert.strictEqual(appointments.length, 2, "Deben encontrarse appt_02 y appt_01");

  const appt1 = appointments.find((a) => a.id === "appt_01");
  assert.ok(appt1);
  assert.strictEqual(appt1.clientName, "Carlos Gómez");
  assert.strictEqual(appt1.clientRole, "client");
  assert.strictEqual(appt1.clientStatus, "frequent");
  assert.strictEqual(appt1.durationMinutes, 30);
  assert.strictEqual(appt1.photosCount, 3);
  assert.strictEqual(appt1.bestFaceScore, 83);
  assert.strictEqual(appt1.horaInicio, "15:30:00");
  assert.strictEqual(appt1.horaFin, "16:00:00");

  const appt2 = appointments.find((a) => a.id === "appt_02");
  assert.ok(appt2);
  assert.strictEqual(appt2.clientName, "Cliente Anónimo");
  assert.strictEqual(appt2.photosCount, 0);

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("  ✓ queryAppointments filtra por ventana y mapea JOIN con customers adecuadamente");
}

// ----------------------------------------------------------------------------
// 5. Log Filtering Tests
// ----------------------------------------------------------------------------
console.log("\n[5] Probando queryLogs...");
async function testLogFiltering() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "incident_logs_"));
  const tempLogPath = path.join(tempDir, "mock_daemon.log");

  const lines = [
    // Fuera (antes)
    "[2026-10-24T20:10:00.000Z] [INFO] [Tracker] Personas rastreadas activas (1): #10",
    // Dentro - Clave
    "[2026-10-24T20:21:12.314Z] [INFO] [Appointment] 💺 Persona se sienta en Silla de barbero (Frente).",
    // Dentro - Ruido estático (debe omitirse por defecto)
    "[2026-10-24T20:21:13.000Z] [INFO] [Detector] Escena estática (variación 0.12% < umbral 1%).",
    // Dentro - Clave
    "[2026-10-24T20:21:18.089Z] [INFO] [Appointment] 🧹 Auto-eliminando perfil: Cluster coincide con Barbero/Staff",
    "[2026-10-24T20:25:00.120Z] [INFO] [CustomerService] ✅ Nuevo cliente sincronizado con Firestore: Cliente #5",
    "[2026-10-24T20:41:52.208Z] [INFO] [Appointment] 🔗 Tramo de 5 min consolidado en la atención en curso appt_99",
    "[2026-10-24T20:50:00.000Z] [WARN] [Stream] Pérdida de paquetes en sub-stream RTSP",
    "[2026-10-24T20:55:00.000Z] [ERROR] [Storage] Error al subir thumbnail temporal",
    // Fuera (después)
    "[2026-10-24T21:15:00.000Z] [INFO] [Appointment] 💺 Otra cita tarde"
  ];

  fs.writeFileSync(tempLogPath, lines.join("\n"), "utf8");

  const windowInfo = calculateTimeWindow({
    date: "2026-10-24",
    from: "15:20",
    to: "16:10",
    tz: "America/Lima"
  });

  const res = await queryLogs(tempLogPath, windowInfo, { allLogs: false });
  assert.strictEqual(res.exists, true);
  assert.strictEqual(res.totalInRange, 7, "Total de líneas dentro de la ventana horaria");
  // La línea de escena estática fue omitida en modo filtrado
  assert.strictEqual(res.lines.length, 6, "Líneas de log filtradas");

  const categories = res.lines.map((l) => l.category);
  assert.ok(categories.includes("appointment"));
  assert.ok(categories.includes("customer"));
  assert.ok(categories.includes("consolidation"));
  assert.ok(categories.includes("warn"));
  assert.ok(categories.includes("error"));

  // Verificar conversión horaria en logs
  const apptLine = res.lines.find((l) => l.category === "appointment");
  assert.strictEqual(apptLine.localTime, "15:21:12");
  assert.strictEqual(apptLine.utcTime, "20:21:12");

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("  ✓ queryLogs filtra correctamente por horario, suprime ruido y categoriza eventos");
}
await testLogFiltering();

// ----------------------------------------------------------------------------
// 6. Video Chunks Calculation Tests
// ----------------------------------------------------------------------------
console.log("\n[6] Probando findVideoChunks...");
{
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "incident_rec_"));
  const chunksDayDir = path.join(tempDir, "chunks_2026-10-24");
  fs.mkdirSync(chunksDayDir, { recursive: true });

  // Crear archivos mock de chunks
  // 15:00 - 15:15 Lima (20:00 - 20:15 UTC): Termina antes de 15:20 -> NO debe solaparse
  fs.writeFileSync(path.join(chunksDayDir, "chunk_20261024_200000.mp4"), "dummy-content");
  // 15:15 - 15:30 Lima (20:15 - 20:30 UTC): Termina a las 15:30 -> SÍ se solapa
  fs.writeFileSync(path.join(chunksDayDir, "chunk_20261024_201500.mp4"), "dummy-content");
  // 15:30 - 15:45 Lima (20:30 - 20:45 UTC): SÍ se solapa
  fs.writeFileSync(path.join(chunksDayDir, "chunk_20261024_203000.mp4"), "dummy-content");
  // 15:45 - 16:00 Lima (20:45 - 21:00 UTC): SÍ se solapa
  fs.writeFileSync(path.join(chunksDayDir, "chunk_20261024_204500.mp4"), "dummy-content");
  // 16:00 - 16:15 Lima (21:00 - 21:15 UTC): SÍ se solapa (hasta 16:10)
  fs.writeFileSync(path.join(chunksDayDir, "chunk_20261024_210000.mp4"), "dummy-content");
  // 16:15 - 16:30 Lima (21:15 - 21:30 UTC): Comienza después de 16:10 -> NO debe solaparse
  fs.writeFileSync(path.join(chunksDayDir, "chunk_20261024_211500.mp4"), "dummy-content");

  // Video de día completo
  fs.writeFileSync(path.join(tempDir, "barberia_2026-10-24.mp4"), "dummy-day-video");

  const windowInfo = calculateTimeWindow({
    date: "2026-10-24",
    from: "15:20",
    to: "16:10",
    tz: "America/Lima"
  });

  const res = findVideoChunks(tempDir, windowInfo);
  assert.strictEqual(res.exists, true);
  assert.strictEqual(res.chunks.length, 4, "Exactamente 4 chunks deben cubrir 15:20 a 16:10");

  const chunkNames = res.chunks.map((c) => c.fileName);
  assert.deepStrictEqual(chunkNames, [
    "chunk_20261024_201500.mp4",
    "chunk_20261024_203000.mp4",
    "chunk_20261024_204500.mp4",
    "chunk_20261024_210000.mp4"
  ]);

  assert.strictEqual(res.fullDayVideos.length, 1);
  assert.strictEqual(res.fullDayVideos[0].fileName, "barberia_2026-10-24.mp4");

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("  ✓ findVideoChunks calcula con precisión matemática qué chunks cubren el intervalo");
}

// ----------------------------------------------------------------------------
// 7. CLI End-to-End Integration Tests
// ----------------------------------------------------------------------------
console.log("\n[7] Probando ejecución CLI completa vía proceso secundario...");
async function testCliExecution() {
  const scriptPath = path.join(PROJECT_ROOT, "scripts", "query-incident.js");

  // Test 1: Salida estructurada JSON
  const { stdout: stdoutJson } = await execFileAsync("node", [
    scriptPath,
    "--date", "2026-10-24",
    "--from", "15:20",
    "--to", "16:10",
    "--db", "test",
    "--json"
  ]);

  const parsedJson = JSON.parse(stdoutJson);
  assert.ok(parsedJson.windowInfo);
  assert.strictEqual(parsedJson.windowInfo.date, "2026-10-24");
  assert.strictEqual(parsedJson.windowInfo.tz, "America/Lima");
  assert.ok(Array.isArray(parsedJson.appointments));
  assert.ok(Array.isArray(parsedJson.logs.lines));
  assert.ok(Array.isArray(parsedJson.recordings.chunks));

  // Test 2: Salida por consola formateada
  const { stdout: stdoutText } = await execFileAsync("node", [
    scriptPath,
    "--date", "2026-10-24",
    "--from", "15:20",
    "--to", "16:10",
    "--db", "test",
    "--no-color"
  ]);

  assert.ok(stdoutText.includes("CONSULTA DE INCIDENTES - BARBERÍA"));
  assert.ok(stdoutText.includes("[1] CITAS Y ATENCIONES"));
  assert.ok(stdoutText.includes("[2] EVENTOS CLAVE EN BITÁCORA"));
  assert.ok(stdoutText.includes("[3] CHUNKS DE VIDEO DE GRABACIÓN"));
  assert.ok(stdoutText.includes("appt_1792875586681_156"));
  assert.ok(stdoutText.includes("chunk_20261024_201746.mp4"));

  console.log("  ✓ Ejecución CLI produce JSON y texto formateado con tablas y eventos esperados");
}
await testCliExecution();

console.log("\n🎉 ¡Todos los tests de query-incident pasaron exitosamente!");
