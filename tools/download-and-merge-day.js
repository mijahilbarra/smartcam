#!/usr/bin/env node
/**
 * Herramienta CLI: Descarga y concatenación de chunks de video desde Google Drive
 * correspondientes a un día solicitado en la Zona Horaria de Perú (America/Lima, UTC-5).
 *
 * Uso:
 *   node tools/download-and-merge-day.js --date 2026-10-24
 *   npm run download:day -- --date 2026-10-24 --dry-run
 *   npm run download:day -- --date 2026-10-24 --clean-chunks
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { GoogleDriveClient, loadEnvFile } from "../src/infrastructure/storage/gdrive_client.js";

const execFileAsync = promisify(execFile);

/**
 * Parsea los argumentos de línea de comandos.
 * @param {string[]} [argv]
 * @returns {Object}
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    date: null,
    output: null,
    chunksDir: null,
    cleanChunks: false,
    force: false,
    dryRun: false,
    tz: "America/Lima",
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
    } else if (arg === "--output" || arg === "-o") {
      options.output = argv[++i];
    } else if (arg.startsWith("--output=")) {
      options.output = arg.slice(9);
    } else if (arg === "--chunks-dir" || arg === "-c") {
      options.chunksDir = argv[++i];
    } else if (arg.startsWith("--chunks-dir=")) {
      options.chunksDir = arg.slice(13);
    } else if (arg === "--clean-chunks") {
      options.cleanChunks = true;
    } else if (arg === "--force" || arg === "-f") {
      options.force = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--tz") {
      options.tz = argv[++i];
    } else if (arg.startsWith("--tz=")) {
      options.tz = arg.slice(5);
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
 * Calcula los límites de epoch para un día local y las 2 carpetas UTC requeridas.
 * @param {string} dateStr YYYY-MM-DD
 * @param {string} [tz='America/Lima']
 * @returns {{startOfDay: number, endOfDay: number, folderDay1: string, folderDay2: string, offset: string}}
 */
export function calculateDateRange(dateStr, tz = "America/Lima") {
  const offset = getTimezoneOffsetString(tz, dateStr);
  const startOfDay = Date.parse(`${dateStr}T00:00:00${offset}`);
  const endOfDay = Date.parse(`${dateStr}T23:59:59.999${offset}`);

  // Siguiente día en UTC para cubrir la noche del día en Perú
  const nextDay = new Date(Date.parse(`${dateStr}T12:00:00Z`) + 86400000);
  const folderDay2 = nextDay.toISOString().slice(0, 10);

  return {
    startOfDay,
    endOfDay,
    folderDay1: dateStr,
    folderDay2,
    offset
  };
}

/**
 * Extrae y calcula el epoch UTC del nombre de un chunk de video.
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
 * Filtra los chunks que caen en el día solicitado según la zona horaria y los ordena cronológicamente.
 * @param {Array<Object>} files Lista de archivos con propiedades { name, id, size, ... }
 * @param {string} dateStr Fecha en formato YYYY-MM-DD
 * @param {string} [tz='America/Lima']
 * @returns {Array<Object>}
 */
export function filterAndSortDayChunks(files, dateStr, tz = "America/Lima") {
  const { startOfDay, endOfDay } = calculateDateRange(dateStr, tz);
  const matched = [];

  for (const file of files) {
    const parsed = parseChunkTimestamp(file.name);
    if (!parsed) continue;

    if (parsed.epoch >= startOfDay && parsed.epoch <= endOfDay) {
      const localTime = new Date(parsed.epoch).toLocaleString("es-PE", {
        timeZone: tz,
        hour12: true
      });
      matched.push({
        ...file,
        epoch: parsed.epoch,
        localTime
      });
    }
  }

  matched.sort((a, b) => a.epoch - b.epoch);
  return matched;
}

