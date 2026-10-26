#!/usr/bin/env node
/**
 * Herramienta CLI: Consulta Instantánea de Incidentes en la Barbería
 *
 * Permite auditar qué ocurrió en la barbería en una fecha y rango de horas específico,
 * correlacionando:
 * 1. Atenciones y Citas en SQLite (y/o Firestore)
 * 2. Eventos clave en la bitácora de logs (daemon.log): citas, vetos, consolidaciones, errores
 * 3. Chunks de video y grabaciones locales que cubren la ventana horaria (con soporte de Google Drive)
 *
 * Uso:
 *   node scripts/query-incident.js --date 2026-10-24 --from 15:20 --to 16:10
 *   npm run incident -- --date 2026-10-24 --from 15:20 --to 16:10 --db test
 *   node scripts/query-incident.js --date 2026-10-24 --help
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { loadEnvFile } from "../src/infrastructure/storage/gdrive_client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

// Cargar variables de entorno si existe .env
loadEnvFile(path.join(PROJECT_ROOT, ".env"));

// ============================================================================
// ANSI Color Helpers
// ============================================================================
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgCyan: "\x1b[46m\x1b[30m",
  bgYellow: "\x1b[43m\x1b[30m"
};

/**
 * Parsea los argumentos de línea de comandos.
 * @param {string[]} [argv]
 * @returns {Object}
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    date: null,
    from: "00:00",
    to: "23:59",
    tz: "America/Lima",
    db: "auto",
    firestore: false,
    gdrive: false,
    logFile: null,
    recordingsDir: null,
    allLogs: false,
    maxLogs: 80,
    json: false,
    noColor: Boolean(process.env.NO_COLOR),
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--date" || arg === "-d") {
      options.date = argv[++i];
    } else if (arg.startsWith("--date=")) {
      options.date = arg.slice(7);
    } else if (arg === "--from" || arg === "-f") {
      options.from = argv[++i];
    } else if (arg.startsWith("--from=")) {
      options.from = arg.slice(7);
    } else if (arg === "--to" || arg === "-t") {
      options.to = argv[++i];
    } else if (arg.startsWith("--to=")) {
      options.to = arg.slice(5);
    } else if (arg === "--tz") {
      options.tz = argv[++i];
    } else if (arg.startsWith("--tz=")) {
      options.tz = arg.slice(5);
    } else if (arg === "--db") {
      options.db = argv[++i];
    } else if (arg.startsWith("--db=")) {
      options.db = arg.slice(5);
    } else if (arg === "--firestore") {
      options.firestore = true;
    } else if (arg === "--gdrive") {
      options.gdrive = true;
    } else if (arg === "--log-file" || arg === "-l") {
      options.logFile = argv[++i];
    } else if (arg.startsWith("--log-file=")) {
      options.logFile = arg.slice(11);
    } else if (arg === "--recordings-dir" || arg === "-r") {
      options.recordingsDir = argv[++i];
    } else if (arg.startsWith("--recordings-dir=")) {
      options.recordingsDir = arg.slice(17);
    } else if (arg === "--all-logs") {
      options.allLogs = true;
    } else if (arg === "--max-logs") {
      options.maxLogs = Number(argv[++i]);
    } else if (arg.startsWith("--max-logs=")) {
      options.maxLogs = Number(arg.slice(11));
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--no-color") {
      options.noColor = true;
    }
  }

  return options;
}

/**
 * Obtiene el offset de la zona horaria en formato (+/-HH:MM).
 * @param {string} tz
 * @param {string} dateStr
 * @returns {string}
 */
export function getTimezoneOffsetString(tz = "America/Lima", dateStr = "2026-10-24") {
  if (!tz || tz === "America/Lima") return "-05:00";
  try {
    const d = new Date(`${dateStr}T12:00:00Z`);
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(d);
    const tzName = parts.find((p) => p.type === "timeZoneName")?.value || "";
    if (tzName === "GMT" || tzName === "UTC") return "+00:00";
    const m = tzName.match(/GMT([+-])(\d+)(?::(\d+))?/);
    if (m) {
      const sign = m[1];
      const h = m[2].padStart(2, "0");
      const min = (m[3] || "00").padStart(2, "0");
      return `${sign}${h}:${min}`;
    }
  } catch (_) {}
  return "-05:00";
}

/**
 * Normaliza una cadena de tiempo a formato HH:MM:SS
 * @param {string} str
 * @param {boolean} isEnd
 * @returns {string}
 */
