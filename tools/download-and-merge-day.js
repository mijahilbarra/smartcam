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
    limit: null,
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
    } else if (arg === "--limit" || arg === "-l") {
      options.limit = Number(argv[++i]);
    } else if (arg.startsWith("--limit=")) {
      options.limit = Number(arg.slice(8));
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
  const byName = new Map();

  for (const file of files) {
    const parsed = parseChunkTimestamp(file.name);
    if (!parsed) continue;

    if (parsed.epoch >= startOfDay && parsed.epoch <= endOfDay) {
      const localTime = new Date(parsed.epoch).toLocaleString("es-PE", {
        timeZone: tz,
        hour12: true
      });
      const candidate = {
        ...file,
        epoch: parsed.epoch,
        localTime
      };

      if (!byName.has(file.name)) {
        byName.set(file.name, candidate);
      } else {
        // En caso de duplicados en Drive con el mismo nombre, preferir el de mayor tamaño
        const existing = byName.get(file.name);
        if ((candidate.size || 0) > (existing.size || 0)) {
          byName.set(file.name, candidate);
        }
      }
    }
  }

  const matched = Array.from(byName.values());
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
 * Genera una barra de progreso visual tipo CLI con corchetes.
 * Acepta una fracción (0..1) o porcentaje (0..100). Limita con seguridad entre 0 y 100%.
 * Cero dependencias externas.
 *
 * @param {number} ratioOrPercent Fracción (0..1) o Porcentaje (0..100)
 * @param {number} [width=20] Ancho de la barra en caracteres
 * @param {string} [fillChar="█"] Carácter para la porción completada
 * @param {string} [emptyChar="░"] Carácter para la porción restante
 * @returns {string} Ejemplo: "[██████████░░░░░░░░░░]"
 */
export function renderProgressBar(ratioOrPercent = 0, width = 20, fillChar = "█", emptyChar = "░") {
  const num = Number(ratioOrPercent);
  const safeNum = Number.isFinite(num) ? num : 0;
  // Si es mayor a 1, interpretamos como escala porcentual (0..100)
  const ratio = safeNum > 1 ? safeNum / 100 : safeNum;
  const clampedRatio = Math.min(1, Math.max(0, ratio));
  const safeWidth = Math.max(0, Math.floor(Number(width) || 0));
  const filled = Math.round(clampedRatio * safeWidth);
  const empty = Math.max(0, safeWidth - filled);
  return `[${fillChar.repeat(filled)}${emptyChar.repeat(empty)}]`;
}

/**
 * Valida la integridad de un chunk de video usando ffprobe.
 * Detecta si el archivo es legible, el contenedor MP4 está completo (moov atom presente)
 * y extrae la resolución, duración y codec de video.
 *
 * @param {string} filePath
 * @returns {Promise<{ valid: boolean, width?: number, height?: number, duration?: number, codec?: string, error?: string }>}
 */
export async function probeChunkIntegrity(filePath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height:format=duration",
      "-of", "json",
      filePath
    ]);

    const info = JSON.parse(stdout);
    const stream = info.streams && info.streams[0];
    if (!stream || stream.width == null || stream.height == null) {
      return { valid: false, error: "Stream de video no encontrado o incompleto" };
    }

    return {
      valid: true,
      width: Number(stream.width),
      height: Number(stream.height),
      duration: Number(info.format?.duration) || 0,
      codec: String(stream.codec_name || "")
    };
  } catch (err) {
    return {
      valid: false,
      error: err.message
    };
  }
}

/**
 * Normaliza la resolución de un chunk de video usando FFmpeg a una resolución objetivo.
 * Si el archivo destino ya existe y su tamaño es mayor a 0, omite la re-codificación (salvo que force=true).
 *
 * @param {string} inputPath Ruta del chunk de entrada
 * @param {string} outputPath Ruta del chunk normalizado de salida
 * @param {number} [targetWidth=640] Ancho objetivo
 * @param {number} [targetHeight=360] Alto objetivo
 * @param {boolean|{force?: boolean}} [optionsOrForce=false] Forzar re-codificación
 * @returns {Promise<string>} Ruta del archivo resultante
 */