/**
 * Formatea bytes en cadena legible (KB, MB, GB).
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return "0 B";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

/**
 * Formatea segundos a HH:MM:SS.
 * @param {number} sec
 * @returns {string}
 */
export function formatDuration(sec) {
  if (!sec || isNaN(sec)) return "00:00:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Imprime la ayuda del comando en consola.
 */
function printHelp() {
  console.log(`
Uso: node tools/download-and-merge-day.js --date <YYYY-MM-DD> [opciones]

Opciones:
  --date, -d <YYYY-MM-DD>     (Requerido) Fecha del día en horario local (ej: 2026-10-24)
  --output, -o <path>         (Opcional) Ruta del video MP4 final concatenado
                              (Por defecto: data/recordings/barberia_<YYYY-MM-DD>.mp4)
  --chunks-dir, -c <path>     (Opcional) Directorio donde almacenar chunks descargados
                              (Por defecto: data/recordings/chunks_<YYYY-MM-DD>/)
  --clean-chunks              (Flag) Elimina los chunks y concat_list tras finalizar con éxito
  --force, -f                 (Flag) Fuerza la re-descarga de chunks aunque existan en caché
  --dry-run                   (Flag) Lista los chunks y horas de Perú sin descargar ni unir
  --tz <zona_horaria>         (Opcional) Zona horaria objetivo (Por defecto: America/Lima)
  --help, -h                  Muestra este mensaje de ayuda
`);
}

/**
 * Ejecuta el proceso completo de búsqueda, filtrado, descarga y concatenación.
 * @param {Object} options
 * @param {GoogleDriveClient} [injectedClient]
 * @returns {Promise<Object>}
 */
export async function downloadAndMergeDay(options = {}, injectedClient = null) {
  const dateStr = options.date;
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error("El parámetro --date es obligatorio y debe tener formato YYYY-MM-DD (ej: 2026-10-24)");
  }

  const tz = options.tz || "America/Lima";
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const cleanChunks = Boolean(options.cleanChunks);

  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const defaultOutputDir = path.join(projectRoot, "data", "recordings");
  const outputPath = options.output
    ? path.resolve(process.cwd(), options.output)
    : path.join(defaultOutputDir, `barberia_${dateStr}.mp4`);

  const chunksDir = options.chunksDir
    ? path.resolve(process.cwd(), options.chunksDir)
    : path.join(defaultOutputDir, `chunks_${dateStr}`);

  const { startOfDay, endOfDay, folderDay1, folderDay2, offset } = calculateDateRange(dateStr, tz);

  console.log("\x1b[36m%s\x1b[0m", "================================================================");
  console.log("\x1b[36m%s\x1b[0m", ` 🎥 IOT Camera Catcher - Fusión Diaria (${tz}, ${offset})`);
  console.log("\x1b[36m%s\x1b[0m", "================================================================");
  console.log(`📅 Fecha solicitada: ${dateStr} (00:00:00 a 23:59:59 ${offset})`);
  console.log(`🌐 Carpetas Google Drive (UTC): '${folderDay1}' y '${folderDay2}'`);
  console.log(`🎬 Archivo MP4 destino: ${outputPath}`);
  console.log(`📂 Directorio de chunks: ${chunksDir}`);
  if (dryRun) console.log(`🔍 MODO DRY-RUN ACTIVADO (No se descargarán archivos)`);

  const driveClient = injectedClient || new GoogleDriveClient();

  // 1. Obtener ID de la carpeta raíz
  const rootFolderId = await driveClient.ensureRootFolder();
  console.log(`\n📁 Carpeta raíz de Drive: ${driveClient.rootFolderName} (ID: ${rootFolderId})`);

  // 2. Localizar ambas carpetas diarias en Drive
  const [folder1, folder2] = await Promise.all([
    driveClient.findFolder(folderDay1, rootFolderId),
    driveClient.findFolder(folderDay2, rootFolderId)
  ]);

  if (!folder1 && !folder2) {
    console.warn(`\x1b[33m[Aviso] No se encontró ninguna de las carpetas ('${folderDay1}', '${folderDay2}') en Google Drive.\x1b[0m`);
    return { success: false, totalChunks: 0, reason: "folders_not_found" };
  }

  console.log(`📂 Carpeta '${folderDay1}': ${folder1 ? `Encontrada (ID: ${folder1.id})` : "No existe en Drive"}`);
  console.log(`📂 Carpeta '${folderDay2}': ${folder2 ? `Encontrada (ID: ${folder2.id})` : "No existe en Drive"}`);

  // 3. Listar archivos de ambas carpetas
  const filesFolder1 = folder1 ? await driveClient.listFiles(folder1.id) : [];
  const filesFolder2 = folder2 ? await driveClient.listFiles(folder2.id) : [];

  console.log(`📄 Archivos encontrados: ${filesFolder1.length} en '${folderDay1}', ${filesFolder2.length} en '${folderDay2}'`);

  // 4. Filtrar y ordenar por zona horaria
  const matchedChunks = filterAndSortDayChunks([...filesFolder1, ...filesFolder2], dateStr, tz);

  if (matchedChunks.length === 0) {
    console.warn(`\x1b[33m[Aviso] No se encontraron chunks correspondientes a la fecha ${dateStr} en horario ${tz}.\x1b[0m`);
    return { success: false, totalChunks: 0, reason: "no_matching_chunks" };
  }

  const totalRawBytes = matchedChunks.reduce((acc, c) => acc + (c.size || 0), 0);
  console.log(`\n✅ Chunks válidos para el día ${dateStr} (${tz}): \x1b[32m${matchedChunks.length}\x1b[0m`);
  console.log(`⏱️  Rango horario: ${matchedChunks[0].localTime} ➔ ${matchedChunks[matchedChunks.length - 1].localTime}`);
  console.log(`💾 Tamaño acumulado en Drive: ${formatBytes(totalRawBytes)}`);

  // 5. En caso de Dry Run, mostrar detalle y retornar
  if (dryRun) {
    console.log("\n📋 Desglose detallado de chunks (Dry Run):");
    matchedChunks.forEach((c, idx) => {
      console.log(
        `  [${String(idx + 1).padStart(2, " ")}/${matchedChunks.length}] ${c.name.padEnd(28)} | Hora Local: ${c.localTime.padEnd(24)} | Tamaño: ${formatBytes(c.size).padStart(9)}`
      );
    });
    console.log(`\n🔍 [Dry Run] Verificación completada sin descargas ni concatenación.`);
    return {
      success: true,
      dryRun: true,
      totalChunks: matchedChunks.length,
      totalBytes: totalRawBytes,
      chunks: matchedChunks
    };
  }

  // 6. Descargar chunks a disco local
  if (!fs.existsSync(chunksDir)) {
    fs.mkdirSync(chunksDir, { recursive: true });
  }

  console.log(`\n📥 Iniciando descarga de ${matchedChunks.length} chunks a '${chunksDir}'...`);
  const downloadedPaths = [];

  for (let i = 0; i < matchedChunks.length; i++) {
    const chunk = matchedChunks[i];
    const destPath = path.join(chunksDir, chunk.name);
    const prefix = `[${String(i + 1).padStart(2, " ")}/${matchedChunks.length}]`;

    // Comprobación de caché
    if (!force && fs.existsSync(destPath)) {
      const stat = fs.statSync(destPath);
      if (stat.size === chunk.size && chunk.size > 0) {
        console.log(`${prefix} [En caché] ${chunk.name} (${formatBytes(chunk.size)})`);
        downloadedPaths.push(destPath);
        continue;
      }
    }

    process.stdout.write(`${prefix} 📥 Descargando ${chunk.name} (${formatBytes(chunk.size)})... `);
    await driveClient.downloadFile(chunk.id, destPath, {
      expectedSize: chunk.size
    });
    process.stdout.write("✓ Listo\n");
    downloadedPaths.push(destPath);
  }

  // 7. Generar concat_list.txt para FFmpeg
  const concatListPath = path.join(chunksDir, "concat_list.txt");
  const concatContent = downloadedPaths
    .map((p) => `file '${path.resolve(p).replace(/'/g, "'\\''")}'`)
    .join("\n");
  fs.writeFileSync(concatListPath, concatContent, "utf-8");

  // Asegurar directorio del archivo de salida
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // 8. Concatenar con FFmpeg
  console.log(`\n⚡ Concatenando ${downloadedPaths.length} segmentos con FFmpeg (-c copy)...`);
  const ffmpegArgs = [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatListPath,
    "-c", "copy",
    "-movflags", "+faststart",
    outputPath
  ];

  try {
    await execFileAsync("ffmpeg", ffmpegArgs);
  } catch (err) {
    throw new Error(`[download-and-merge-day] Error ejecutando FFmpeg: ${err.message}`);
  }

  // 9. Validar archivo generado con ffprobe
  console.log(`🔍 Validando archivo resultante con ffprobe...`);
  let durationSec = 0;
  let finalSizeBytes = 0;

  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration,size",
      "-of", "json",
      outputPath
    ]);
    const info = JSON.parse(stdout);
    durationSec = Number(info.format?.duration) || 0;
    finalSizeBytes = Number(info.format?.size) || (fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0);
  } catch (err) {
    console.warn(`[Aviso ffprobe] No se pudo leer metadata exacta: ${err.message}`);
    if (fs.existsSync(outputPath)) {
      finalSizeBytes = fs.statSync(outputPath).size;
    }
  }

  // 10. Limpieza opcional de chunks individuales
  if (cleanChunks) {
    console.log(`\n🧹 Limpiando chunks temporales (--clean-chunks activado)...`);
    for (const p of downloadedPaths) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch (_) {}
    }
    try {
      if (fs.existsSync(concatListPath)) fs.unlinkSync(concatListPath);
      // Eliminar directorio si está vacío
      const remaining = fs.readdirSync(chunksDir);
      if (remaining.length === 0) fs.rmdirSync(chunksDir);
    } catch (_) {}
    console.log(`✓ Chunks temporales purgados exitosamente.`);
  }

  // 11. Resumen final
  console.log("\n\x1b[32m%s\x1b[0m", "================================================================");
  console.log("\x1b[32m%s\x1b[0m", " ✅ FUSIÓN DIARIA COMPLETADA CON ÉXITO");
  console.log("\x1b[32m%s\x1b[0m", "================================================================");
  console.log(`📅 Día: ${dateStr} (${tz})`);
  console.log(`📦 Chunks procesados: ${downloadedPaths.length}`);
  console.log(`⏱️  Duración continua: ${formatDuration(durationSec)} (${durationSec.toFixed(1)} segundos)`);
  console.log(`💾 Tamaño del video MP4: ${formatBytes(finalSizeBytes)} (${finalSizeBytes.toLocaleString()} bytes)`);
  console.log(`🎬 Archivo final: ${outputPath}`);
  console.log("\x1b[32m%s\x1b[0m", "================================================================");

  return {
    success: true,
    outputPath,
    totalChunks: downloadedPaths.length,
    durationSec,
    finalSizeBytes
  };
}

// Ejecución directa por CLI
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  loadEnvFile();
  const options = parseArgs();

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  if (!options.date) {
    console.error("\x1b[31mError: Falta el argumento obligatorio --date <YYYY-MM-DD>\x1b[0m\n");
    printHelp();
    process.exit(1);
  }

  downloadAndMergeDay(options)
    .then((result) => {
      process.exit(result.success ? 0 : 1);
    })
    .catch((err) => {
      console.error("\n\x1b[31m❌ ERROR:\x1b[0m", err.message);
      process.exit(1);
    });
}