function normalizeTimeString(str, isEnd = false) {
  if (!str) return isEnd ? "23:59:59.999" : "00:00:00";
  const parts = str.trim().split(":");
  const h = parts[0].padStart(2, "0");
  const m = (parts[1] || (isEnd ? "59" : "00")).padStart(2, "0");
  const s = (parts[2] || (isEnd ? "59.999" : "00")).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/**
 * Calcula la ventana temporal en UTC y horas locales a partir de los parámetros.
 * @param {Object} params
 * @param {string} params.date Fecha en formato YYYY-MM-DD
 * @param {string} [params.from='00:00']
 * @param {string} [params.to='23:59']
 * @param {string} [params.tz='America/Lima']
 * @returns {Object}
 */
export function calculateTimeWindow({ date, from = "00:00", to = "23:59", tz = "America/Lima" }) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("El parámetro --date es obligatorio y debe tener formato YYYY-MM-DD (ej: 2026-10-24)");
  }

  const offset = getTimezoneOffsetString(tz, date);
  const normFrom = normalizeTimeString(from, false);
  const normTo = normalizeTimeString(to, true);

  const startLocalIso = `${date}T${normFrom}${offset}`;
  const endLocalIso = `${date}T${normTo}${offset}`;

  const startEpoch = Date.parse(startLocalIso);
  const endEpoch = Date.parse(endLocalIso);

  if (Number.isNaN(startEpoch) || Number.isNaN(endEpoch)) {
    throw new Error(`Rango de fecha u hora no válido: ${date} ${from} -> ${to}`);
  }

  if (startEpoch > endEpoch) {
    throw new Error(`La hora de inicio (--from ${from}) no puede ser posterior a la de fin (--to ${to})`);
  }

  const startIsoUtc = new Date(startEpoch).toISOString();
  const endIsoUtc = new Date(endEpoch).toISOString();

  // Siguiente día en UTC (para cubrir posibles grabaciones que caen en el día UTC siguiente)
  const nextDay = new Date(Date.parse(`${date}T12:00:00Z`) + 86400000);
  const folderDay2 = nextDay.toISOString().slice(0, 10);

  return {
    date,
    from,
    to,
    tz,
    offset,
    normFrom,
    normTo,
    startEpoch,
    endEpoch,
    startIsoUtc,
    endIsoUtc,
    folderDay1: date,
    folderDay2
  };
}

/**
 * Resuelve la ruta al archivo SQLite objetivo.
 * @param {string} dbOption 'prod', 'test', '(default)', 'auto', o ruta a .db
 * @param {Object} [context]
 * @returns {{ path: string, label: string }}
 */
