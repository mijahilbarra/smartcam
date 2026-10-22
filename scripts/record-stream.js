#!/usr/bin/env node
/**
 * Script para grabar el stream de video en vivo (Producción HTTP o RTSP local)
 * y almacenarlo como archivo MP4 para pruebas y simulación offline 100% fiel.
 *
 * Uso:
 *   node scripts/record-stream.js [--duration 60] [--output data/recordings/mock_stream.mp4] [--source https://...]
 *   npm run record -- --duration 120
 */

import { spawn, execSync } from "node:child_process";
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
  if (process.env.RTSP_STREAM_URL) return process.env.RTSP_STREAM_URL;

  const prodUrl = process.env.PROD_STREAM_URL || "https://stream.perrosuelto.com";
  return `${prodUrl}/api/stream`;
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

    let isFinished = false;
    let finishedByTimerOrSignal = false;
    let currentReq = null;
    let reconnectTimeout = null;
    let activeWatchdog = null;
    let startEpoch = null;
    let framesCount = 0;

    let currentSegmentIndex = 1;
    const segmentFiles = [];
    let currentFfmpeg = null;

    const startNewSegment = () => {
      if (isFinished) return null;
      const segmentPath = path.join(
        outDir,
        `.tmp_seg_${Date.now()}_${String(currentSegmentIndex).padStart(3, "0")}.mp4`
      );
      segmentFiles.push(segmentPath);
      const segNum = currentSegmentIndex;
      currentSegmentIndex++;

      const ffmpegArgs = [
        "-y",
        "-use_wallclock_as_timestamps", "1",
        "-f", "image2pipe",
        "-vcodec", "mjpeg",
        "-i", "pipe:0",
        "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
        segmentPath
      ];

      const proc = spawn("ffmpeg", ffmpegArgs, { stdio: ["pipe", "inherit", "inherit"] });

      proc.stdin.on("error", (err) => {
        if (err.code !== "EPIPE") {
          console.warn("[FFmpeg Stdin]:", err.message);
        }
      });

      proc.on("close", (code, signal) => {
        console.log(`\n[FFmpeg Segmento ${segNum}] Cerrado (código: ${code}, señal: ${signal})`);
        if (currentFfmpeg === proc) {
          currentFfmpeg = null;
        }
        if (!isFinished) {
          console.log(`🔄 Reanudando grabación automáticamente en nuevo segmento...`);
          startNewSegment();
        }
      });

      currentFfmpeg = proc;
      return proc;
    };

    const consolidateSegments = () => {
      const validSegments = segmentFiles.filter(
        (f) => fs.existsSync(f) && fs.statSync(f).size > 1024
      );

      if (validSegments.length === 0) {
        if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1024) {
          return;
        }
        throw new Error("No se registraron fotogramas de video válidos.");
      }

      if (validSegments.length === 1) {
        fs.copyFileSync(validSegments[0], destPath);
        try { fs.unlinkSync(validSegments[0]); } catch (_) {}
      } else {
        process.stdout.write(`\n📦 Consolidando ${validSegments.length} segmentos en archivo final: ${destPath}...\n`);
        const listFile = path.join(outDir, `.concat_list_${Date.now()}.txt`);
        fs.writeFileSync(listFile, validSegments.map((f) => `file '${f}'`).join("\n"));
        try {
          execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${destPath}"`, {
            stdio: "inherit"
          });
          for (const f of validSegments) {
            try { fs.unlinkSync(f); } catch (_) {}
          }
        } finally {
          try { fs.unlinkSync(listFile); } catch (_) {}
        }
      }
    };

    const finishRecording = (byUser = false) => {
      if (isFinished) return;
      isFinished = true;
      finishedByTimerOrSignal = true;
      clearInterval(progressInterval);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (activeWatchdog) clearInterval(activeWatchdog);
      if (currentReq) {
        try { currentReq.destroy(); } catch (_) {}
      }
      process.stdout.write("\nFinalizando y cerrando codificador...\n");
      if (currentFfmpeg) {
        try { currentFfmpeg.stdin.end(); } catch (_) {}
      }

      setTimeout(() => {
        try {
          consolidateSegments();
          resolve();
        } catch (err) {
          reject(err);
        }
      }, 1500);
    };

    const progressInterval = setInterval(() => {
      if (!startEpoch) {
        process.stdout.write(`\r⏳ Conectando al stream y esperando primer fotograma...`);
        return;
      }
      const secondsElapsed = Math.floor((Date.now() - startEpoch) / 1000);
      const minElapsed = (secondsElapsed / 60).toFixed(1);
      const totalMin = (duration / 60).toFixed(1);
      process.stdout.write(`\r⏳ Grabando: ${secondsElapsed}/${duration}s (${minElapsed}m / ${totalMin}m) [${framesCount} frames, seg ${currentSegmentIndex - 1}]...`);
      if (secondsElapsed >= duration) {
        finishRecording(false);
      }
    }, 1000);

    const connectStream = () => {
      if (isFinished) return;
      if (activeWatchdog) clearInterval(activeWatchdog);

      let lastDataTime = Date.now();
      let chunkBuffer = Buffer.alloc(0);

      currentReq = client.get(url, { headers: { "Cache-Control": "no-cache" } }, (res) => {
        if (res.statusCode !== 200) {
          console.warn(`\n[Aviso] HTTP ${res.statusCode} al conectar al stream. Reintentando en 3s...`);
          res.resume();
          scheduleReconnect();
          return;
        }

        res.on("data", (chunk) => {
          lastDataTime = Date.now();
          chunkBuffer = Buffer.concat([chunkBuffer, chunk]);

          while (true) {
            const headerEnd = chunkBuffer.indexOf("\r\n\r\n");
            if (headerEnd === -1) {
              break;
            }

            const headerText = chunkBuffer.slice(0, headerEnd).toString("latin1");
            const match = headerText.match(/Content-Length:\s*(\d+)/i);

            if (match) {
              const frameLen = parseInt(match[1], 10);
              const frameStart = headerEnd + 4;
              if (chunkBuffer.length < frameStart + frameLen) {
                break;
              }

              const frame = chunkBuffer.slice(frameStart, frameStart + frameLen);
              chunkBuffer = chunkBuffer.slice(frameStart + frameLen);

              const nextBoundary = chunkBuffer.indexOf("--");
              if (nextBoundary > 0) {
                chunkBuffer = chunkBuffer.slice(nextBoundary);
              }

              if (
                frame.length >= 4 &&
                frame[0] === 0xff && frame[1] === 0xd8 &&
                frame[frame.length - 2] === 0xff && frame[frame.length - 1] === 0xd9
              ) {
                try {
                  if (!isFinished) {
                    if (!currentFfmpeg) {
                      startNewSegment();
                    }
                    if (currentFfmpeg && currentFfmpeg.stdin && currentFfmpeg.stdin.writable) {
                      currentFfmpeg.stdin.write(frame);
                      if (!startEpoch) startEpoch = Date.now();
                      framesCount++;
                    }
                  }
                } catch (_) {}
              }
            } else {
              const nextBoundary = chunkBuffer.indexOf("\r\n--", headerEnd + 4);
              if (nextBoundary === -1) break;
              const frame = chunkBuffer.slice(headerEnd + 4, nextBoundary);
              chunkBuffer = chunkBuffer.slice(nextBoundary + 2);
              if (frame.length >= 4 && frame[0] === 0xff && frame[1] === 0xd8) {
                try {
                  if (!isFinished) {
                    if (!currentFfmpeg) {
                      startNewSegment();
                    }
                    if (currentFfmpeg && currentFfmpeg.stdin && currentFfmpeg.stdin.writable) {
                      currentFfmpeg.stdin.write(frame);
                      if (!startEpoch) startEpoch = Date.now();
                      framesCount++;
                    }
                  }
                } catch (_) {}
              }
            }
          }

          if (chunkBuffer.length > 8 * 1024 * 1024) {
            chunkBuffer = Buffer.alloc(0);
          }
        });

        activeWatchdog = setInterval(() => {
          if (!isFinished && Date.now() - lastDataTime > 45000) {
            console.warn("\n[Watchdog] Inactividad de datos en stream (>45s). Reiniciando socket HTTP...");
            clearInterval(activeWatchdog);
            activeWatchdog = null;
            try { currentReq.destroy(); } catch (_) {}
            scheduleReconnect();
          }
        }, 5000);

        res.on("end", () => {
          if (activeWatchdog) clearInterval(activeWatchdog);
          if (!isFinished) {
            console.warn("\n[Aviso] Stream desconectado temporalmente. Reconectando en 2s...");
            scheduleReconnect();
          }
        });

        res.on("error", (err) => {
          if (activeWatchdog) clearInterval(activeWatchdog);
          if (!isFinished) {
            console.warn("\n[Aviso] Error en conexión de stream:", err.message);
            scheduleReconnect();
          }
        });
      });

      currentReq.on("error", (err) => {
        if (activeWatchdog) clearInterval(activeWatchdog);
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
      finishRecording(true);
    };
    process.once("SIGINT", handleSig);
    process.once("SIGTERM", handleSig);

    startNewSegment();
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