export async function normalizeChunkResolution(
  inputPath,
  outputPath,
  targetWidth = 640,
  targetHeight = 360,
  optionsOrForce = false
) {
  const force = typeof optionsOrForce === "object" ? Boolean(optionsOrForce?.force) : Boolean(optionsOrForce);

  if (!force && fs.existsSync(outputPath)) {
    const stat = fs.statSync(outputPath);
    if (stat.size > 0) {
      return outputPath;
    }
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const ffmpegArgs = [
    "-y",
    "-i", inputPath,
    "-vf", `scale=${targetWidth}:${targetHeight}`,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "26",
    "-an",
    outputPath
  ];

  await execFileAsync("ffmpeg", ffmpegArgs);
  return outputPath;
}

/**
 * Determina la resolución dominante entre una lista de chunks con probe de ffprobe.
 * Por defecto retorna 640x360 si no hay información suficiente.
 *
 * @param {Array<{ probe?: { width: number, height: number } }>} items
 * @param {number} [defaultWidth=640]
 * @param {number} [defaultHeight=360]
 * @returns {{ width: number, height: number }}
 */
export function determineDominantResolution(items = [], defaultWidth = 640, defaultHeight = 360) {
  if (!Array.isArray(items) || items.length === 0) {
    return { width: defaultWidth, height: defaultHeight };
  }

  const counts = new Map();
  for (const item of items) {
    const probe = item.probe || item;
    if (probe && probe.width && probe.height) {
      const key = `${probe.width}x${probe.height}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  let dominant = { width: defaultWidth, height: defaultHeight };
  let maxCount = -1;

  for (const [key, count] of counts.entries()) {
    if (count > maxCount) {
      maxCount = count;
      const [w, h] = key.split("x").map(Number);
      dominant = { width: w, height: h };
    }
  }

  return dominant;
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
  let matchedChunks = filterAndSortDayChunks([...filesFolder1, ...filesFolder2], dateStr, tz);

  if (matchedChunks.length === 0) {
    console.warn(`\x1b[33m[Aviso] No se encontraron chunks correspondientes a la fecha ${dateStr} en horario ${tz}.\x1b[0m`);
    return { success: false, totalChunks: 0, reason: "no_matching_chunks" };
  }

  if (options.limit && options.limit > 0) {
    console.log(`⚡ Límite aplicado: procesando los primeros ${options.limit} de ${matchedChunks.length} chunks.`);
    matchedChunks = matchedChunks.slice(0, options.limit);
  }

  const totalChunks = matchedChunks.length;
  const totalBytes = matchedChunks.reduce((acc, c) => acc + (c.size || 0), 0);

  console.log(`\n✅ Chunks válidos para el día ${dateStr} (${tz}): \x1b[32m${totalChunks}\x1b[0m`);
  console.log(`⏱️  Rango horario: ${matchedChunks[0].localTime} ➔ ${matchedChunks[matchedChunks.length - 1].localTime}`);
  console.log(`📦 Total de chunks: ${totalChunks}`);
  console.log(`💾 Tamaño total a procesar: ${formatBytes(totalBytes)}`);
  console.log(`⏱️ Cobertura temporal estimada: ${totalChunks * 15} minutos (${(totalChunks * 0.25).toFixed(1)} horas)`);

  // 5. En caso de Dry Run, mostrar detalle y retornar
  if (dryRun) {
    console.log("\n📋 Desglose detallado de chunks (Dry Run):");
    matchedChunks.forEach((c, idx) => {
      const chunkNum = idx + 1;
      const pct = ((chunkNum / totalChunks) * 100).toFixed(0);
      const bar = renderProgressBar(chunkNum / totalChunks, 15);
      console.log(
        `  [${String(chunkNum).padStart(2, " ")}/${totalChunks}] ${bar} ${pct.padStart(3, " ")}% | ${c.name.padEnd(28)} | Hora Local: ${c.localTime.padEnd(24)} | Tamaño: ${formatBytes(c.size).padStart(9)}`
      );
    });
    console.log(`\n🔍 [Dry Run] Verificación completada sin descargas ni concatenación.`);
    return {
      success: true,
      dryRun: true,
      totalChunks,
      totalBytes,
      chunks: matchedChunks
    };
  }

  // 6. Descargar chunks a disco local
  if (!fs.existsSync(chunksDir)) {
    fs.mkdirSync(chunksDir, { recursive: true });
  }

  console.log(`\n📥 Iniciando descarga de ${totalChunks} chunks a '${chunksDir}'...`);
  const downloadedPaths = [];
  const downloadedItems = [];
  let completedChunks = 0;
  let completedBytes = 0;
  let currentChunkBytes = 0;

  for (let i = 0; i < totalChunks; i++) {
    const chunk = matchedChunks[i];
    const destPath = path.join(chunksDir, chunk.name);

    // Comprobación de caché
    if (!force && fs.existsSync(destPath)) {
      const stat = fs.statSync(destPath);
      if (stat.size === chunk.size && chunk.size > 0) {
        completedChunks++;
        completedBytes += chunk.size;
        const pctGlobal = ((completedChunks / totalChunks) * 100).toFixed(1);
        const barGlobal = renderProgressBar(completedChunks / totalChunks, 20);
        console.log(`  ✓ [${i + 1}/${totalChunks}] [En caché] ${chunk.name} (${formatBytes(chunk.size)}) | Global: ${barGlobal} ${pctGlobal}%`);
        downloadedPaths.push(destPath);
        downloadedItems.push({ chunk, destPath });
        continue;
      }
    }

    // Estado inicial visual antes de comenzar a recibir bytes
    const initialChunkBar = renderProgressBar(0, 15);
    const initialOverallRatio = totalBytes > 0 ? completedBytes / totalBytes : completedChunks / totalChunks;
    const initialOverallBar = renderProgressBar(initialOverallRatio, 20);
    const initialOverallPct = (initialOverallRatio * 100).toFixed(1);
    const initialProgressLine = `  [${i + 1}/${totalChunks}] ${initialChunkBar} 0.0% | Global: ${initialOverallBar} ${initialOverallPct}% (${formatBytes(completedBytes)}/${formatBytes(totalBytes)})`;
    process.stdout.write(`\r${initialProgressLine.padEnd(95, " ")}`);

    let lastProgressTime = 0;
    try {
      await driveClient.downloadFile(chunk.id, destPath, {
        expectedSize: chunk.size,
        onProgress: ({ downloadedBytes, totalBytes: chunkTotalBytes }) => {
          currentChunkBytes = downloadedBytes;
          const targetBytes = chunkTotalBytes || chunk.size || 0;
          const chunkPct = targetBytes > 0 ? Math.min(100, (downloadedBytes / targetBytes) * 100) : 0;
          const currentOverallBytes = completedBytes + currentChunkBytes;
          const overallPct = totalBytes > 0 ? Math.min(100, (currentOverallBytes / totalBytes) * 100) : 0;

          const now = Date.now();
          if (now - lastProgressTime >= 50 || downloadedBytes >= targetBytes) {
            lastProgressTime = now;
            const chunkBar = renderProgressBar(chunkPct / 100, 15);
            const overallBar = renderProgressBar(overallPct / 100, 20);
            const progressLine = `  [${i + 1}/${totalChunks}] ${chunkBar} ${chunkPct.toFixed(1)}% | Global: ${overallBar} ${overallPct.toFixed(1)}% (${formatBytes(currentOverallBytes)}/${formatBytes(totalBytes)})`;
            process.stdout.write(`\r${progressLine.padEnd(95, " ")}`);
          }
        }
      });
    } catch (err) {
      process.stdout.write("\n");
      throw err;
    }

    completedBytes += chunk.size || currentChunkBytes;
    completedChunks++;
    currentChunkBytes = 0;
    const finalPctGlobal = ((completedChunks / totalChunks) * 100).toFixed(1);
    const finalBarGlobal = renderProgressBar(completedChunks / totalChunks, 20);
    const completionLine = `  ✓ [${i + 1}/${totalChunks}] ${chunk.name} (${formatBytes(chunk.size)}) [OK] | Global: ${finalBarGlobal} ${finalPctGlobal}%`;
    process.stdout.write(`\r${completionLine.padEnd(95, " ")}\n`);
    downloadedPaths.push(destPath);
    downloadedItems.push({ chunk, destPath });
  }

  // 7. Validación de integridad pre-flight de chunks
  console.log(`\n⚡ Todos los ${totalChunks} chunks descargados (100%). Iniciando concatenación con FFmpeg...`);
  console.log(`🔍 Validando integridad de ${downloadedItems.length} chunks con ffprobe...`);
  const validChunks = [];
  for (const item of downloadedItems) {
    const probe = await probeChunkIntegrity(item.destPath);
    if (!probe.valid) {
      console.log(`⚠️  [Chunk dañado omitido] ${item.chunk.name} (moov atom corrupto o incompleto)`);
    } else {
      validChunks.push({
        ...item,
        probe
      });
    }
  }

  if (validChunks.length === 0) {
    throw new Error("No se encontraron chunks válidos para concatenar tras la validación de integridad.");
  }

  console.log(`✅ Chunks íntegros listos para procesar: ${validChunks.length} de ${totalChunks} (${totalChunks - validChunks.length} omitidos)`);

  // 8. Estandarización / Normalización de resolución
  const dominant = determineDominantResolution(validChunks, 640, 360);
  const targetWidth = dominant.width;
  const targetHeight = dominant.height;

  const concatListPaths = [];
  const normalizedPaths = [];

  for (const item of validChunks) {
    if (item.probe.width !== targetWidth || item.probe.height !== targetHeight) {
      console.log(`⚙️  Normalizando resolución de ${item.chunk.name} (${item.probe.width}x${item.probe.height} -> ${targetWidth}x${targetHeight})...`);
      const normPath = path.join(chunksDir, `norm_${item.chunk.name}`);
      await normalizeChunkResolution(item.destPath, normPath, targetWidth, targetHeight, force);
      concatListPaths.push(normPath);
      normalizedPaths.push(normPath);
    } else {
      concatListPaths.push(item.destPath);
    }
  }

  // 9. Generar concat_list.txt para FFmpeg
  const concatListPath = path.join(chunksDir, "concat_list.txt");
  const concatContent = concatListPaths
    .map((p) => `file '${path.resolve(p).replace(/'/g, "'\\''")}'`)
    .join("\n");
  fs.writeFileSync(concatListPath, concatContent, "utf-8");

  // Asegurar directorio del archivo de salida
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // 10. Concatenar con FFmpeg
  console.log(`\n⚡ Concatenando ${concatListPaths.length} segmentos con FFmpeg (-c copy)...`);
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

  // 11. Validar archivo generado con ffprobe
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

  // 12. Limpieza opcional de chunks individuales
  if (cleanChunks) {
    console.log(`\n🧹 Limpiando chunks temporales (--clean-chunks activado)...`);
    for (const p of downloadedPaths) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch (_) {}
    }
    for (const p of normalizedPaths) {
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

  // 13. Resumen final
  console.log("\n\x1b[32m%s\x1b[0m", "================================================================");
  console.log("\x1b[32m%s\x1b[0m", " ✅ FUSIÓN DIARIA COMPLETADA CON ÉXITO");
  console.log("\x1b[32m%s\x1b[0m", "================================================================");
  console.log(`📅 Día: ${dateStr} (${tz})`);
  console.log(`📦 Chunks procesados: ${concatListPaths.length} de ${totalChunks} (Válidos: ${validChunks.length}, Omitidos: ${totalChunks - validChunks.length})`);
  console.log(`⏱️  Duración continua: ${formatDuration(durationSec)} (${durationSec.toFixed(1)} segundos)`);
  console.log(`💾 Tamaño del video MP4: ${formatBytes(finalSizeBytes)} (${finalSizeBytes.toLocaleString()} bytes)`);
  console.log(`🎬 Archivo final: ${outputPath}`);
  console.log("\x1b[32m%s\x1b[0m", "================================================================");

  return {
    success: true,
    outputPath,
    totalChunks: concatListPaths.length,
    validChunks: validChunks.length,
    skippedChunks: totalChunks - validChunks.length,
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
