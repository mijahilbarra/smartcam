#!/usr/bin/env node
/**
 * Script CLI para ejecutar manualmente la grabación continua de streaming
 * y subida automática en segundo plano hacia Google Drive con purga local.
 *
 * Uso:
 *   node scripts/record-to-gdrive.js [--duration 60] [--segment-time 30]
 *   npm run record:gdrive -- --duration 120 --segment-time 30
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleDriveClient, loadEnvFile } from "../src/infrastructure/storage/gdrive_client.js";
import { StreamRecorder } from "../src/infrastructure/recording/stream_recorder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

loadEnvFile(path.join(PROJECT_ROOT, ".env"));

// Parsear argumentos CLI
const args = process.argv.slice(2);
function getArg(flag, defaultValue) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return defaultValue;
}

const durationArg = getArg("--duration", getArg("-d", null));
const durationSec = durationArg !== null ? Number(durationArg) : null;
const segmentTimeSec = Number(getArg("--segment-time", getArg("-s", "900")));
const customRtsp = getArg("--rtsp-url", getArg("-r", process.env.RTSP_STREAM_URL || "rtsp://127.0.0.1:8554/barberia/sub"));
const outDir = path.resolve(getArg("--output", getArg("-o", path.join(PROJECT_ROOT, "data", "recordings"))));

console.log("\x1b[36m%s\x1b[0m", "================================================================");
console.log("\x1b[36m%s\x1b[0m", " 🎥 IOT Camera Catcher - Grabador Continuo a Google Drive");
console.log("\x1b[36m%s\x1b[0m", "================================================================");
console.log(`⏱️  Duración de cada segmento: ${segmentTimeSec}s (${(segmentTimeSec / 60).toFixed(1)} min)`);
console.log(`⏳ Duración total sesión: ${durationSec ? `${durationSec}s` : "Indefinida (hasta Ctrl+C)"}`);
console.log(`📡 Origen RTSP: ${customRtsp}`);
console.log(`📁 Directorio local temporal: ${outDir}`);

const gdriveClient = new GoogleDriveClient();

try {
  console.log("\n🔑 Verificando conexión y cuota con Google Drive API v3...");
  const quota = await gdriveClient.getStorageQuota();
  const formatGB = (b) => (b ? (b / (1024 ** 3)).toFixed(2) : "Ilimitado");
  console.log(`👤 Usuario: ${quota.user?.displayName || "N/A"} (${quota.user?.emailAddress || "N/A"})`);
  console.log(`💾 Almacenamiento: ${formatGB(quota.usage)} GB usado / ${formatGB(quota.limit)} GB límite (${formatGB(quota.freeBytes)} GB libres)`);

  const rootFolderId = await gdriveClient.ensureRootFolder();
  console.log(`📁 Carpeta raíz de grabaciones: ${gdriveClient.rootFolderName} (ID: ${rootFolderId})\n`);
} catch (err) {
  console.error("\x1b[31m%s\x1b[0m", `❌ Error al conectar con Google Drive: ${err.message}`);
  process.exit(1);
}

const recorder = new StreamRecorder({
  segmentDurationSec: segmentTimeSec,
  outputBaseDir: outDir,
  gdriveClient,
  rtspUrl: customRtsp,
  uploadIntervalMs: 3000,
  settleTimeMs: 10000
});

recorder.start();

const startTime = Date.now();
let isExiting = false;

async function handleExit(signal) {
  if (isExiting) return;
  isExiting = true;
  console.log(`\n\x1b[33m🛑 Señal ${signal} recibida. Deteniendo grabación y procesando segmentos pendientes...\x1b[0m`);
  try {
    await recorder.stop();
  } catch (err) {
    console.warn("Aviso al detener grabador:", err.message);
  }

  const stats = recorder.getStats();
  console.log("\n\x1b[32m%s\x1b[0m", "================================================================");
  console.log("\x1b[32m%s\x1b[0m", " 🏁 Sesión de grabación finalizada");
  console.log("\x1b[32m%s\x1b[0m", "================================================================");
  console.log(`✅ Segmentos subidos exitosamente a Drive: ${stats.uploadedCount}`);
  console.log(`❌ Segmentos fallidos: ${stats.failedCount}`);
  console.log(`⏳ Segmentos remanentes en disco: ${stats.pendingCount}`);
  if (stats.lastUploadedFile) {
    console.log(`📄 Último archivo subido: ${stats.lastUploadedFile.fileName} (${stats.lastUploadedFile.fileId})`);
  }
  process.exit(0);
}

process.once("SIGINT", () => handleExit("SIGINT"));
process.once("SIGTERM", () => handleExit("SIGTERM"));

// Monitor periódico en consola
const monitorInterval = setInterval(() => {
  if (isExiting) return;
  const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
  const stats = recorder.getStats();
  const activeName = stats.activeChunk ? path.basename(stats.activeChunk) : "esperando...";
  process.stdout.write(
    `\r⏱️  ${elapsedSec}s transcurridos | Activo: ${activeName} | Subidos: ${stats.uploadedCount} | Pendientes: ${stats.pendingCount}`
  );

  if (durationSec && elapsedSec >= durationSec) {
    clearInterval(monitorInterval);
    process.stdout.write("\n⏱️  Tiempo solicitado cumplido. Finalizando...\n");
    handleExit("TIMEOUT");
  }
}, 1000);