export function resolveDatabasePath(dbOption = "auto", context = {}) {
  const dataDir = context.dataDir || path.join(PROJECT_ROOT, "data");
  const prodPath = path.join(dataDir, "barberia.db");
  const testPath = path.join(dataDir, "barberia_test.db");

  if (dbOption === "prod" || dbOption === "(default)") {
    return { path: prodPath, label: "prod (barberia.db)" };
  }
  if (dbOption === "test") {
    return { path: testPath, label: "test (barberia_test.db)" };
  }
  if (dbOption !== "auto") {
    const customPath = path.isAbsolute(dbOption) ? dbOption : path.join(PROJECT_ROOT, dbOption);
    return { path: customPath, label: `personalizada (${dbOption})` };
  }

  // Modo AUTO: Buscar cuál de las bases de datos tiene atenciones en el intervalo solicitado
  const { startEpoch, endEpoch, startIsoUtc, endIsoUtc } = context;

  const checkDbHasRows = (filePath) => {
    if (!fs.existsSync(filePath)) return 0;
    try {
      const db = new Database(filePath, { readonly: true });
      const row = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM appointments WHERE 
            ((started_epoch IS NOT NULL AND started_epoch <= ?) AND (ended_epoch IS NULL OR ended_epoch >= ?))
            OR
            ((started_at <= ?) AND (ended_at IS NULL OR ended_at >= ?))`
        )
        .get(endEpoch || Infinity, startEpoch || 0, endIsoUtc || "9999", startIsoUtc || "0000");
      db.close();
      return row ? row.cnt : 0;
    } catch (_) {
      return 0;
    }
  };

  const prodCount = checkDbHasRows(prodPath);
  if (prodCount > 0) {
    return { path: prodPath, label: `prod (barberia.db - ${prodCount} citas encontradas)` };
  }

  const testCount = checkDbHasRows(testPath);
  if (testCount > 0) {
    return { path: testPath, label: `test (barberia_test.db - ${testCount} citas encontradas)` };
  }

  // Si ninguna tiene citas para ese intervalo, preferir prod si existe, sino test
  if (fs.existsSync(prodPath)) {
    return { path: prodPath, label: "prod (barberia.db - 0 citas)" };
  }
  return { path: testPath, label: "test (barberia_test.db - 0 citas)" };
}

/**
 * Consulta las atenciones en la base de datos SQLite especificada.
 * @param {string} dbPath
 * @param {Object} windowInfo
 * @returns {Array<Object>}
 */
export function queryAppointments(dbPath, windowInfo) {
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  let db;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    console.warn(`[SQLite] No se pudo abrir ${dbPath}: ${err.message}`);
    return [];
  }

  try {
    // Verificar si la tabla appointments existe
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='appointments'")
      .get();
    if (!tableExists) {
      db.close();
      return [];
    }

    const { startEpoch, endEpoch, startIsoUtc, endIsoUtc, tz } = windowInfo;

    const sql = `
      SELECT 
        a.id, a.chair_id, a.chair_name, a.client_id, a.client_name,
        a.started_at, a.ended_at, a.started_epoch, a.ended_epoch,
        a.duration_minutes, a.status AS appt_status, a.best_face_score, a.photos_json,
        c.name AS customer_name, c.role AS customer_role, c.status AS customer_status,
        c.visit_count, c.is_staff
      FROM appointments a
      LEFT JOIN customers c ON a.client_id = c.id
      WHERE 
        ((a.started_epoch IS NOT NULL AND a.started_epoch <= @endEpoch) AND (a.ended_epoch IS NULL OR a.ended_epoch >= @startEpoch))
        OR
        ((a.started_at <= @endIsoUtc) AND (a.ended_at IS NULL OR a.ended_at >= @startIsoUtc))
      ORDER BY COALESCE(a.started_epoch, a.started_at) ASC
    `;

    const rows = db.prepare(sql).all({
      startEpoch,
      endEpoch,
      startIsoUtc,
      endIsoUtc
    });

    return rows.map((row) => {
      let photoCount = 0;
      if (row.photos_json) {
        try {
          const parsed = JSON.parse(row.photos_json);
          photoCount = Array.isArray(parsed) ? parsed.length : 0;
        } catch (_) {}
      }

      // Resolver tiempos en formato local de la zona horaria
      const startMs = row.started_epoch || (row.started_at ? Date.parse(row.started_at) : null);
      const endMs = row.ended_epoch || (row.ended_at ? Date.parse(row.ended_at) : null);

      const horaInicioLocal = startMs
        ? new Date(startMs).toLocaleTimeString("es-PE", { timeZone: tz, hour12: false })
        : "N/A";
      const horaFinLocal = endMs
        ? new Date(endMs).toLocaleTimeString("es-PE", { timeZone: tz, hour12: false })
        : (row.appt_status === "in_progress" ? "En curso" : "N/A");

      let durationMin = row.duration_minutes;
      if (typeof durationMin !== "number" || durationMin <= 0) {
        if (startMs && endMs) {
          durationMin = Math.round((endMs - startMs) / 60000);
        } else {
          durationMin = 0;
        }
      }

      const clientName = row.customer_name || row.client_name || "Desconocido";
      const clientRole = row.customer_role || (row.is_staff ? "barber" : "client");
      const clientStatus = row.customer_status || row.appt_status || "completed";

      return {
        id: row.id,
        chairId: row.chair_id || "silla_barbero",
        chairName: row.chair_name || "Silla Principal",
        clientId: row.client_id || null,
        clientName,
        clientRole,
        clientStatus,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        startedEpoch: startMs,
        endedEpoch: endMs,
        horaInicio: horaInicioLocal,
        horaFin: horaFinLocal,
        durationMinutes: durationMin,
        status: row.appt_status || "completed",
        photosCount: photoCount,
        bestFaceScore: Math.round(row.best_face_score || 0),
        source: "sqlite"
      };
    });
  } catch (err) {
    console.warn(`[SQLite] Error al consultar appointments: ${err.message}`);
    return [];
  } finally {
    db.close();
  }
}

/**
 * Consulta citas en Firestore si está habilitado o solicitado.
 * @param {Object} windowInfo
 * @param {string} [databaseId='test']
 * @returns {Promise<Array<Object>>}
 */
export async function queryFirestoreAppointments(windowInfo, databaseId = "test") {
  try {
    const { initFirebaseAdmin } = await import("../src/infrastructure/firebase/firebase_admin.js");
    const { db } = initFirebaseAdmin({ databaseId });
    if (!db) return [];

    const { startEpoch, endEpoch, startIsoUtc, endIsoUtc, tz } = windowInfo;
    const snap = await db.collection("appointments").where("startedAt", "<=", endIsoUtc).get();

    const results = [];
    snap.forEach((doc) => {
      const data = doc.data();
      const startMs = data.startedEpoch || (data.startedAt ? Date.parse(data.startedAt) : null);
      const endMs = data.endedEpoch || (data.endedAt ? Date.parse(data.endedAt) : null);

      const overlaps =
        (startMs && startMs <= endEpoch && (!endMs || endMs >= startEpoch)) ||
        (data.startedAt && data.startedAt <= endIsoUtc && (!data.endedAt || data.endedAt >= startIsoUtc));

      if (overlaps) {
        const horaInicio = startMs ? new Date(startMs).toLocaleTimeString("es-PE", { timeZone: tz, hour12: false }) : "N/A";
        const horaFin = endMs ? new Date(endMs).toLocaleTimeString("es-PE", { timeZone: tz, hour12: false }) : "N/A";
        const photoCount = Array.isArray(data.photos) ? data.photos.length : 0;
        const durationMin = data.durationMinutes || (startMs && endMs ? Math.round((endMs - startMs) / 60000) : 0);

        results.push({
          id: doc.id,
          chairId: data.chairId || "silla_barbero",
          chairName: data.chairName || "Silla Principal",
          clientId: data.clientId || null,
          clientName: data.clientName || "Desconocido",
          clientRole: data.clientRole || "client",
          clientStatus: data.clientStatus || data.status || "completed",
          startedAt: data.startedAt,
          endedAt: data.endedAt,
          startedEpoch: startMs,
          endedEpoch: endMs,
          horaInicio,
          horaFin,
          durationMinutes: durationMin,
          status: data.status || "completed",
          photosCount: photoCount,
          bestFaceScore: Math.round(data.bestFaceScore || 0),
          source: "firestore"
        });
      }
    });

    results.sort((a, b) => (a.startedEpoch || 0) - (b.startedEpoch || 0));
    return results;
  } catch (err) {
    console.warn(`[Firestore] No se pudieron consultar citas de Firestore: ${err.message}`);
    return [];
  }
}

/**
 * Filtra y analiza las líneas relevantes del log del daemon dentro del intervalo de tiempo.
 * @param {string} logFilePath
 * @param {Object} windowInfo
 * @param {Object} [options]
 * @returns {Promise<{exists: boolean, lines: Array<Object>, totalInRange: number, keyEventsCount: number}>}
 */
export async function queryLogs(logFilePath, windowInfo, options = {}) {
  const targetPath = logFilePath || path.join(PROJECT_ROOT, "daemon.log");
  if (!fs.existsSync(targetPath)) {
    return { exists: false, lines: [], totalInRange: 0, keyEventsCount: 0, path: targetPath };
  }

  const { startEpoch, endEpoch, tz } = windowInfo;
  const maxLogs = typeof options.maxLogs === "number" ? options.maxLogs : 80;
  const allLogs = Boolean(options.allLogs);

  const fileStream = fs.createReadStream(targetPath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  const timestampRegex = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\]\s*(?:\[([A-Z]+)\])?\s*(.*)$/;
  const keyEventsRegex = /\[Appointment\]|\[CustomerService\]|\[Detector\]|\[Tracker\]|veto|consolid|error|fail|warn/i;

  let totalInRange = 0;
  let keyEventsCount = 0;
  const collected = [];

  let lastTrackerSignature = null;

  for await (const line of rl) {
    const match = line.match(timestampRegex);
    if (!match) continue;

    const [_, isoTs, level = "INFO", restMsg] = match;
    const epoch = Date.parse(isoTs);
    if (Number.isNaN(epoch)) continue;

    if (epoch >= startEpoch && epoch <= endEpoch) {
      totalInRange++;

      const isKey = keyEventsRegex.test(line);
      if (isKey) {
        keyEventsCount++;
      }

      // Filtrar ruido de latidos si allLogs === false:
      // Ignorar "Escena estática" y tracker con 0 personas
      if (!allLogs) {
        if (line.includes("Escena estática (variación")) {
          continue;
        }
        if (line.includes("Personas rastreadas activas (0): Ninguna")) {
          // Omitir líneas repetitivas de 0 personas a menos que sea una transición
          if (lastTrackerSignature === "0") continue;
          lastTrackerSignature = "0";
        } else if (line.includes("Personas rastreadas activas (")) {
          // Si es tracker, no saturar con ticks idénticos en milisegundos consecutivos
          const trackerSig = line.replace(/\[\d{4}-\d{2}-\d{2}T[^\]]+\]/, "").trim();
          if (trackerSig === lastTrackerSignature) {
            continue;
          }
          lastTrackerSignature = trackerSig;
        }
      }

      const localTime = new Date(epoch).toLocaleTimeString("es-PE", {
        timeZone: tz,
        hour12: false
      });
      const utcTime = isoTs.slice(11, 19);

      // Clasificar tipo de evento para colorear y destacar (priorizar específicos sobre genéricos)
      let category = "general";
      if (/\[ERROR\]|error|fail/i.test(line)) category = "error";
      else if (/veto/i.test(line)) category = "veto";
      else if (/consolid/i.test(line)) category = "consolidation";
      else if (/\[Appointment\]/i.test(line)) category = "appointment";
      else if (/\[CustomerService\]/i.test(line)) category = "customer";
      else if (/\[WARN\]|warning/i.test(line)) category = "warn";
      else if (/\[Tracker\]/i.test(line)) category = "tracker";
      else if (/\[Detector\]/i.test(line)) category = "detector";

      collected.push({
        isoTs,
        epoch,
        level,
        localTime,
        utcTime,
        category,
        rawText: line,
        message: restMsg
      });
    }
  }

  // Limitar resultados a maxLogs (mostrando los más relevantes o distribuidos)
  let resultLines = collected;
  if (!allLogs && collected.length > maxLogs) {
    // Si hay demasiados, priorizar eventos de alta importancia (Appointment, Customer, Veto, Error, Consolidación)
    const highPriority = collected.filter((l) =>
      ["appointment", "customer", "veto", "consolidation", "error", "warn"].includes(l.category)
    );
    if (highPriority.length >= maxLogs) {
      resultLines = highPriority.slice(0, maxLogs);
    } else {
      // Tomar todos los de alta prioridad y rellenar con tracker/detector
      const others = collected.filter(
        (l) => !["appointment", "customer", "veto", "consolidation", "error", "warn"].includes(l.category)
      );
      const remainingQuota = maxLogs - highPriority.length;
      resultLines = [...highPriority, ...others.slice(0, remainingQuota)].sort((a, b) => a.epoch - b.epoch);
    }
  }

  return {
    exists: true,
    path: targetPath,
    lines: resultLines,
    totalInRange,
    keyEventsCount,
    truncated: collected.length > resultLines.length
  };
}

/**
 * Extrae y calcula el epoch UTC del nombre de un archivo de chunk.
 * Formato esperado: chunk_YYYYMMDD_HHMMSS(.mp4)
 * @param {string} fileName
 * @returns {{year: number, month: number, day: number, hour: number, min: number, sec: number, epoch: number}|null}
 */
export function parseChunkTimestamp(fileName) {
  if (!fileName || typeof fileName !== "string") return null;
  const regex = /chunk_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/;
  const match = fileName.match(regex);
  if (!match) return null;

  const [_, y, mo, d, h, mi, s] = match;
  const epoch = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  return {
    year: +y,
    month: +mo,
    day: +d,
    hour: +h,
    min: +mi,
    sec: +s,
    epoch
  };
}

/**
 * Formatea bytes en formato legible (MB, GB)
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Escanea los directorios de grabaciones locales y determina qué chunks cubren la ventana.
 * @param {string} recordingsDir
 * @param {Object} windowInfo
 * @returns {Object}
 */
export function findVideoChunks(recordingsDir, windowInfo) {
  const baseDir = recordingsDir || path.join(PROJECT_ROOT, "data", "recordings");
  if (!fs.existsSync(baseDir)) {
    return { baseDir, exists: false, chunks: [], fullDayVideos: [] };
  }

  const { startEpoch, endEpoch, folderDay1, folderDay2, tz } = windowInfo;

  // Carpetas potenciales donde buscar chunks
  const candidateDirs = [
    path.join(baseDir, `chunks_${folderDay1}`),
    path.join(baseDir, folderDay1),
    path.join(baseDir, `chunks_${folderDay2}`),
    path.join(baseDir, folderDay2),
    baseDir
  ];

  const foundChunksMap = new Map();
  const fullDayVideos = [];

  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir)) continue;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;

        const fileName = entry.name;
        const filePath = path.join(dir, fileName);

        // Detectar si es un video de día completo (ej: barberia_2026-10-24.mp4)
        if (fileName.includes(folderDay1) && fileName.endsWith(".mp4") && !fileName.startsWith("chunk_")) {
          const stat = fs.statSync(filePath);
          fullDayVideos.push({
            fileName,
            filePath,
            sizeBytes: stat.size,
            sizeStr: formatBytes(stat.size)
          });
          continue;
        }

        // Si es un chunk
        const parsed = parseChunkTimestamp(fileName);
        if (!parsed) continue;

        if (!foundChunksMap.has(fileName)) {
          const stat = fs.statSync(filePath);
          foundChunksMap.set(fileName, {
            fileName,
            filePath,
            startEpoch: parsed.epoch,
            sizeBytes: stat.size,
            sizeStr: formatBytes(stat.size)
          });
        }
      }
    } catch (_) {}
  }

  // Ordenar todos los chunks cronológicamente para calcular duraciones
  const allChunks = Array.from(foundChunksMap.values()).sort((a, b) => a.startEpoch - b.startEpoch);

  const matchedChunks = [];
  const DEFAULT_CHUNK_DURATION_MS = 15 * 60 * 1000; // 15 min

  for (let i = 0; i < allChunks.length; i++) {
    const chunk = allChunks[i];
    const nextChunk = allChunks[i + 1];

    let endEpochChunk;
    if (nextChunk && nextChunk.startEpoch > chunk.startEpoch && nextChunk.startEpoch - chunk.startEpoch <= 25 * 60 * 1000) {
      endEpochChunk = nextChunk.startEpoch;
    } else {
      endEpochChunk = chunk.startEpoch + DEFAULT_CHUNK_DURATION_MS;
    }

    // Regla de solapamiento de intervalos:
    // [chunk.startEpoch, endEpochChunk] se solapa con [startEpoch, endEpoch]
    const overlaps = chunk.startEpoch < endEpoch && endEpochChunk > startEpoch;

    if (overlaps) {
      const localStart = new Date(chunk.startEpoch).toLocaleTimeString("es-PE", {
        timeZone: tz,
        hour12: false
      });
      const localEnd = new Date(endEpochChunk).toLocaleTimeString("es-PE", {
        timeZone: tz,
        hour12: false
      });
      const utcStart = new Date(chunk.startEpoch).toISOString().slice(11, 19);
      const utcEnd = new Date(endEpochChunk).toISOString().slice(11, 19);

      matchedChunks.push({
        fileName: chunk.fileName,
        filePath: chunk.filePath,
        startEpoch: chunk.startEpoch,
        endEpoch: endEpochChunk,
        durationMinutes: Math.round((endEpochChunk - chunk.startEpoch) / 60000),
        localStart,
        localEnd,
        utcStart,
        utcEnd,
        sizeBytes: chunk.sizeBytes,
        sizeStr: chunk.sizeStr
      });
    }
  }

  return {
    baseDir,
    exists: true,
    chunks: matchedChunks,
    fullDayVideos
  };
}

/**
 * Consulta chunks archivados en Google Drive si se especifica la opción.
 * @param {Object} windowInfo
 * @returns {Promise<Array<Object>>}
 */
export async function queryGoogleDriveChunks(windowInfo) {
  try {
    const { GoogleDriveClient } = await import("../src/infrastructure/storage/gdrive_client.js");
    const gdriveClient = new GoogleDriveClient();
    const rootFolderId = await gdriveClient.ensureRootFolder();
    const { folderDay1, folderDay2, startEpoch, endEpoch, tz } = windowInfo;

    const driveFiles = [];
    for (const fName of [folderDay1, folderDay2]) {
      const folder = await gdriveClient.findFolder(fName, rootFolderId);
      if (folder) {
        const files = await gdriveClient.listFiles(folder.id);
        for (const file of files) {
          const parsed = parseChunkTimestamp(file.name);
          if (parsed) {
            driveFiles.push({
              fileName: file.name,
              fileId: file.id,
              startEpoch: parsed.epoch,
              sizeBytes: Number(file.size) || 0
            });
          }
        }
      }
    }

    driveFiles.sort((a, b) => a.startEpoch - b.startEpoch);
    const matched = [];
    for (let i = 0; i < driveFiles.length; i++) {
      const chunk = driveFiles[i];
      const nextChunk = driveFiles[i + 1];
      const endEpochChunk =
        nextChunk && nextChunk.startEpoch > chunk.startEpoch && nextChunk.startEpoch - chunk.startEpoch <= 25 * 60 * 1000
          ? nextChunk.startEpoch
          : chunk.startEpoch + 15 * 60 * 1000;

      if (chunk.startEpoch < endEpoch && endEpochChunk > startEpoch) {
        matched.push({
          fileName: chunk.fileName,
          fileId: chunk.fileId,
          startEpoch: chunk.startEpoch,
          endEpoch: endEpochChunk,
          durationMinutes: Math.round((endEpochChunk - chunk.startEpoch) / 60000),
          localStart: new Date(chunk.startEpoch).toLocaleTimeString("es-PE", { timeZone: tz, hour12: false }),
          localEnd: new Date(endEpochChunk).toLocaleTimeString("es-PE", { timeZone: tz, hour12: false }),
          utcStart: new Date(chunk.startEpoch).toISOString().slice(11, 19),
          utcEnd: new Date(endEpochChunk).toISOString().slice(11, 19),
          sizeBytes: chunk.sizeBytes,
          sizeStr: formatBytes(chunk.sizeBytes),
          driveLink: `https://drive.google.com/file/d/${chunk.fileId}/view`
        });
      }
    }
    return matched;
  } catch (_) {
    return [];
  }
}

