/**
 * Servidor de Streaming de Video en Vivo On-Demand (MJPEG / Sub-Stream)
 * Permite a los clientes web visualizar la cámara en vivo con latencia mínima (< 400ms)
 * sin sobrecargar la CPU de la VM ni consumir ancho de banda cuando nadie está conectado.
 */

import { spawn, execSync } from "child_process";
import http from "http";
import https from "https";

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

export class StreamServer {
  constructor(options = {}) {
    this.rtspUrl = options.rtspUrl || process.env.RTSP_STREAM_URL || "rtsp://127.0.0.1:8554/barberia/sub";
    this.fps = options.fps || Number(process.env.STREAM_FPS) || 3.5;
    this.jpegQuality = options.jpegQuality || Number(process.env.STREAM_JPEG_QUALITY) || 4;
    this.mockVideoPath = options.mockVideoPath || process.env.MOCK_VIDEO_PATH || null;
    this.mockVideoLastMinutes = options.mockVideoLastMinutes != null
      ? Number(options.mockVideoLastMinutes)
      : (process.env.MOCK_VIDEO_LAST_MINUTES ? Number(process.env.MOCK_VIDEO_LAST_MINUTES) : null);
    this.mockVideoStartSs = options.mockVideoStartSs != null
      ? Number(options.mockVideoStartSs)
      : (process.env.MOCK_VIDEO_START_SS ? Number(process.env.MOCK_VIDEO_START_SS) : null);
    this.mockVideoDurationSs = options.mockVideoDurationSs != null
      ? Number(options.mockVideoDurationSs)
      : (process.env.MOCK_VIDEO_DURATION_SS ? Number(process.env.MOCK_VIDEO_DURATION_SS) : null);
    this.mockVideoLoop = options.mockVideoLoop != null
      ? Boolean(options.mockVideoLoop)
      : (process.env.MOCK_VIDEO_LOOP === "true");
    this.streamFastForward = options.streamFastForward != null
      ? Boolean(options.streamFastForward)
      : (process.env.STREAM_FAST_FORWARD === "true");
    this.onEnsureRtspSource = options.onEnsureRtspSource || null;
    this.onMockVideoEnd = options.onMockVideoEnd || null;
    this.clients = new Set();
    this.ffmpegProcess = null;
    this.latestFrameBuffer = null;
    this.latestFrameTimestamp = null;
    this.latestFrameVirtualNow = null;
    this.framesEmitted = 0;
    this.streamStartEpoch = null;
    this.streamEndedAt = null;
    this.isActive = false;
    this.isRemoteRelay = false;
    this.remoteRelayUrl = null;
    this.remoteRelayActive = false;
    this.relayRequest = null;
    this.relayWatchdog = null;
    this.relayReconnectTimer = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.isFramePendingConsumption = false;
  }

  /**
   * Retorna el reloj virtual sincronizado con los fotogramas del video en modo Fast-Forward,
   * o Date.now() en modo tiempo real / producción.
   * @returns {number} Epoch en milisegundos
   */
  getVirtualNow() {
    if (this.mockVideoPath && (this.latestConsumedVirtualNow || this.latestFrameVirtualNow)) {
      return this.latestConsumedVirtualNow || this.latestFrameVirtualNow;
    }
    if (this.mockVideoPath && this.streamFastForward && this.streamStartEpoch) {
      const videoElapsedMs = Math.round(((this.framesEmitted || 0) / (this.fps || 3.5)) * 1000);
      const postEndMs = (!this.isActive && this.streamEndedAt)
        ? Math.round((Date.now() - this.streamEndedAt) * 10)
        : 0;
      return this.streamStartEpoch + videoElapsedMs + postEndMs;
    }
    return Date.now();
  }

