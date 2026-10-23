/**
 * Grabador y Uploader Continuo de Streaming en Chunks de 15 Minutos para Google Drive.
 * Divide el stream RTSP en segmentos .mp4 sin recodificación (-c copy),
 * sube los segmentos completados a Google Drive organizados en carpetas YYYY-MM-DD,
 * y purga de inmediato el almacenamiento local para proteger la VM e2-micro.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleDriveClient } from "../storage/gdrive_client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../..");

export class StreamRecorder {
  /**
   * @param {Object} [options]
   * @param {number} [options.segmentDurationSec] Duración de cada chunk (por defecto 900s = 15m)
   * @param {string} [options.outputBaseDir] Directorio base local de grabaciones
   * @param {GoogleDriveClient} [options.gdriveClient] Instancia de GoogleDriveClient
   * @param {string} [options.streamUrl] URL de stream origen (HTTP MJPEG unificado o RTSP)
   * @param {string} [options.rtspUrl] Alias retrocompatible para streamUrl
   * @param {Object} [options.workingHours] Gestor de horario laboral opcional
   * @param {number} [options.uploadIntervalMs] Frecuencia de revisión del worker de subida
   * @param {number} [options.settleTimeMs] Tiempo para considerar completado un chunk inactivo
   * @param {number} [options.watchdogTimeoutMs] Tiempo sin nuevos bytes para reiniciar FFmpeg (por defecto 45000ms = 45s)
   * @param {number} [options.watchdogIntervalMs] Intervalo de chequeo del watchdog (por defecto 5000ms)
   */
  constructor(options = {}) {
    this.segmentDurationSec = Number(options.segmentDurationSec) || 900;
    this.outputBaseDir = options.outputBaseDir || path.join(PROJECT_ROOT, "data", "recordings");
    this.gdriveClient = options.gdriveClient || new GoogleDriveClient();
    this.streamUrl = options.streamUrl || options.rtspUrl || process.env.RECORDER_STREAM_URL || process.env.RTSP_STREAM_URL || "http://127.0.0.1:8085/api/stream";
    this.rtspUrl = this.streamUrl; // Retrocompatibilidad
    this.workingHours = options.workingHours || null;
    this.uploadIntervalMs = options.uploadIntervalMs || 5000;
    this.settleTimeMs = options.settleTimeMs || 15000; // 15 segundos de estabilidad
    this.watchdogTimeoutMs = options.watchdogTimeoutMs || 45000; // 45 segundos sin bytes nuevos
    this.watchdogIntervalMs = options.watchdogIntervalMs || 5000;

    this.isRecording = false;
    this._stopping = false;
    this.ffmpegProc = null;
    this.activeChunk = null;
    this.uploadTimer = null;
    this.restartTimeout = null;
    this.watchdogTimer = null;

    // Métricas
    this.uploadedCount = 0;
    this.failedCount = 0;
    this.lastUploadedFile = null;
    this.lastError = null;

    // Control de concurrencia y seguimiento de archivos locales
    this.inProgressUploads = new Set();
    this.fileStateTracker = new Map(); // path -> { size, lastModified, stableSince }

    // Estado del watchdog
    this.lastBytesProgressAt = 0;
    this.lastMonitoredPath = null;
    this.lastMonitoredSize = -1;
  }

  /**
   * Genera los argumentos de FFmpeg según el protocolo de origen (HTTP MJPEG o RTSP H.264).
   * @param {string} outputPattern Patrón de salida para el segmentador
   * @returns {string[]}
   */
  getFfmpegArgs(outputPattern) {
    const isHttp = this.streamUrl.startsWith("http://") || this.streamUrl.startsWith("https://");
    return isHttp
      ? [
          "-y",
          "-use_wallclock_as_timestamps", "1",
          "-f", "mjpeg",
          "-i", this.streamUrl,
          "-c:v", "libx264",
          "-preset", "ultrafast",
          "-crf", "28",
          "-pix_fmt", "yuv420p",
          "-f", "segment",
          "-segment_time", String(this.segmentDurationSec),
          "-segment_format", "mp4",
          "-reset_timestamps", "1",
          "-strftime", "1",
          "-segment_format_options", "movflags=+faststart",
          outputPattern
        ]
      : [
          "-y",
          "-rtsp_transport", "tcp",
          "-i", this.streamUrl,
          "-c:v", "copy",
          "-an",
          "-f", "segment",
          "-segment_time", String(this.segmentDurationSec),
          "-segment_format", "mp4",
          "-reset_timestamps", "1",
          "-strftime", "1",
          "-segment_format_options", "movflags=+faststart",
          outputPattern
        ];
  }

  /**
   * Asegura que existan las carpetas de fecha (hoy y mañana) en outputBaseDir.
   * Evita errores en FFmpeg si la carpeta del día aún no ha sido creada.
   */
  ensureDayDirs() {
    if (!fs.existsSync(this.outputBaseDir)) {
      fs.mkdirSync(this.outputBaseDir, { recursive: true });
    }

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const todayDir = path.join(this.outputBaseDir, today);
    if (!fs.existsSync(todayDir)) {
      fs.mkdirSync(todayDir, { recursive: true });
    }

    // Asegurar también mañana por si hay cambio de día a medianoche
    const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
    const tomorrowDir = path.join(this.outputBaseDir, tomorrow);
    if (!fs.existsSync(tomorrowDir)) {
      fs.mkdirSync(tomorrowDir, { recursive: true });
    }
  }

  /**
   * Inicia el proceso de grabación continua, el worker de subida y el watchdog.
   */
  start() {
    if (this.isRecording) return;
    this.isRecording = true;
    this._stopping = false;

    this.ensureDayDirs();
    this._startFfmpeg();
    this._startUploadWorker();
    this._startWatchdog();

    console.log(
      `[StreamRecorder] Grabación continua iniciada (segmentos de ${this.segmentDurationSec}s). Origen: ${this.streamUrl}. Destino local: ${this.outputBaseDir}`
    );
  }

  /**
   * Lanza el subproceso FFmpeg para segmentación de video.
   */
  _startFfmpeg() {
    if (this.ffmpegProc || !this.isRecording || this._stopping) return;

    this.ensureDayDirs();

    const outputPattern = path.join(this.outputBaseDir, "%Y-%m-%d", "chunk_%Y%m%d_%H%M%S.mp4");
    const ffmpegArgs = this.getFfmpegArgs(outputPattern);

    console.log(`[StreamRecorder] Lanzando FFmpeg: ${this.streamUrl} -> ${outputPattern}`);
    this.lastBytesProgressAt = Date.now();
    this.lastMonitoredPath = null;
    this.lastMonitoredSize = -1;

    const proc = spawn("ffmpeg", ffmpegArgs, { stdio: ["pipe", "pipe", "pipe"] });
    this.ffmpegProc = proc;

    proc.stdout.on("data", () => {});
    proc.stderr.on("data", (data) => {
      const msg = data.toString();
      // Detectar inicio de nuevo segmento para actualizar el activeChunk
      const match = msg.match(/Opening '([^']+)' for writing/);
      if (match && match[1]) {
        this.activeChunk = match[1];
      }
    });

    proc.on("error", (err) => {
      console.warn("[StreamRecorder] Error en proceso FFmpeg:", err.message);
      this.lastError = err.message;
    });

    proc.on("close", (code, signal) => {
      console.log(`[StreamRecorder] FFmpeg detenido (código: ${code}, señal: ${signal}).`);
      this.ffmpegProc = null;
      this.activeChunk = null;

      // Si no fue parada intencional, reintentar con backoff de 5s
      if (this.isRecording && !this._stopping) {
        console.warn("[StreamRecorder] Conexión de stream perdida o finalizada. Reintentando en 5s...");
        this.restartTimeout = setTimeout(() => {
          if (this.isRecording && !this._stopping) {
            this._startFfmpeg();
          }
        }, 5000);
        if (typeof this.restartTimeout.unref === "function") this.restartTimeout.unref();
      }
    });
  }

  /**
   * Inicia el watchdog periódico para supervisar el crecimiento de bytes en la grabación activa.
   */
  _startWatchdog() {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.lastBytesProgressAt = Date.now();
    this.lastMonitoredPath = null;
    this.lastMonitoredSize = -1;

    this.watchdogTimer = setInterval(() => {
      this.checkWatchdog();
    }, this.watchdogIntervalMs);

    if (typeof this.watchdogTimer.unref === "function") this.watchdogTimer.unref();
  }

  /**
   * Comprueba si el archivo en grabación activa ha dejado de recibir bytes durante más de watchdogTimeoutMs (45s).
   */
  checkWatchdog() {
    if (!this.isRecording || this._stopping || !this.ffmpegProc) {
      return;
    }

    const now = Date.now();
    let currentTarget = this.activeChunk;

    if (!currentTarget) {
      const segments = this.scanLocalSegments();
      if (segments.length > 0) {
        currentTarget = segments[segments.length - 1].path;
      }
    }

    if (!currentTarget) {
      // Si tras watchdogTimeoutMs no se ha creado ningún archivo, reiniciar FFmpeg
      if (now - this.lastBytesProgressAt > this.watchdogTimeoutMs) {
        console.warn(
          `[StreamRecorder] ⚠️ Watchdog: No se ha detectado creación de archivo en ${Math.round(
            (now - this.lastBytesProgressAt) / 1000
          )}s (> ${Math.round(this.watchdogTimeoutMs / 1000)}s). Reiniciando subproceso FFmpeg...`
        );
        this._restartFfmpegDueToStall();
      }
      return;
    }

    try {
      if (!fs.existsSync(currentTarget)) {
        return;
      }
      const stat = fs.statSync(currentTarget);
      const currentSize = stat.size;

      if (currentTarget !== this.lastMonitoredPath) {
        // Se abrió un nuevo segmento
        this.lastMonitoredPath = currentTarget;
        this.lastMonitoredSize = currentSize;
        this.lastBytesProgressAt = now;
      } else if (currentSize > this.lastMonitoredSize) {
        // Ha crecido el archivo: hay progreso
        this.lastMonitoredSize = currentSize;
        this.lastBytesProgressAt = now;
      } else {
        // No ha recibido bytes nuevos
        if (now - this.lastBytesProgressAt > this.watchdogTimeoutMs) {
          console.warn(
            `[StreamRecorder] ⚠️ Watchdog: Segmento activo '${path.basename(
              currentTarget
            )}' no ha recibido bytes nuevos en ${Math.round(
              (now - this.lastBytesProgressAt) / 1000
            )}s (> ${Math.round(this.watchdogTimeoutMs / 1000)}s). Reiniciando subproceso FFmpeg...`
          );
          this._restartFfmpegDueToStall();
        }
      }
    } catch (_) {
      // Ignorar errores transitorios de lectura de fs
    }
  }

  /**
   * Finaliza el subproceso FFmpeg colgado para forzar su reinicio ordenado mediante el handler 'close'.
   */
  _restartFfmpegDueToStall() {
    this.lastBytesProgressAt = Date.now();
    if (!this.ffmpegProc) return;

    const proc = this.ffmpegProc;
    console.warn("[StreamRecorder] Reiniciando subproceso FFmpeg por inactividad prolongada (>45s)...");

    try {
      if (typeof proc.kill === "function") {
        proc.kill("SIGINT");
        const killTimer = setTimeout(() => {
          try {
            if (this.ffmpegProc === proc) {
              proc.kill("SIGKILL");
            }
          } catch (_) {}
        }, 3000);
        if (typeof killTimer.unref === "function") killTimer.unref();
      }
    } catch (_) {
      try {
        proc.kill("SIGKILL");
      } catch (_) {}
    }
  }

  /**
   * Inicia el temporizador de sondeo de segmentos completados.
   */
  _startUploadWorker() {
    if (this.uploadTimer) clearInterval(this.uploadTimer);
    this.uploadTimer = setInterval(() => {
      this.processPendingSegments().catch((err) => {
        console.warn("[StreamRecorder] Error en ciclo de subida:", err.message);
      });
    }, this.uploadIntervalMs);

    if (typeof this.uploadTimer.unref === "function") this.uploadTimer.unref();
  }

  /**
   * Escanea el directorio local para recopilar todos los archivos .mp4.
   * @returns {Array<{path: string, fileName: string, dateStr: string, size: number, mtimeMs: number}>}
   */
  scanLocalSegments() {
    if (!fs.existsSync(this.outputBaseDir)) return [];

    const segments = [];
    const entries = fs.readdirSync(this.outputBaseDir, { withFileTypes: true });

    for (const entry of entries) {
      // Solo procesar subcarpetas con formato de fecha YYYY-MM-DD
      // Protege archivos base de simulación en data/recordings/ (ej: barberia_stream_7h.mp4)
      if (entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name)) {
        const subPath = path.join(this.outputBaseDir, entry.name);
        const subFiles = fs.readdirSync(subPath);
        for (const f of subFiles) {
          if (f.endsWith(".mp4")) {
            const filePath = path.join(subPath, f);
            try {
              const stat = fs.statSync(filePath);
              segments.push({
                path: filePath,
                fileName: f,
                dateStr: entry.name,
                size: stat.size,
                mtimeMs: stat.mtimeMs
              });
            } catch (_) {}
          }
        }
      }
    }

    // Ordenar cronológicamente por mtime o nombre de archivo
    segments.sort((a, b) => a.mtimeMs - b.mtimeMs || a.fileName.localeCompare(b.fileName));
    return segments;
  }

  /**
   * Determina cuáles de los archivos escaneados están completamente finalizados.
   * Un archivo se considera completado si:
   * 1. No es el archivo activo de FFmpeg actual, Y
   * 2. (Existe un archivo posterior creado por FFmpeg, O su tamaño no ha cambiado en los últimos settleTimeMs).
   * Si FFmpeg ya no está corriendo, todos los archivos con tamaño > 0 se consideran completados.
   * @returns {Array<{path: string, fileName: string, dateStr: string, size: number}>}
   */
  getCompletedSegments() {
    const segments = this.scanLocalSegments();
    if (segments.length === 0) return [];

    const now = Date.now();
    const completed = [];

    // Si FFmpeg está corriendo, el último archivo es potencialmente el archivo activo
    const latestSegment = segments[segments.length - 1];
    if (this.ffmpegProc && !this.activeChunk && latestSegment) {
      this.activeChunk = latestSegment.path;
    }

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.size === 0) continue; // Descartar temporales vacíos

      // Si FFmpeg está apagado, todos los archivos con tamaño son completados
      if (!this.ffmpegProc) {
        completed.push(seg);
        continue;
      }

      // Si es un archivo previo a otro más reciente en la lista, FFmpeg ya cerró este segmento
      const hasSubsequent = i < segments.length - 1;
      if (hasSubsequent && seg.path !== this.activeChunk) {
        completed.push(seg);
        continue;
      }

      // Si es el último archivo o no hay subsecuente, verificar estabilidad temporal
      const state = this.fileStateTracker.get(seg.path) || {
        size: seg.size,
        lastModified: seg.mtimeMs,
        stableSince: now
      };

      if (seg.size !== state.size) {
        state.size = seg.size;
        state.lastModified = seg.mtimeMs;
        state.stableSince = now;
        this.fileStateTracker.set(seg.path, state);
      } else {
        const isStable = now - state.stableSince >= this.settleTimeMs;
        const isNotActive = seg.path !== this.activeChunk;
        if (isStable && isNotActive) {
          completed.push(seg);
        }
      }
    }

    return completed;
  }

  /**
   * Procesa la subida de los segmentos completados y purga inmediatamente el archivo local.
   * @param {Object} [options]
   * @param {boolean} [options.uploadActive] Forzar subida incluso del último segmento (ej. al apagar)
   */
  async processPendingSegments({ uploadActive = false } = {}) {
    let completed = this.getCompletedSegments();

    if (uploadActive && !this.ffmpegProc) {
      completed = this.scanLocalSegments().filter((s) => s.size > 0);
    }

    for (const seg of completed) {
      if (this.inProgressUploads.has(seg.path)) continue;

      this.inProgressUploads.add(seg.path);
      try {
        console.log(`[StreamRecorder] 📤 Subiendo segmento: ${seg.fileName} (${(seg.size / (1024 * 1024)).toFixed(2)} MB)...`);

        const rootFolderId = await this.gdriveClient.ensureRootFolder();
        const dayFolderId = await this.gdriveClient.ensureDayFolder(seg.dateStr, rootFolderId);

        const uploadResult = await this.gdriveClient.uploadVideoChunk(seg.path, seg.fileName, dayFolderId);

        if (uploadResult && uploadResult.fileId) {
          this.uploadedCount++;
          this.lastUploadedFile = {
            fileName: seg.fileName,
            fileId: uploadResult.fileId,
            size: uploadResult.size,
            uploadedAt: new Date().toISOString()
          };

          // PURGA LOCAL INMEDIATA
          if (fs.existsSync(seg.path)) {
            fs.unlinkSync(seg.path);
            console.log(`[StreamRecorder] 🗑️ Segmento purgado de disco local: ${seg.path}`);
          }

          this.fileStateTracker.delete(seg.path);

          // Limpiar carpeta del día si quedó vacía
          try {
            const dir = path.dirname(seg.path);
            if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
              fs.rmdirSync(dir);
            }
          } catch (_) {}
        }
      } catch (err) {
        this.failedCount++;
        this.lastError = err.message;
        console.warn(`[StreamRecorder] Fallo al subir segmento '${seg.fileName}':`, err.message);
      } finally {
        this.inProgressUploads.delete(seg.path);
      }
    }
  }

  /**
   * Obtiene la cantidad de segmentos pendientes en disco local.
   * @returns {number}
   */
  getPendingCount() {
    return this.scanLocalSegments().length;
  }

  /**
   * Detiene limpiamente la grabación enviando SIGINT a FFmpeg para cerrar el átomo moov
   * y procesa todos los segmentos pendientes.
   */
  async stop() {
    if (!this.isRecording && !this.ffmpegProc) return;
    this._stopping = true;
    this.isRecording = false;

    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }

    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }

    if (this.uploadTimer) {
      clearInterval(this.uploadTimer);
      this.uploadTimer = null;
    }

    if (this.ffmpegProc) {
      console.log("[StreamRecorder] Deteniendo FFmpeg limpiamente (SIGINT) para consolidar MP4...");
      await new Promise((resolve) => {
        let resolved = false;
        const done = () => {
          if (!resolved) {
            resolved = true;
            resolve();
          }
        };

        const timer = setTimeout(() => {
          if (this.ffmpegProc) {
            console.warn("[StreamRecorder] Forzando terminación de FFmpeg (SIGKILL)...");
            try { this.ffmpegProc.kill("SIGKILL"); } catch (_) {}
          }
          done();
        }, 5000);

        if (typeof this.ffmpegProc.once === "function") {
          this.ffmpegProc.once("close", () => {
            clearTimeout(timer);
            done();
          });
        } else {
          done();
        }

        try {
          if (typeof this.ffmpegProc.kill === "function") {
            this.ffmpegProc.kill("SIGINT");
          } else {
            done();
          }
        } catch (_) {
          done();
        }
      });
      this.ffmpegProc = null;
      this.activeChunk = null;
    }

    console.log("[StreamRecorder] Procesando subida final de segmentos remanentes...");
    await this.processPendingSegments({ uploadActive: true });
    this._stopping = false;
    console.log("[StreamRecorder] Grabador detenido completamente.");
  }

  /**
   * Retorna métricas en tiempo real sobre la grabación y subida a Google Drive.
   * @returns {Object}
   */
  getStats() {
    return {
      isRecording: this.isRecording,
      activeChunk: this.activeChunk,
      uploadedCount: this.uploadedCount,
      failedCount: this.failedCount,
      pendingCount: this.getPendingCount(),
      lastUploadedFile: this.lastUploadedFile,
      lastError: this.lastError
    };
  }
}