/**
 * Formatea y renderiza el reporte completo por consola.
 * @param {Object} reportData
 * @param {Object} [options]
 * @returns {string}
 */
export function formatReport(reportData, options = {}) {
  const noColor = Boolean(options.noColor);
  const color = (code, str) => (noColor ? str : `${code}${str}${C.reset}`);

  const { windowInfo, dbInfo, appointments, logs, recordings, gdriveChunks } = reportData;

  const lines = [];

  // Encabezado principal
  lines.push(color(C.cyan, "================================================================================"));
  lines.push(color(C.bold + C.cyan, " 🔍 CONSULTA DE INCIDENTES - BARBERÍA"));
  lines.push(color(C.cyan, "================================================================================"));
  lines.push(`📅 ${color(C.bold, "Fecha:")}           ${windowInfo.date}`);
  lines.push(
    `⏱️  ${color(C.bold, "Rango Local:")}     ${windowInfo.normFrom} ➔ ${windowInfo.normTo} (${windowInfo.tz})`
  );
  lines.push(
    `🌐 ${color(C.bold, "Ventana UTC:")}      ${windowInfo.startIsoUtc} ➔ ${windowInfo.endIsoUtc}`
  );
  lines.push(`🗄️  ${color(C.bold, "Base de Datos:")}   ${dbInfo.label}`);
  lines.push(`📄 ${color(C.bold, "Archivo de Logs:")} ${logs.path || "N/A"}`);
  lines.push(color(C.cyan, "================================================================================"));
  lines.push("");

  // --------------------------------------------------------------------------
  // [A] Citas y Atenciones (Appointments)
  // --------------------------------------------------------------------------
  lines.push(color(C.bold + C.yellow, "─── [1] CITAS Y ATENCIONES (APPOINTMENTS) ──────────────────────────────────────"));
  if (appointments.length === 0) {
    lines.push(color(C.dim, "  ℹ️  No se encontraron atenciones registradas en el intervalo seleccionado."));
  } else {
    lines.push(`  Se encontraron ${color(C.bold, String(appointments.length))} atenciones en este período:\n`);

    // Formatear tabla de atenciones
    const headers = ["ID", "Silla", "Cliente (Rol / Status)", "Inicio", "Fin", "Dur.", "Fotos", "Score"];
    const rows = appointments.map((a) => {
      const clientStr = `${a.clientName} (${a.clientRole}/${a.clientStatus})`;
      const durStr = `${a.durationMinutes}m`;
      const scoreStr = `${a.bestFaceScore}`;
      const photosStr = `${a.photosCount}`;
      return [a.id, a.chairName, clientStr, a.horaInicio, a.horaFin, durStr, photosStr, scoreStr];
    });

    // Calcular ancho de columnas
    const colWidths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));

    // Render tabla Markdown / ANSI
    const renderRow = (cells, isHeader = false) => {
      const padded = cells.map((cell, idx) => cell.padEnd(colWidths[idx]));
      const rowText = `| ${padded.join(" | ")} |`;
      return isHeader ? color(C.bold, rowText) : rowText;
    };

    lines.push(renderRow(headers, true));
    lines.push(`|${colWidths.map((w) => "-".repeat(w + 2)).join("|")}|`);
    for (const r of rows) {
      lines.push(renderRow(r, false));
    }
  }
  lines.push("");

  // --------------------------------------------------------------------------
  // [B] Eventos Clave en Logs
  // --------------------------------------------------------------------------
  lines.push(color(C.bold + C.yellow, "─── [2] EVENTOS CLAVE EN BITÁCORA (LOGS) ─────────────────────────────────────────"));
  if (!logs.exists) {
    lines.push(color(C.dim, `  ℹ️  Archivo de log no encontrado (${logs.path}).`));
  } else if (logs.lines.length === 0) {
    lines.push(
      color(
        C.dim,
        `  ℹ️  No se encontraron líneas de log en la ventana (${logs.totalInRange} totales, ${logs.keyEventsCount} eventos clave).`
      )
    );
  } else {
    lines.push(
      `  Total líneas en ventana: ${logs.totalInRange} | Eventos clave: ${logs.keyEventsCount} | Mostrando: ${logs.lines.length}${
        logs.truncated ? color(C.dim, " (usa --all-logs o --max-logs para ver más)") : ""
      }\n`
    );

    for (const item of logs.lines) {
      let tagColor = C.white;

      if (item.category === "appointment") {
        tagColor = C.cyan;
      } else if (item.category === "customer") {
        tagColor = C.green;
      } else if (item.category === "veto") {
        tagColor = C.bold + C.magenta;
      } else if (item.category === "consolidation") {
        tagColor = C.bold + C.blue;
      } else if (item.category === "error") {
        tagColor = C.bold + C.red;
      } else if (item.category === "warn") {
        tagColor = C.yellow;
      } else if (item.category === "tracker" || item.category === "detector") {
        tagColor = C.dim;
      }

      const timeTag = color(C.dim, `[${item.localTime} PE / ${item.utcTime}Z]`);
      const coloredMsg = color(tagColor, item.rawText.replace(/^\[[^\]]+\]\s*/, ""));
      lines.push(`  ${timeTag} ${coloredMsg}`);
    }
  }
  lines.push("");

  // --------------------------------------------------------------------------
  // [C] Chunks de Video de Grabación
  // --------------------------------------------------------------------------
  lines.push(color(C.bold + C.yellow, "─── [3] CHUNKS DE VIDEO DE GRABACIÓN ──────────────────────────────────────────"));
  if (!recordings.exists) {
    lines.push(color(C.dim, `  ℹ️  Directorio de grabaciones no encontrado (${recordings.baseDir}).`));
  } else if (recordings.chunks.length === 0 && (!gdriveChunks || gdriveChunks.length === 0)) {
    lines.push(
      color(C.dim, `  ℹ️  No se encontraron chunks de video que cubran el intervalo en ${recordings.baseDir}.`)
    );
  } else {
    if (recordings.chunks.length > 0) {
      lines.push(`  Chunks de video locales que cubren exactamente esta ventana (${recordings.chunks.length} archivos):\n`);

      for (const chunk of recordings.chunks) {
        lines.push(`  ${color(C.green, "✓")} ${color(C.bold, chunk.fileName)} (${chunk.sizeStr})`);
        lines.push(`    • Ruta:           ${color(C.dim, chunk.filePath)}`);
        lines.push(
          `    • Cobertura PE:   ${chunk.localStart} ➔ ${chunk.localEnd} (${chunk.durationMinutes} min)`
        );
        lines.push(`    • Cobertura UTC:  ${chunk.utcStart} ➔ ${chunk.utcEnd} UTC`);
        lines.push("");
      }
    }

    if (gdriveChunks && gdriveChunks.length > 0) {
      lines.push(color(C.bold, `  ☁️ Chunks respaldados en Google Drive (${gdriveChunks.length} archivos):`));
      for (const driveChunk of gdriveChunks) {
        lines.push(`    • ${driveChunk.fileName} (${driveChunk.sizeStr}) -> ID: ${driveChunk.fileId}`);
        lines.push(`      Enlace: ${color(C.dim, driveChunk.driveLink)}`);
      }
      lines.push("");
    }
  }

  // Videos de día completo si existen
  if (recordings.fullDayVideos && recordings.fullDayVideos.length > 0) {
    lines.push(color(C.bold, "  🎬 Video(s) de día completo disponible(s):"));
    for (const v of recordings.fullDayVideos) {
      lines.push(`    • ${v.fileName} (${v.sizeStr}) -> ${v.filePath}`);

      // Generar comando útil de recorte / visualización FFmpeg
      const durationSec = Math.max(60, Math.round((windowInfo.endEpoch - windowInfo.startEpoch) / 1000));
      lines.push(
        `      💡 Comando para reproducir/extraer: ` +
          color(
            C.cyan,
            `ffplay -ss ${windowInfo.normFrom.slice(0, 8)} -t ${durationSec} "${v.filePath}"`
          )
      );
    }
    lines.push("");
  }

  lines.push(color(C.cyan, "================================================================================"));
  return lines.join("\n");
}

