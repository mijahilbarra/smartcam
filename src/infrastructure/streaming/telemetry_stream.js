/**
 * Servidor de Transmisión de Telemetría y Seguimiento YOLO en Tiempo Real (Server-Sent Events - SSE)
 * Proporciona un flujo continuo y de bajísima latencia (< 20ms) directo desde el Backend Express
 * hacia el navegador, transmitiendo las cajas delimitadoras de YOLO, personas rastreadas y cuadrantes.
 */

export class TelemetryStreamServer {
  constructor() {
    this.clients = new Set();
    this.latestTelemetry = null;
    this.latestDaemonState = null;
    this.latestTrackBlocks = [];
    this.heartbeatInterval = null;

    // Iniciar ping de liveness para proxies y balanceadores
    this.startHeartbeat();
  }

  /**
   * Atiende una conexión HTTP para el flujo SSE de telemetría YOLO
   * @param {Object} req - Express Request
   * @param {Object} res - Express Response
   */
  handleRequest(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type"
    });

    res.write("retry: 2000\n\n");

    const client = { id: Date.now() + Math.random(), res };
    this.clients.add(client);
    console.log(`[YOLO Stream] Nuevo cliente SSE conectado. Clientes activos: ${this.clients.size}`);

    // Si tenemos una detección reciente, enviarla de inmediato para no esperar al siguiente ciclo
    if (this.latestTelemetry) {
      this.sendToClient(client, this.latestTelemetry);
    }
    if (this.latestDaemonState) {
      try {
        res.write(`event: daemon_state\ndata: ${JSON.stringify(this.latestDaemonState)}\n\n`);
      } catch (_) {}
    }

    req.on("close", () => {
      this.clients.delete(client);
      console.log(`[YOLO Stream] Cliente SSE desconectado. Clientes restantes: ${this.clients.size}`);
    });
  }

  /**
   * Transmite el resultado del análisis YOLO a todos los navegadores conectados
   * @param {Object} data - Objeto de telemetría (detections, tracks, quadrants, occupancy)
   */
  broadcast(data) {
    if (Array.isArray(data.allTrackBlocks)) {
      this.latestTrackBlocks = data.allTrackBlocks;
    }

    this.latestTelemetry = {
      ...(this.latestTelemetry || {}),
      ...data,
      allTrackBlocks: Array.isArray(data.allTrackBlocks) ? data.allTrackBlocks : (this.latestTrackBlocks || []),
      timestamp: Date.now()
    };

    let payload = null;

    for (const client of this.clients) {
      try {
        // Protección de contrapresión (backpressure):
        // Si el socket del cliente tiene más de 1 MB pendiente por drenar (típico en fast-forward),
        // omitir este fotograma de telemetría para evitar acumulación infinita en el heap de V8.
        if (client.res?.writableLength > 1024 * 1024) {
          continue;
        }
        if (!payload) {
          payload = `data: ${JSON.stringify(this.latestTelemetry)}\n\n`;
        }
        client.res.write(payload);
      } catch (_) {
        this.clients.delete(client);
      }
    }
  }

  getLatestTrackBlocks() {
    return this.latestTrackBlocks || [];
  }

  sendToClient(client, data) {
    try {
      client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (_) {
      this.clients.delete(client);
    }
  }

  /**
   * Transmite el estado del daemon (paso actual, historial, countdown) como evento SSE "daemon_state".
   * Reemplaza la antigua escritura continua a Firestore camera_catcher/daemon_state.
   */
  broadcastDaemonState(state) {
    this.latestDaemonState = { ...state, updatedAt: state.updatedAt || new Date().toISOString() };
    const payload = `event: daemon_state\ndata: ${JSON.stringify(this.latestDaemonState)}\n\n`;
    for (const client of this.clients) {
      try {
        client.res.write(payload);
      } catch (_) {
        this.clients.delete(client);
      }
    }
  }

  /**
   * Transmite un evento SSE nombrado genérico (p. ej. "analysis_decision") a todos los clientes.
   */
  broadcastEvent(eventName, data) {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      try {
        client.res.write(payload);
      } catch (_) {
        this.clients.delete(client);
      }
    }
  }

  startHeartbeat() {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      for (const client of this.clients) {
        try {
          client.res.write(": keep-alive\n\n");
        } catch (_) {
          this.clients.delete(client);
        }
      }
    }, 15000);
    if (typeof this.heartbeatInterval.unref === "function") {
      this.heartbeatInterval.unref();
    }
  }

  stop() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const client of this.clients) {
      try {
        client.res.end();
      } catch (_) {}
    }
    this.clients.clear();
  }

  getLatestTelemetry() {
    return this.latestTelemetry;
  }
}

export const telemetryStream = new TelemetryStreamServer();