  /**
   * Habilita el modo Relay Remoto: consume fotogramas periódicamente desde el servidor de producción
   * (ej: https://stream.perrosuelto.com) evitando abrir procesos FFmpeg o sesiones P2P locales.
   * @param {string} remoteUrl
   * @param {Buffer} [initialBuffer]
   */
  enableRemoteRelay(remoteUrl, initialBuffer = null) {
    this.isRemoteRelay = true;
    this.remoteRelayUrl = remoteUrl.replace(/\/+$/, "");
    if (initialBuffer && Buffer.isBuffer(initialBuffer)) {
      this.latestFrameBuffer = initialBuffer;
      this.latestFrameTimestamp = Date.now();
    }
    console.log(`[Stream] 🔄 Modo Relay Remoto activado hacia: ${this.remoteRelayUrl}`);
    this.startRemoteRelayLoop();
  }

  startRemoteRelayLoop() {
    if (this.remoteRelayActive) return;
    this.remoteRelayActive = true;
    this.isActive = true;

    const connectRelay = () => {
      if (!this.isRemoteRelay || !this.remoteRelayUrl || !this.remoteRelayActive) return;

      const isHttps = this.remoteRelayUrl.startsWith("https");
      const transport = isHttps ? https : http;
      const streamEndpoint = `${this.remoteRelayUrl}/api/stream`;

      console.log(`[Stream Relay] Conectando flujo continuo MJPEG persistente a: ${streamEndpoint}...`);

      let chunkBuffer = Buffer.alloc(0);
      let lastFrameTime = Date.now();

      const req = transport.get(streamEndpoint, { headers: { "Cache-Control": "no-cache" } }, (res) => {
        if (res.statusCode !== 200) {
          console.warn(`[Stream Relay] Respuesta HTTP no-200 (${res.statusCode}). Reintentando en 3s...`);
          res.resume();
          scheduleReconnect();
          return;
        }

        res.on("data", (data) => {
          chunkBuffer = Buffer.concat([chunkBuffer, data]);
          const firstSoi = chunkBuffer.indexOf(JPEG_SOI);
          if (firstSoi > 0) {
            chunkBuffer = chunkBuffer.slice(firstSoi);
          }

          let startIndex = chunkBuffer.indexOf(JPEG_SOI);
          let endIndex = chunkBuffer.indexOf(JPEG_EOI);

          while (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
            const frame = chunkBuffer.slice(startIndex, endIndex + 2);
            chunkBuffer = chunkBuffer.slice(endIndex + 2);

            lastFrameTime = Date.now();
            this.latestFrameTimestamp = Date.now();
            this.latestFrameBuffer = frame;
            this.broadcastFrame(frame);

            startIndex = chunkBuffer.indexOf(JPEG_SOI);
            endIndex = chunkBuffer.indexOf(JPEG_EOI);
          }
        });

        res.on("end", () => {
          console.warn("[Stream Relay] Flujo remoto finalizado. Reconectando...");
          scheduleReconnect();
        });

        res.on("error", (err) => {
          console.warn("[Stream Relay] Error en flujo remoto:", err.message);
          scheduleReconnect();
        });
      });

      req.on("error", (err) => {
        console.warn("[Stream Relay] Error de conexión hacia origen:", err.message);
        scheduleReconnect();
      });

      this.relayRequest = req;

      if (this.relayWatchdog) clearInterval(this.relayWatchdog);
      this.relayWatchdog = setInterval(() => {
        if (this.remoteRelayActive && Date.now() - lastFrameTime > 10000) {
          console.warn("[Stream Relay] Sin fotogramas remotos (>10s). Reiniciando conexión...");
          if (this.relayWatchdog) clearInterval(this.relayWatchdog);
          try { req.destroy(); } catch (_) {}
          scheduleReconnect();
        }
      }, 3000);

      const scheduleReconnect = () => {
        if (this.relayWatchdog) {
          clearInterval(this.relayWatchdog);
          this.relayWatchdog = null;
        }
        if (this.relayReconnectTimer) clearTimeout(this.relayReconnectTimer);
        if (this.remoteRelayActive) {
          this.relayReconnectTimer = setTimeout(connectRelay, 3000);
        }
      };
    };

    connectRelay();
  }