/**
 * Función principal para ejecutar la consulta de incidentes.
 * @param {Object} options
 * @returns {Promise<Object>}
 */
export async function runIncidentQuery(options = {}) {
  const windowInfo = calculateTimeWindow(options);
  const dbInfo = resolveDatabasePath(options.db, {
    startEpoch: windowInfo.startEpoch,
    endEpoch: windowInfo.endEpoch,
    startIsoUtc: windowInfo.startIsoUtc,
    endIsoUtc: windowInfo.endIsoUtc
  });

  let appointments = queryAppointments(dbInfo.path, windowInfo);

  if (options.firestore) {
    const fsAppointments = await queryFirestoreAppointments(windowInfo, options.db === "prod" ? "(default)" : "test");
    if (fsAppointments.length > 0) {
      // Unir evitando duplicados por ID
      const ids = new Set(appointments.map((a) => a.id));
      for (const fa of fsAppointments) {
        if (!ids.has(fa.id)) {
          appointments.push(fa);
          ids.add(fa.id);
        }
      }
    }
  }

  const logs = await queryLogs(options.logFile, windowInfo, {
    allLogs: options.allLogs,
    maxLogs: options.maxLogs
  });
  const recordings = findVideoChunks(options.recordingsDir, windowInfo);

  let gdriveChunks = [];
  if (options.gdrive) {
    gdriveChunks = await queryGoogleDriveChunks(windowInfo);
  }

  return {
    windowInfo,
    dbInfo,
    appointments,
    logs,
    recordings,
    gdriveChunks
  };
}

