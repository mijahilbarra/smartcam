/**
 * Servidor de Streaming de Video en Vivo On-Demand (MJPEG / Sub-Stream)
 * Permite a los clientes web visualizar la cámara en vivo con latencia mínima (< 400ms)
 * sin sobrecargar la CPU de la VM ni consumir ancho de banda cuando nadie está conectado.
 */

import { spawn } from "child_process";

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

export class StreamServer {
  constructor(options = {}) {
    this.rtspUrl = options.rtspUrl || process.env.RTSP_STREAM_URL || "rtsp://127.0.0.1:8554/barberia/sub";
    this.fps = options.fps || 8;
    this.clients = new Set();
    this.ffmpegProcess = null;
    this.latestFrameBuffer = null;
    this.isActive = false;
    this.isRemoteRelay = false;
    this.remoteRelayUrl = null;
    this.remoteRelayInterval = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
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
    }
    console.log(`[Stream] 🔄 Modo Relay Remoto activado hacia: ${this.remoteRelayUrl}`);
    this.startRemoteRelayLoop();
  }

  startRemoteRelayLoop() {
    if (this.remoteRelayInterval) return;
    this.isActive = true;

    const pollFrame = async () => {
      if (!this.isRemoteRelay || !this.remoteRelayUrl) return;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`${this.remoteRelayUrl}/api/snapshot`, {
          method: "GET",
          signal: controller.signal,
          headers: { "Cache-Control": "no-cache" }
        });
        clearTimeout(timer);
        if (res.ok) {
          const arrayBuffer = await res.arrayBuffer();
          if (arrayBuffer.byteLength > 1000) {
            const frame = Buffer.from(arrayBuffer);
            this.latestFrameBuffer = frame;
            this.broadcastFrame(frame);
          }
        }
      } catch (_) {
        // Silencioso ante pérdidas transitorias de red
      }
    };

    // Polling a ~2 FPS (500ms) para telemetría y visualización fluida sin sobrecargar red
    this.remoteRelayInterval = setInterval(pollFrame, 500);
    pollFrame();
  }

  disableRemoteRelay() {
    this.isRemoteRelay = false;
    this.remoteRelayUrl = null;
    if (this.remoteRelayInterval) {
      clearInterval(this.remoteRelayInterval);
      this.remoteRelayInterval = null;
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

    // Si había un fotograma reciente, enviarlo inmediatamente
    if (this.latestFrameBuffer) {
      this.sendFrameToClient(client, this.latestFrameBuffer);
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
   * Inicia el proceso de lectura RTSP con FFmpeg
   */
  startFfmpegStream(persistent = false) {
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

    console.log(`[Stream] Iniciando ingesta FFmpeg on-demand desde: ${this.rtspUrl} a ${this.fps} FPS...`);

    const args = [
      "-rtsp_transport", "tcp",
      "-analyzeduration", "15000000",
      "-probesize", "1000000",
      "-i", this.rtspUrl,
      "-an",
      "-r", String(this.fps),
      "-f", "image2pipe",
      "-q:v", "5",
      "-vcodec", "mjpeg",
      "pipe:1"
    ];

    try {
      this.ffmpegProcess = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
      this.isStarting = false;
      this.isActive = true;
      let lastFrameTime = Date.now();

      // Watchdog de inactividad: Si FFmpeg no entrega fotogramas en 20 segundos, reiniciar
      if (this.watchdogInterval) clearInterval(this.watchdogInterval);
      this.watchdogInterval = setInterval(() => {
        if (this.isActive && Date.now() - lastFrameTime > 20000) {
          console.warn("[Stream Watchdog] Inactividad de fotogramas detectada (>20s). Reiniciando ingesta FFmpeg...");
          this.stopFfmpegStream(true);
        }
      }, 5000);

      this.ffmpegProcess.stderr.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg.includes("Error") || msg.includes("failed") || msg.includes("refused")) {
          console.warn("[Stream FFmpeg]", msg);
        }
      });

      let chunkBuffer = Buffer.alloc(0);

      this.ffmpegProcess.stdout.on("data", (data) => {
        chunkBuffer = Buffer.concat([chunkBuffer, data]);

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
          this.reconnectAttempts = 0;
          this.latestFrameBuffer = frame;
          this.broadcastFrame(frame);

          const nextSoi = chunkBuffer.indexOf(JPEG_SOI);
          if (nextSoi > 0) {
            chunkBuffer = chunkBuffer.slice(nextSoi);
          }
          startIndex = chunkBuffer.indexOf(JPEG_SOI);
          endIndex = chunkBuffer.indexOf(JPEG_EOI);
        }

        // Si el buffer crece demasiado por datos corruptos, reiniciar
        if (chunkBuffer.length > 2 * 1024 * 1024) {
          chunkBuffer = Buffer.alloc(0);
        }
      });

      this.ffmpegProcess.on("exit", (code) => {
        console.log(`[Stream] Proceso FFmpeg finalizó con código: ${code}`);
        this.ffmpegProcess = null;
        this.isActive = false;
        if (code !== 0) {
          this.latestFrameBuffer = null;
        }
        if (this.watchdogInterval) clearInterval(this.watchdogInterval);
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }

        // Si es persistente o aún hay clientes, programar reconexión con backoff en caso de fallo
        if (this.isPersistent || this.clients.size > 0) {
          let delayMs = 2000;
          if (code !== 0) {
            this.reconnectAttempts = (this.reconnectAttempts || 0) + 1;
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
      this.isStarting = false;
      console.error("[Stream] Error al lanzar FFmpeg:", err.message);
      this.stopFfmpegStream(true);
    }
  }

  /**
   * Detiene el proceso de FFmpeg para ahorrar CPU y ancho de banda
   */
  stopFfmpegStream(force = false) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.isRemoteRelay) {
      if (!force && this.isPersistent) return;
      if (this.remoteRelayInterval) {
        clearInterval(this.remoteRelayInterval);
        this.remoteRelayInterval = null;
      }
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
   * Retorna el fotograma más reciente en memoria
   */
  getLatestFrame() {
    return this.latestFrameBuffer;
  }
}
