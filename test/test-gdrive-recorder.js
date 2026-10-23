/**
 * Test Suite: Google Drive Client y Stream Recorder
 * Valida autenticación OAuth2, caché de tokens, consulta de cuota, protocolo Resumable Upload,
 * detección de segmentos completados, subida en segundo plano y purga local automática.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { GoogleDriveClient } from "../src/infrastructure/storage/gdrive_client.js";
import { StreamRecorder } from "../src/infrastructure/recording/stream_recorder.js";

console.log("\x1b[36m%s\x1b[0m", "=== Test Suite: Google Drive Client & Stream Recorder ===");

// =========================================================================
// 1. GoogleDriveClient: Autenticación, Cache de Tokens y Cabeceras
// =========================================================================
console.log("\n[1] Probando GoogleDriveClient: Autenticación OAuth2 y caché con margen de seguridad...");

let oauthRequestCount = 0;
const mockFetch = async (url, options = {}) => {
  const urlStr = String(url);

  // 1.1 Endpoint de Token OAuth2
  if (urlStr.includes("oauth2.googleapis.com/token")) {
    oauthRequestCount++;
    const bodyStr = String(options.body || "");
    if (!bodyStr.includes("grant_type=refresh_token") || !bodyStr.includes("client_id=test_client")) {
      return {
        ok: false,
        status: 400,
        text: async () => "Invalid grant"
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "mock_access_token_12345",
        expires_in: 3600,
        token_type: "Bearer"
      })
    };
  }

  // 1.2 Endpoint de Cuota / About
  if (urlStr.includes("drive/v3/about")) {
    assert.strictEqual(options.headers?.Authorization, "Bearer mock_access_token_12345");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        user: { displayName: "Barbería Test", emailAddress: "test@barberia.com" },
        storageQuota: {
          limit: "5497558138880", // 5 TB
          usage: "10737418240"    // 10 GB
        }
      })
    };
  }

  // 1.3 Endpoint de Files (Búsqueda y Creación de Carpetas)
  if (urlStr.includes("drive/v3/files") && !urlStr.includes("uploadType=resumable")) {
    assert.strictEqual(options.headers?.Authorization, "Bearer mock_access_token_12345");

    if (options.method === "POST") {
      const body = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: `folder_id_${body.name}`,
          name: body.name,
          mimeType: body.mimeType
        })
      };
    }

    // Búsqueda GET
    if (urlStr.includes("IOT_Camera_Recordings")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          files: [{ id: "root_folder_existing_id", name: "IOT_Camera_Recordings" }]
        })
      };
    }

    if (urlStr.includes("2026-10-23")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          files: [] // No existe aún
        })
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({ files: [] })
    };
  }

  // 1.4 Inicio de Resumable Upload
  if (urlStr.includes("uploadType=resumable")) {
    assert.strictEqual(options.headers?.Authorization, "Bearer mock_access_token_12345");
    assert.strictEqual(options.headers?.["X-Upload-Content-Type"], "video/mp4");
    assert.ok(options.headers?.["X-Upload-Content-Length"]);
    return {
      ok: true,
      status: 200,
      headers: {
        get: (h) => (h.toLowerCase() === "location" ? "https://mock.upload.url/session/9988" : null)
      }
    };
  }

  // 1.5 PUT de contenido de video
  if (urlStr.includes("mock.upload.url/session/9988")) {
    assert.strictEqual(options.method, "PUT");
    assert.strictEqual(options.headers?.["Content-Type"], "video/mp4");

    // En fetch real, el stream se lee por completo antes de resolver
    if (options.body && typeof options.body.resume === "function") {
      await new Promise((resolve) => {
        options.body.on("data", () => {});
        options.body.on("end", resolve);
        options.body.on("error", resolve);
      });
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: "uploaded_video_id_777",
        name: "chunk_test.mp4",
        size: options.headers?.["Content-Length"],
        md5Checksum: "abc123md5mock"
      })
    };
  }

  throw new Error(`URL no manejada en mockFetch: ${urlStr}`);
};

const client = new GoogleDriveClient({
  clientId: "test_client",
  clientSecret: "test_secret",
  refreshToken: "test_refresh_token",
  fetchFn: mockFetch
});

const token1 = await client.getAccessToken();
assert.strictEqual(token1, "mock_access_token_12345");
assert.strictEqual(oauthRequestCount, 1);

// Segunda llamada inmediata debe usar caché en memoria
const token2 = await client.getAccessToken();
assert.strictEqual(token2, "mock_access_token_12345");
assert.strictEqual(oauthRequestCount, 1, "Debe haber reutilizado el token en memoria sin nueva petición HTTP");

// Forzar expiración para verificar margen de seguridad (5 minutos)
client.tokenExpiresAt = Date.now() + 4 * 60 * 1000; // Solo restan 4 minutos
const token3 = await client.getAccessToken();
assert.strictEqual(token3, "mock_access_token_12345");
assert.strictEqual(oauthRequestCount, 2, "Debe haber renovado el token al encontrarse dentro de los 5 min de margen");

console.log("-> Autenticación OAuth2 y caché en memoria con margen de seguridad validados.");

// =========================================================================
// 2. GoogleDriveClient: Cuota de Almacenamiento y Gestión de Carpetas
// =========================================================================
console.log("\n[2] Probando GoogleDriveClient: Consulta de cuota y resolución de carpetas...");

const quota = await client.getStorageQuota();
assert.strictEqual(quota.limit, 5497558138880);
assert.strictEqual(quota.usage, 10737418240);
assert.strictEqual(quota.freeBytes, 5497558138880 - 10737418240);
assert.strictEqual(quota.user?.displayName, "Barbería Test");

const rootId = await client.ensureRootFolder();
assert.strictEqual(rootId, "root_folder_existing_id");

const dayId = await client.ensureDayFolder("2026-10-23", rootId);
assert.strictEqual(dayId, "folder_id_2026-10-23");

// Segunda llamada a ensureDayFolder debe usar caché en memoria
const dayIdCached = await client.ensureDayFolder("2026-10-23", rootId);
assert.strictEqual(dayIdCached, "folder_id_2026-10-23");

console.log("-> Cuota y resolución de carpetas (raíz y diaria) validadas exitosamente.");

// =========================================================================
// 3. GoogleDriveClient: Protocolo Resumable Upload
// =========================================================================
console.log("\n[3] Probando GoogleDriveClient: Resumable Upload de archivo MP4...");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gdrive_test_"));
const testVideoFile = path.join(tmpDir, "test_chunk.mp4");
fs.writeFileSync(testVideoFile, Buffer.alloc(4096, 0x11));

const uploadResult = await client.uploadVideoChunk(testVideoFile, "test_chunk.mp4", dayId);
assert.strictEqual(uploadResult.fileId, "uploaded_video_id_777");
assert.strictEqual(uploadResult.fileName, "chunk_test.mp4");
assert.strictEqual(uploadResult.size, 4096);
assert.strictEqual(uploadResult.md5Checksum, "abc123md5mock");

console.log("-> Protocolo Resumable Upload validado exitosamente.");

// =========================================================================
// 4. StreamRecorder: Detección de Segmentos y Purga Local Inmediata
// =========================================================================
console.log("\n[4] Probando StreamRecorder: Detección de segmentos completados y purga local...");

const recorderOutDir = path.join(tmpDir, "recordings");
const dayFolderLocal = path.join(recorderOutDir, "2026-10-23");
fs.mkdirSync(dayFolderLocal, { recursive: true });

// Crear 2 archivos simulados: chunk1 (completado) y chunk2 (activo)
const chunk1Path = path.join(dayFolderLocal, "chunk_20261023_100000.mp4");
const chunk2Path = path.join(dayFolderLocal, "chunk_20261023_101500.mp4");
fs.writeFileSync(chunk1Path, Buffer.alloc(1024 * 50, 0xAA)); // 50 KB
fs.writeFileSync(chunk2Path, Buffer.alloc(1024 * 10, 0xBB)); // 10 KB

const recorder = new StreamRecorder({
  outputBaseDir: recorderOutDir,
  gdriveClient: client,
  segmentDurationSec: 900,
  settleTimeMs: 1000 // 1 segundo para la prueba
});

// Simular que FFmpeg está escribiendo en chunk2
recorder.ffmpegProc = { dummy: true };
recorder.activeChunk = chunk2Path;

// Escanear: chunk1 tiene un subsecuente (chunk2), por ende está completado. chunk2 es el activo.
const completedSegs = recorder.getCompletedSegments();
assert.strictEqual(completedSegs.length, 1);
assert.strictEqual(completedSegs[0].path, chunk1Path);

// Ejecutar proceso de subida
await recorder.processPendingSegments();

// Validar que chunk1 fue subido y PURGADO de disco local
assert.strictEqual(fs.existsSync(chunk1Path), false, "El archivo chunk1 local DEBE haber sido eliminado tras subida");
assert.strictEqual(fs.existsSync(chunk2Path), true, "El archivo chunk2 activo DEBE permanecer en disco");
assert.strictEqual(recorder.uploadedCount, 1);
assert.strictEqual(recorder.lastUploadedFile?.fileName, "chunk_20261023_100000.mp4");

console.log("-> Segmento completado detectado, subido a Drive y purgado inmediatamente de disco.");

// =========================================================================
// 5. StreamRecorder: Manejo de Fallos de Red y Retención para Reintento
// =========================================================================
console.log("\n[5] Probando StreamRecorder: Manejo de fallos de red (sin eliminar archivo local)...");

const failingClient = new GoogleDriveClient({
  clientId: "test_client",
  clientSecret: "test_secret",
  refreshToken: "test_refresh_token",
  fetchFn: async (url) => {
    if (String(url).includes("oauth2.googleapis.com/token")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "tok", expires_in: 3600 })
      };
    }
    throw new Error("Network connection reset (EHOSTUNREACH)");
  }
});

const failOutDir = path.join(tmpDir, "recordings_fail");
const dayFolderFail = path.join(failOutDir, "2026-10-23");
fs.mkdirSync(dayFolderFail, { recursive: true });

const chunkFailPath = path.join(dayFolderFail, "chunk_20261023_103000.mp4");
fs.writeFileSync(chunkFailPath, Buffer.alloc(1024 * 20, 0xCC));

const failRecorder = new StreamRecorder({
  outputBaseDir: failOutDir,
  gdriveClient: failingClient
});

await failRecorder.processPendingSegments({ uploadActive: true });

assert.strictEqual(fs.existsSync(chunkFailPath), true, "El archivo DEBE mantenerse en disco tras fallo de subida");
assert.strictEqual(failRecorder.failedCount, 1);
assert.ok(failRecorder.lastError?.includes("Network connection reset"));

console.log("-> Retención segura de archivos locales en caso de caída de red validada.");

// =========================================================================
// 6. StreamRecorder: Métricas getStats y Shutdown Limpio
// =========================================================================
console.log("\n[6] Probando StreamRecorder: Métricas en tiempo real y parada ordenada...");

const stats = recorder.getStats();
assert.strictEqual(typeof stats.uploadedCount, "number");
assert.strictEqual(typeof stats.failedCount, "number");
assert.strictEqual(typeof stats.pendingCount, "number");
assert.strictEqual(stats.isRecording, false);

console.log("-> Métricas en tiempo real y estadísticas del grabador validadas.");

// =========================================================================
// 7. StreamRecorder: Flujo HTTP Unificado, Argumentos FFmpeg y Watchdog de Inactividad
// =========================================================================
console.log("\n[7] Probando StreamRecorder: Flujo HTTP Unificado, FFmpeg args y Watchdog...");

// 7.1 Argumentos FFmpeg para HTTP MJPEG unificado
const httpRecorder = new StreamRecorder({
  streamUrl: "http://127.0.0.1:8085/api/stream",
  segmentDurationSec: 900
});
const httpArgs = httpRecorder.getFfmpegArgs("out_%Y%m%d.mp4");
assert.ok(httpArgs.includes("-f") && httpArgs.includes("mjpeg"), "Debe especificar formato MJPEG para HTTP");
assert.ok(httpArgs.includes("libx264"), "Debe codificar en libx264 para encapsular en MP4");
assert.ok(httpArgs.includes("ultrafast"), "Debe usar preset ultrafast para mínimo consumo CPU");
assert.ok(httpArgs.includes("-crf") && httpArgs.includes("28"), "CRF debe ser 28");
assert.ok(httpArgs.includes("yuv420p"), "Formato de pixel debe ser yuv420p");
assert.ok(httpArgs.includes("movflags=+faststart"), "Debe incluir movflags=+faststart para moov al inicio");

// 7.2 Argumentos FFmpeg para RTSP directo (fallback)
const rtspRecorder = new StreamRecorder({
  rtspUrl: "rtsp://127.0.0.1:8554/barberia/sub",
  segmentDurationSec: 900
});
const rtspArgs = rtspRecorder.getFfmpegArgs("out_%Y%m%d.mp4");
assert.ok(rtspArgs.includes("-rtsp_transport") && rtspArgs.includes("tcp"), "Debe especificar RTSP sobre TCP");
assert.ok(rtspArgs.includes("copy"), "RTSP directo debe usar copy sin transcodificar");
assert.ok(rtspArgs.includes("-an"), "Debe descartar audio");
assert.ok(rtspArgs.includes("movflags=+faststart"), "Debe incluir movflags=+faststart");

// 7.3 Watchdog: Detección de estancamiento en segmento activo
const watchdogDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog_test_"));
const watchdogDayDir = path.join(watchdogDir, "2026-10-23");
fs.mkdirSync(watchdogDayDir, { recursive: true });
const activeFile = path.join(watchdogDayDir, "chunk_active.mp4");
fs.writeFileSync(activeFile, Buffer.alloc(1024, 0x55));

let killedSignals = [];
const mockProc = {
  kill: (sig) => {
    killedSignals.push(sig);
  }
};

const watchdogRecorder = new StreamRecorder({
  outputBaseDir: watchdogDir,
  watchdogTimeoutMs: 50, // 50ms para test rápido
  watchdogIntervalMs: 10
});

watchdogRecorder.isRecording = true;
watchdogRecorder.ffmpegProc = mockProc;
watchdogRecorder.activeChunk = activeFile;
watchdogRecorder.lastBytesProgressAt = Date.now() - 100; // Simular 100ms sin actividad (>50ms)
watchdogRecorder.lastMonitoredPath = activeFile;
watchdogRecorder.lastMonitoredSize = 1024; // Mismo tamaño

watchdogRecorder.checkWatchdog();
assert.ok(killedSignals.includes("SIGINT"), "El watchdog DEBE enviar SIGINT al subproceso colgado");

// 7.4 Watchdog: Si el archivo crece, no dispara reinicio
killedSignals = [];
fs.appendFileSync(activeFile, Buffer.alloc(512, 0x66)); // Aumenta tamaño a 1536 bytes
watchdogRecorder.checkWatchdog();
assert.strictEqual(killedSignals.length, 0, "No debe matar el proceso si el archivo creció");
assert.strictEqual(watchdogRecorder.lastMonitoredSize, 1536);

// Limpiar directorio watchdog
fs.rmSync(watchdogDir, { recursive: true, force: true });
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("-> Argumentos FFmpeg HTTP/RTSP y watchdog de inactividad validados exitosamente.");

console.log("\n🎉 ¡Todas las pruebas de Google Drive Client y Stream Recorder pasaron al 100%!");