  disableRemoteRelay() {
    this.isRemoteRelay = false;
    this.remoteRelayUrl = null;
    this.remoteRelayActive = false;
    if (this.relayWatchdog) {
      clearInterval(this.relayWatchdog);
      this.relayWatchdog = null;
    }
    if (this.relayReconnectTimer) {
      clearTimeout(this.relayReconnectTimer);
      this.relayReconnectTimer = null;
    }
    if (this.relayRequest) {
      try { this.relayRequest.destroy(); } catch (_) {}
      this.relayRequest = null;
    }
    console.log("[Stream] Modo Relay Remoto desactivado.");
  }

  /**
   * Registra un cliente HTTP para recibir el flujo MJPEG
   * @param {Object} req - Express Request
   * @param {Object} res - Express Response
   */
  handleStreamRequest(req, res) {
    res.writeHead(200, {
      "Content-Type": "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
      "X-Accel-Buffering": "no"
    });

    const client = { id: Date.now() + Math.random(), res };
    this.clients.add(client);
    console.log(`[Stream] Nuevo cliente web conectado. Clientes activos: ${this.clients.size}`);

    // Si había un fotograma reciente y fresco (< 15s), enviarlo inmediatamente
    const freshFrame = this.getLatestFrame();
    if (freshFrame) {
      this.sendFrameToClient(client, freshFrame);
    }

    // Iniciar ffmpeg si es el primer cliente
    if (this.clients.size === 1) {
      this.startFfmpegStream();
    }

    req.on("close", () => {
      this.clients.delete(client);
      console.log(`[Stream] Cliente web desconectado. Clientes restantes: ${this.clients.size}`);
      if (this.clients.size === 0) {
        this.stopFfmpegStream();
      }
    });
  }

