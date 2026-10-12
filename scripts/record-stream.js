#!/usr/bin/env node
/**
 * Script para grabar el stream de video en vivo (Producción HTTP o RTSP local)
 * y almacenarlo como archivo MP4 para pruebas y simulación offline 100% fiel.
 *
 * Uso:
 *   node scripts/record-stream.js [--duration 60] [--output data/recordings/mock_stream.mp4] [--source https://...]
 *   npm run record -- --duration 120
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

// 1. Parsear argumentos CLI
const args = process.argv.slice(2);
function getArg(flag, defaultValue) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return defaultValue;
}

const durationSec = Number(getArg("--duration", getArg("-d", "60")));
const defaultOutDir = path.join(PROJECT_ROOT, "data", "recordings");
const defaultOutFile = path.join(defaultOutDir, "mock_stream.mp4");
const outputPath = path.resolve(getArg("--output", getArg("-o", defaultOutFile)));
const customSource = getArg("--source", getArg("-s", null));

// Asegurar carpeta de salida
const outDir = path.dirname(outputPath);
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

console.log("\x1b[36m%s\x1b[0m", "========================================================");
console.log("\x1b[36m%s\x1b[0m", " 🎥 IOT Camera Catcher - Grabador de Stream Offline");
console.log("\x1b[36m%s\x1b[0m", "========================================================");
console.log(`⏱️  Duración solicitada: ${durationSec} segundos`);
console.log(`💾 Destino: ${outputPath}`);

// 2. Determinar el origen (HTTP Producción o RTSP Local)
async function detectSource() {
  if (customSource) return customSource;

  // Intentar primero stream HTTP de producción
  const prodUrl = process.env.PROD_STREAM_URL || "https://stream.perrosuelto.com";
  const snapshotUrl = `${prodUrl}/api/snapshot`;

  console.log(`🔍 Probando disponibilidad de stream en producción: ${snapshotUrl}...`);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(snapshotUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      console.log(`✅ Stream de producción disponible en ${prodUrl}`);
      return `${prodUrl}/api/stream`;
    }
  } catch (_) {}

  // Si no responde, asumir RTSP local de Neolink
  const rtspUrl = process.env.RTSP_STREAM_URL || "rtsp://127.0.0.1:8554/barberia/sub";
  console.log(`ℹ️ Producción no disponible. Probando fuente RTSP local: ${rtspUrl}...`);
  return rtspUrl;
}

const sourceUrl = await detectSource();
console.log(`📡 Fuente seleccionada: ${sourceUrl}\n`);

// 3. Ejecutar la grabación con FFmpeg
async function record() {
  const isHttp = sourceUrl.startsWith("http://") || sourceUrl.startsWith("https://");

  if (isHttp) {
    console.log(`🔴 Iniciando grabación desde flujo HTTP MJPEG a MP4 (H.264)...`);
    return recordHttpStream(sourceUrl, outputPath, durationSec);
  } else {
    console.log(`🔴 Iniciando grabación directa desde RTSP sin recodificar (-c copy)...`);
    return recordRtspStream(sourceUrl, outputPath, durationSec);
  }
}

function recordHttpStream(url, destPath, duration) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith("https");
    const client = isHttps ? https : http;

    const ffmpegArgs = [
      "-y",
      "-use_wallclock_as_timestamps", "1",
      "-f", "image2pipe",
      "-vcodec", "mjpeg",
      "-i", "pipe:0",
      "-t", String(duration),
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      destPath
    ];

    const ffmpeg = spawn("ffmpeg", ffmpegArgs, { stdio: ["pipe", "inherit", "inherit"] });

    let isFinished = false;
    let secondsElapsed = 0;
    let currentReq = null;
    let reconnectTimeout = null;

    const finishRecording = () => {
      if (isFinished) return;
      isFinished = true;
      clearInterval(progressInterval);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (currentReq) {
        try { currentReq.destroy(); } catch (_) {}
      }
      process.stdout.write("\nFinalizando y cerrando contenedor MP4...\n");
      try { ffmpeg.stdin.end(); } catch (_) {}
    };

    const progressInterval = setInterval(() => {
      secondsElapsed++;
      const minElapsed = (secondsElapsed / 60).toFixed(1);
      const totalMin = (duration / 60).toFixed(1);
      process.stdout.write(`\r⏳ Grabando: ${secondsElapsed}/${duration}s (${minElapsed}m / ${totalMin}m)...`);
      if (secondsElapsed >= duration) {
        finishRecording();
      }
    }, 1000);

    const connectStream = () => {
      if (isFinished) return;

      currentReq = client.get(url, { headers: { "Cache-Control": "no-cache" } }, (res) => {
        if (res.statusCode !== 200) {
          console.warn(`\n[Aviso] HTTP ${res.statusCode} al conectar al stream. Reintentando en 3s...`);
          res.resume();
          scheduleReconnect();
          return;
        }

        res.pipe(ffmpeg.stdin, { end: false });

        res.on("end", () => {
          if (!isFinished) {
            console.warn("\n[Aviso] Stream desconectado temporalmente. Reconectando en 2s...");
            scheduleReconnect();
          }
        });

        res.on("error", (err) => {
          if (!isFinished) {
            console.warn("\n[Aviso] Error en conexión de stream:", err.message);
            scheduleReconnect();
          }
        });
      });

      currentReq.on("error", (err) => {
        if (!isFinished) {
          console.warn("\n[Aviso] Error en request:", err.message, ". Reintentando en 3s...");
          scheduleReconnect();
        }
      });
    };

    const scheduleReconnect = () => {
      if (isFinished) return;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      reconnectTimeout = setTimeout(connectStream, 2000);
    };

    // Manejo de cancelación limpia (Ctrl+C / SIGINT / SIGTERM)
    const handleSig = () => {
      console.log("\n\x1b[33m%s\x1b[0m", "🛑 Señal de parada recibida. Guardando metadatos del video grabado hasta ahora...");
      finishRecording();
    };
    process.once("SIGINT", handleSig);
    process.once("SIGTERM", handleSig);

    ffmpeg.on("close", (code) => {
      isFinished = true;
      clearInterval(progressInterval);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      process.removeListener("SIGINT", handleSig);
      process.removeListener("SIGTERM", handleSig);
      if (code === 0 || code === 255) {
        resolve();
      } else {
        reject(new Error(`FFmpeg finalizó con código de error ${code}`));
      }
    });

    ffmpeg.on("error", (err) => {
      isFinished = true;
      clearInterval(progressInterval);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      reject(err);
    });

    connectStream();
  });
}

function recordRtspStream(url, destPath, duration) {
  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      "-y",
      "-rtsp_transport", "tcp",
      "-analyzeduration", "15000000",
      "-probesize", "1000000",
      "-i", url,
      "-t", String(duration),
      "-c", "copy",
      "-movflags", "+faststart",
      destPath
    ];

    const ffmpeg = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "inherit", "inherit"] });

    let secondsElapsed = 0;
    const progressInterval = setInterval(() => {
      secondsElapsed++;
      process.stdout.write(`\r⏳ Grabando RTSP: ${secondsElapsed}/${duration}s...`);
      if (secondsElapsed >= duration) {
        clearInterval(progressInterval);
        process.stdout.write("\nFinalizando contenedor de video...\n");
      }
    }, 1000);

    ffmpeg.on("close", (code) => {
      clearInterval(progressInterval);
      if (code === 0 || code === 255) {
        resolve();
      } else {
        reject(new Error(`FFmpeg finalizó con código de error ${code}`));
      }
    });

    ffmpeg.on("error", (err) => {
      clearInterval(progressInterval);
      reject(err);
    });
  });
}

try {
  await record();

  if (fs.existsSync(outputPath)) {
    const stat = fs.statSync(outputPath);
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
    console.log("\n\x1b[32m%s\x1b[0m", "========================================================");
    console.log("\x1b[32m%s\x1b[0m", " 🎉 ¡Grabación completada exitosamente!");
    console.log("\x1b[32m%s\x1b[0m", "========================================================");
    console.log(`📁 Archivo: ${outputPath}`);
    console.log(`⚖️  Tamaño: ${sizeMB} MB`);
    console.log("\n💡 Para usar este video en tus pruebas offline simulando 100% online:");
    console.log(`   npm run dev:mock`);
    console.log(`   O manualmente:`);
    console.log(`   MOCK_VIDEO_PATH="${path.relative(PROJECT_ROOT, outputPath)}" npm run start\n`);
  } else {
    console.error("\x1b[31m%s\x1b[0m", "❌ El archivo de salida no fue creado.");
    process.exit(1);
  }
} catch (err) {
  console.error("\x1b[31m%s\x1b[0m", `\n❌ Error durante la grabación: ${err.message}`);
  process.exit(1);
}