/**
 * Muestra la ayuda de uso CLI
 */
export function showHelp() {
  console.log(`
${C.bold + C.cyan}Uso:${C.reset}
  node scripts/query-incident.js --date <YYYY-MM-DD> [opciones]
  npm run incident -- --date <YYYY-MM-DD> [opciones]

${C.bold + C.yellow}Opciones obligatorias:${C.reset}
  --date, -d <YYYY-MM-DD>       Fecha a consultar (ej: 2026-10-24). Requerido.

${C.bold + C.yellow}Opciones de tiempo:${C.reset}
  --from, -f <HH:MM|HH:MM:SS>   Hora inicial local (por defecto: '00:00')
  --to, -t <HH:MM|HH:MM:SS>     Hora final local (por defecto: '23:59')
  --tz <zona_horaria>           Zona horaria IANA (por defecto: 'America/Lima')

${C.bold + C.yellow}Opciones de datos y almacenamiento:${C.reset}
  --db <prod|test|auto|ruta>    Base de datos SQLite objetivo (por defecto: 'auto')
  --firestore                   Consulta y combina también atenciones de Firestore
  --gdrive                      Consulta chunks respaldados en Google Drive
  --log-file, -l <ruta>         Ruta al archivo daemon.log (por defecto: 'daemon.log')
  --recordings-dir, -r <ruta>   Directorio de grabaciones (por defecto: 'data/recordings')
  --all-logs                    Muestra todos los logs sin omitir latidos repetitivos
  --max-logs <numero>           Límite de líneas de log a mostrar (por defecto: 80)
  --json                        Devuelve el reporte estructurado en JSON
  --no-color                    Deshabilita estilos y colores ANSI
  --help, -h                    Muestra esta ayuda

${C.bold + C.green}Ejemplos:${C.reset}
  node scripts/query-incident.js --date 2026-10-24 --from 15:20 --to 16:10
  npm run incident -- --date 2026-10-24 --from 15:00 --to 17:00 --db test
  node scripts/query-incident.js --date 2026-10-24 --from 15:20 --to 16:10 --all-logs
`);
}

/**
 * Entrada principal CLI
 */
export async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  if (!options.date) {
    console.error(`\x1b[31m❌ Error: Debes especificar la fecha con --date YYYY-MM-DD\x1b[0m\n`);
    showHelp();
    process.exit(1);
  }

  try {
    const reportData = await runIncidentQuery(options);

    if (options.json) {
      console.log(JSON.stringify(reportData, null, 2));
    } else {
      console.log(formatReport(reportData, { noColor: options.noColor }));
    }
  } catch (err) {
    console.error(`\x1b[31m❌ Error ejecutando consulta de incidentes: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

// Ejecutar si se invoca directamente desde CLI
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  main();
}