  /**
   * Obtiene la duración de un video local en segundos usando ffprobe
   * @param {string} filePath
   * @returns {number|null}
   */
  getVideoDuration(filePath) {
    try {
      const output = execSync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
        { encoding: "utf8", timeout: 5000 }
      );
      const dur = parseFloat(output.trim());
      return Number.isFinite(dur) && dur > 0 ? dur : null;
    } catch (err) {
      console.warn(`[Stream] No se pudo determinar duración con ffprobe para ${filePath}:`, err.message);
      return null;
    }
  }

  /**
   * Calcula el segundo de inicio para videos mock basado en MOCK_VIDEO_START_SS o MOCK_VIDEO_LAST_MINUTES
   * @returns {number} Offset en segundos (0 si inicia desde el principio)
   */
  getMockVideoStartOffset() {
    if (this.mockVideoStartSs != null && !isNaN(this.mockVideoStartSs)) {
      return Math.max(0, this.mockVideoStartSs);
    }
    if (this.mockVideoLastMinutes != null && !isNaN(this.mockVideoLastMinutes)) {
      const duration = this.getVideoDuration(this.mockVideoPath);
      if (duration != null) {
        const offset = Math.max(0, Math.floor(duration - this.mockVideoLastMinutes * 60));
        console.log(`[Stream] ⏱️ Duración del video: ${duration.toFixed(1)}s (~${(duration / 60).toFixed(1)} min). MOCK_VIDEO_LAST_MINUTES=${this.mockVideoLastMinutes} -> Iniciando en t=${offset}s (${Math.floor(offset / 60)}m ${offset % 60}s).`);
        return offset;
      }
    }
    return 0;
  }

  /**
   * Inicia el proceso de lectura RTSP con FFmpeg
   */
  async startFfmpegStream(persistent = false) {
    if (persistent) this.isPersistent = true;
    if (this.isRemoteRelay) {
      this.startRemoteRelayLoop();
      return;
    }
    if (this.ffmpegProcess && !this.ffmpegProcess.killed) return;
    if (this.isStarting) return;
    this.isStarting = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      if (!this.mockVideoPath && typeof this.onEnsureRtspSource === "function") {
        try {
          if (this.reconnectAttempts >= 3) {
            await this.onEnsureRtspSource({ forceRestart: true });
          } else {
            await this.onEnsureRtspSource();
          }
        } catch (err) {
          console.warn("[Stream] Aviso al verificar daemon RTSP:", err.message);
        }
      }

      let seekOffset = 0;
      if (this.mockVideoPath) {
        seekOffset = this.getMockVideoStartOffset();
      }

      const isLoop = Boolean(this.mockVideoPath && this.mockVideoLoop);
      const isFastForward = Boolean(this.mockVideoPath && this.streamFastForward);
      const args = this.mockVideoPath
        ? [
            ...(!isFastForward ? ["-re"] : []),
            ...(seekOffset > 0 ? ["-ss", String(seekOffset)] : []),
            ...(this.mockVideoDurationSs > 0 ? ["-t", String(this.mockVideoDurationSs)] : []),
            ...(isLoop ? ["-stream_loop", "-1"] : []),
            "-i", this.mockVideoPath,
            "-an",
            "-r", String(this.fps),
            "-threads", isFastForward ? "0" : "1",
            "-f", "image2pipe",
            "-q:v", String(this.jpegQuality),
            "-vcodec", "mjpeg",
            "pipe:1"
          ]
        : [
            "-rtsp_transport", "tcp",
            "-analyzeduration", "15000000",
            "-probesize", "1000000",
            "-i", this.rtspUrl,
            "-an",
            "-r", String(this.fps),
            "-threads", "1",
            "-f", "image2pipe",
            "-q:v", String(this.jpegQuality),
            "-vcodec", "mjpeg",
            "pipe:1"
          ];

      if (this.mockVideoPath) {
        const seekMsg = seekOffset > 0 ? ` (iniciando en ${Math.floor(seekOffset / 60)}m ${seekOffset % 60}s)` : "";
        console.log(`[Stream] 🎬 Iniciando ingesta FFmpeg en modo MOCK VIDEO desde: ${this.mockVideoPath}${seekMsg} a ${this.fps} FPS (bucle continuo 1x)...`);
      } else {
        console.log(`[Stream] Iniciando ingesta FFmpeg on-demand desde: ${this.rtspUrl} a ${this.fps} FPS...`);
      }

      this.framesEmitted = 0;
      this.streamStartEpoch = Date.now() + (seekOffset * 1000);
      this.streamEndedAt = null;
      this.isFramePendingConsumption = false;
      this.ffmpegProcess = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
      this.isActive = true;
      let lastFrameTime = Date.now();

      // Watchdog de inactividad: Si FFmpeg no entrega fotogramas en 20 segundos, reiniciar
      if (this.watchdogInterval) clearInterval(this.watchdogInterval);
      this.watchdogInterval = setInterval(() => {
        if (this.isActive && !this.isFramePendingConsumption && Date.now() - lastFrameTime > 20000) {
          console.warn("[Stream Watchdog] Inactividad de fotogramas detectada (>20s). Reiniciando ingesta FFmpeg...");
          this.stopFfmpegStream(true);
        }
      }, 5000);

      let stderrBuffer = "";
      this.ffmpegProcess.stderr.on("data", (data) => {
        const msg = data.toString();
        stderrBuffer = (stderrBuffer + msg).slice(-2000);
        if (msg.includes("Error") || msg.includes("failed") || msg.includes("refused") || msg.includes("Invalid")) {
          console.warn("[Stream FFmpeg]", msg.trim());
        }
      });

      let chunkBuffer = Buffer.alloc(0);

      const processChunks = () => {
        if (this.mockVideoPath && this.streamFastForward && this.isFramePendingConsumption) {
          return;
        }

        // Descartar bytes corruptos previos al primer SOI (0xFF, 0xD8)
        const firstSoi = chunkBuffer.indexOf(JPEG_SOI);
        if (firstSoi > 0) {
          chunkBuffer = chunkBuffer.slice(firstSoi);
        }

        // Delimitador JPEG: SOI (0xFFD8) y EOI (0xFFD9)
        let startIndex = chunkBuffer.indexOf(JPEG_SOI);
        let endIndex = chunkBuffer.indexOf(JPEG_EOI);

        while (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
          const frame = chunkBuffer.slice(startIndex, endIndex + 2);
          chunkBuffer = chunkBuffer.slice(endIndex + 2);

          lastFrameTime = Date.now();
          this.latestFrameTimestamp = Date.now();
          this.framesEmitted = (this.framesEmitted || 0) + 1;
          this.reconnectAttempts = 0;
          this.latestFrameBuffer = frame;

          const videoElapsedMs = this.mockVideoPath
            ? Math.round(((this.framesEmitted || 0) / (this.fps || 3.5)) * 1000)
            : 0;
          this.latestFrameVirtualNow = this.mockVideoPath
            ? (this.streamStartEpoch + videoElapsedMs)
            : Date.now();

          this.broadcastFrame(frame);

          if (this.mockVideoPath && this.streamFastForward) {
            this.isFramePendingConsumption = true;
            if (this.ffmpegProcess && this.ffmpegProcess.stdout && !this.ffmpegProcess.stdout.isPaused()) {
              this.ffmpegProcess.stdout.pause();
            }
            break;
          }

          const nextSoi = chunkBuffer.indexOf(JPEG_SOI);
          if (nextSoi > 0) {
            chunkBuffer = chunkBuffer.slice(nextSoi);
          }
          startIndex = chunkBuffer.indexOf(JPEG_SOI);
          endIndex = chunkBuffer.indexOf(JPEG_EOI);
        }

        // Si el buffer crece demasiado por datos corruptos, reiniciar
        if (chunkBuffer.length > 8 * 1024 * 1024) {
          chunkBuffer = Buffer.alloc(0);
        }
      };

      this._processPendingStreamChunks = processChunks;

      this.ffmpegProcess.stdout.on("data", (data) => {
        chunkBuffer = Buffer.concat([chunkBuffer, data]);
        processChunks();
      });

      this.ffmpegProcess.on("exit", (code) => {
        this.isFramePendingConsumption = false;
        this._processPendingStreamChunks = null;
        console.log(`[Stream] Proceso FFmpeg finalizó con código: ${code}`);
        if (code !== 0 && stderrBuffer.trim().length > 0) {
          console.warn(`[Stream FFmpeg Último Detalle]:\n${stderrBuffer.trim()}`);
        }
        this.ffmpegProcess = null;
        this.isActive = false;
        this.streamEndedAt = Date.now();
        if (this.watchdogInterval) clearInterval(this.watchdogInterval);
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }

        // Si es video mock y terminó normalmente sin bucle, concluir la reproducción limpiamente
        if (this.mockVideoPath && !this.mockVideoLoop && code === 0) {
          console.log("[Stream] 🎬 Reproducción de video mock finalizada (reproducción única completa).");
          this.isPersistent = false;
          this.latestFrameBuffer = null;
          this.latestFrameTimestamp = null;
          if (typeof this.onMockVideoEnd === "function") {
            Promise.resolve(this.onMockVideoEnd(this.getVirtualNow())).catch(err => {
              console.warn("[Stream] Aviso en onMockVideoEnd:", err.message);
            });
          }
          return;
        }

        // Si es persistente o aún hay clientes, programar reconexión con backoff en caso de fallo
        if (this.isPersistent || this.clients.size > 0) {
          let delayMs = 2000;
          if (code !== 0) {
            this.reconnectAttempts = (this.reconnectAttempts || 0) + 1;
            if (this.reconnectAttempts >= 3) {
              console.warn(`[Stream] Múltiples fallos consecutivos (#${this.reconnectAttempts}). Forzando reciclaje de daemon RTSP en próximo intento...`);
            }
            // Backoff exponencial: 2s, 4s, 8s, 16s, máx 30s
            delayMs = Math.min(2000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
            console.warn(`[Stream] Reintento de ingesta FFmpeg programado en ${delayMs / 1000}s (fallo #${this.reconnectAttempts})...`);
          } else {
            this.reconnectAttempts = 0;
          }
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.startFfmpegStream(this.isPersistent);
          }, delayMs);
        }
      });

      this.ffmpegProcess.on("error", (err) => {
        console.warn(`[Stream] Aviso FFmpeg: ${err.message}`);
        this.stopFfmpegStream(true);
      });
    } catch (err) {
      console.error("[Stream] Error al lanzar FFmpeg:", err.message);
      this.stopFfmpegStream(true);
    } finally {
      this.isStarting = false;
    }
  }

  /**
   * Detiene el proceso de FFmpeg para ahorrar CPU y ancho de banda
   */
  stopFfmpegStream(force = false) {
    if (force) {
      this.latestFrameBuffer = null;
      this.latestFrameTimestamp = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.isRemoteRelay) {
      if (!force && this.isPersistent) return;
      this.disableRemoteRelay();
      this.isActive = false;
      return;
    }
    if (!force && this.isPersistent) {
      // En modo persistente (visión en tiempo real continua), mantener FFmpeg activo para el loop de YOLO
      return;
    }
    if (this.watchdogInterval) clearInterval(this.watchdogInterval);
    if (this.ffmpegProcess) {
      console.log("[Stream] Deteniendo FFmpeg. CPU y Red en reposo.");
      const proc = this.ffmpegProcess;
      this.ffmpegProcess = null;
      try {
        proc.kill("SIGTERM");
      } catch (_) {}
      setTimeout(() => {
        try {
          if (!proc.killed) {
            proc.kill("SIGKILL");
          }
        } catch (_) {}
      }, 500);
    }
    this.isFramePendingConsumption = false;
    this._processPendingStreamChunks = null;
    this.isActive = false;
  }

  /**
   * Envía un fotograma a todos los clientes conectados
   */
  broadcastFrame(frameBuffer) {
    for (const client of this.clients) {
      this.sendFrameToClient(client, frameBuffer);
    }
  }

  sendFrameToClient(client, frameBuffer) {
    try {
      client.res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frameBuffer.length}\r\n\r\n`);
      client.res.write(frameBuffer);
      client.res.write("\r\n");
    } catch (_) {
      this.clients.delete(client);
    }
  }

  /**
   * Consume y retorna el fotograma más reciente en memoria, liberando el backpressure
   * y reanudando la ingesta de FFmpeg si la simulación rápida está activa.
   * @param {number} [maxAgeMs=15000]
   * @returns {Buffer|null}
   */
  consumeLatestFrame(maxAgeMs = 15000) {
    return this.getLatestFrame(maxAgeMs);
  }

  /**
   * Retorna el fotograma más reciente en memoria si no está obsoleto
   * @param {number} [maxAgeMs=15000]
   * @returns {Buffer|null}
   */
  getLatestFrame(maxAgeMs = 15000) {
    if (this.latestFrameTimestamp && (Date.now() - this.latestFrameTimestamp > maxAgeMs)) {
      return null;
    }
    const frame = this.latestFrameBuffer;
    this.latestConsumedVirtualNow = this.latestFrameVirtualNow;

    if (this.mockVideoPath && this.streamFastForward && this.isFramePendingConsumption) {
      this.isFramePendingConsumption = false;
      if (this.ffmpegProcess && this.ffmpegProcess.stdout && this.ffmpegProcess.stdout.isPaused()) {
        this.ffmpegProcess.stdout.resume();
      }
      if (typeof this._processPendingStreamChunks === "function") {
        this._processPendingStreamChunks();
      }
    }

    return frame;
  }
}
