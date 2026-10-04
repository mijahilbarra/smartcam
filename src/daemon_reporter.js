/**
 * daemon_reporter.js
 * Gestiona y transmite la telemetría en tiempo real de cada paso del Daemon a Firestore: camera_catcher/daemon_state
 */

import { toPointObject, sanitizeForFirestore } from "./detector.js";

const MAX_EVENT_LOG_SIZE = 30;

class DaemonReporter {
  constructor() {
    this.db = null;
    this.currentState = {
      step: "idle",
      stepIndex: 0,
      stepTitle: "Daemon Inicializado",
      stepDescription: "Esperando inicio del primer ciclo...",
      timestamp: new Date().toISOString(),
      countdown: {
        nextCaptureAt: null,
        intervalMinutes: 3,
        remainingSeconds: 0,
        isWithinWorkingHours: true,
        workHours: "11:00 - 23:00 (America/Lima)"
      },
      image: null,
      quadrants: [],
      humans: {
        hasHumans: false,
        count: 0,
        detections: []
      },
      people: [],
      history: []
    };
  }

  /**
   * Vincula la instancia de Firestore admin
   */
  init(firestoreDb) {
    this.db = firestoreDb;
  }

  /**
   * Añade una entrada al historial descriptivo
   */
  _addHistoryEntry(text, type = "info") {
    const entry = {
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: new Date().toISOString(),
      timeFormatted: new Intl.DateTimeFormat("es-PE", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZone: "America/Lima"
      }).format(new Date()),
      text,
      type
    };

    const history = [entry, ...(this.currentState.history || [])];
    if (history.length > MAX_EVENT_LOG_SIZE) {
      history.length = MAX_EVENT_LOG_SIZE;
    }
    this.currentState.history = history;
    return entry;
  }

  /**
   * Envía el estado acumulado a Firestore de manera asíncrona sin bloquear la ejecución del daemon
   */
  async _syncToFirestore() {
    if (!this.db) return;
    try {
      this.currentState.updatedAt = new Date().toISOString();
      const sanitizedPayload = sanitizeForFirestore(this.currentState);
      await this.db.doc("camera_catcher/daemon_state").set(sanitizedPayload, { merge: true });
    } catch (err) {
      console.warn("[DaemonReporter] Error sincronizando estado a Firestore:", err.message);
    }
  }

  /**
   * Fase 0: Actualiza el contador de minutos/segundos hacia la siguiente consulta
   */
  async setCountdown(nextCaptureDate, intervalMinutes, workInfo = {}) {
    const nextIso = nextCaptureDate ? nextCaptureDate.toISOString() : null;
    const remainingSec = nextCaptureDate ? Math.max(0, Math.round((nextCaptureDate.getTime() - Date.now()) / 1000)) : 0;
    const remainingMin = (remainingSec / 60).toFixed(1);

    this.currentState.step = "countdown";
    this.currentState.stepIndex = 0;
    this.currentState.stepTitle = "Contador de Ciclo Activo";
    this.currentState.stepDescription = workInfo.isWithinWorkingHours === false
      ? `Fuera de horario laboral (${workInfo.workStart || "11:00"} a ${workInfo.workEnd || "23:00"}). Capturas programadas en pausa.`
      : `Contador activo: Próxima consulta a la cámara de seguridad en ~${remainingMin} minutos (${intervalMinutes} min intervalo).`;

    this.currentState.countdown = {
      nextCaptureAt: nextIso,
      intervalMinutes: Number(intervalMinutes) || 3,
      remainingSeconds: remainingSec,
      isWithinWorkingHours: workInfo.isWithinWorkingHours !== false,
      workHours: `${workInfo.workStart || "11:00"} - ${workInfo.workEnd || "23:00"} (${workInfo.timezone || "America/Lima"})`
    };

    this._addHistoryEntry(
      `⏱️ Contador programado: Próxima captura en ~${remainingMin} min (${intervalMinutes} min). Horario: ${this.currentState.countdown.workHours}.`,
      "countdown"
    );

    await this._syncToFirestore();
  }

  /**
   * Fase 1: Se activa la consulta a la cámara de seguridad
   */
  async reportCameraQuery(triggerType = "scheduled") {
    this.currentState.step = "querying_camera";
    this.currentState.stepIndex = 1;
    this.currentState.stepTitle = "Consulta a Cámara de Seguridad";
    this.currentState.stepDescription = `Se activa la consulta P2P (Neolink/Baichuan) hacia la cámara 'barberia' [Disparo: ${triggerType === "manual" ? "Manual desde Web" : "Programado por Cron"}].`;
    this.currentState.startedAt = new Date().toISOString();

    this._addHistoryEntry(
      `📡 Se activa la consulta a la cámara de seguridad [${triggerType.toUpperCase()}]. Conectando por P2P...`,
      "process"
    );

    await this._syncToFirestore();
  }

  /**
   * Fase 2: Llega la imagen => Enviar al canvas
   */
  async reportImageReceived({ storagePath, width, height, sizeBytes, docId, publicUrl }) {
    this.currentState.step = "image_received";
    this.currentState.stepIndex = 2;
    this.currentState.stepTitle = "Imagen Recibida de la Cámara";
    this.currentState.stepDescription = `Llega la imagen de seguridad (${width}x${height} px, ${(sizeBytes / 1024).toFixed(1)} KB) => Se imprime en el Canvas.`;
    this.currentState.image = {
      storagePath,
      publicUrl: publicUrl || "",
      docId,
      width,
      height,
      sizeBytes,
      receivedAt: new Date().toISOString()
    };

    this._addHistoryEntry(
      `🖼️ Llega la imagen de seguridad (${width}x${height} px, ${(sizeBytes / 1024).toFixed(1)} KB) => Imprimiendo imagen base en Canvas.`,
      "process"
    );

    await this._syncToFirestore();
  }

  /**
   * Fase 3: Se activan y dibujan los cuadrantes
   */
  async reportQuadrantsActive(quadrants) {
    const list = Array.isArray(quadrants) ? quadrants : [];
    this.currentState.step = "quadrants_active";
    this.currentState.stepIndex = 3;
    this.currentState.stepTitle = "Activación de Cuadrantes Físicos";
    this.currentState.stepDescription = `Se activan los cuadrantes: Se proyectan ${list.length} zonas ROI configuradas (sillas, puestos y tránsito) en el Canvas.`;
    this.currentState.quadrants = list.map(q => ({
      id: q.id,
      label: q.label || q.name || q.id,
      category: q.category || "general",
      type: q.type || "zone",
      status: q.status || "disponible",
      color: q.color || "#007BFF",
      box: q.box,
      polygonNorm: Array.isArray(q.polygonNorm)
        ? q.polygonNorm.map(toPointObject)
        : undefined
    }));

    const statusCounts = list.map(q => `${q.label} [${q.status || "activo"}]`).join(", ");
    this._addHistoryEntry(
      `📐 Se activan los cuadrantes: dibujando ${list.length} zonas en el Canvas (${statusCounts || "sin zonas"}).`,
      "process"
    );

    await this._syncToFirestore();
  }

  /**
   * Fase 4: Se detecta si hay humanos o no (YOLOv8)
   */
  async reportHumanDetection(mlResult) {
    const rawDetections = mlResult.rawDetections || [];
    const personDetections = rawDetections.filter(d => d.class === "person");
    const hasHumans = personDetections.length > 0;

    this.currentState.step = "detecting_humans";
    this.currentState.stepIndex = 4;
    this.currentState.stepTitle = "Detección de Humanos (YOLOv8)";
    this.currentState.stepDescription = hasHumans
      ? `Se detectan ${personDetections.length} humano(s) en escena (Inferencia ML: ${mlResult.inferenceMs} ms). Dibujando recuadros en Canvas.`
      : `Inferencia ML completada en ${mlResult.inferenceMs} ms. NO se detectan humanos en la escena.`;

    this.currentState.humans = {
      hasHumans,
      count: personDetections.length,
      inferenceMs: mlResult.inferenceMs,
      detections: personDetections.map((p, idx) => ({
        id: `person_${idx + 1}`,
        score: p.score,
        box: p.box
      }))
    };

    this._addHistoryEntry(
      hasHumans
        ? `👤 Detección de humanos: ¡SÍ se detectan humanos! (${personDetections.length} persona(s) detectada(s) en ${mlResult.inferenceMs} ms).`
        : `⚪ Detección de humanos: NO se detectan humanos presentes en la escena (${mlResult.inferenceMs} ms).`,
      hasHumans ? "success" : "info"
    );

    await this._syncToFirestore();
  }

  /**
   * Fase 5: Reconocimiento y clasificación biométrica (Barbero, Clientes frecuentes, Nuevos)
   */
  async reportPeopleIdentified(identifiedPeople, clientRecords = []) {
    const list = Array.isArray(identifiedPeople) ? identifiedPeople : [];
    this.currentState.step = "identifying_people";
    this.currentState.stepIndex = 5;
    this.currentState.stepTitle = "Identificación y Clasificación Biométrica";

    let desc = "";
    if (list.length === 0) {
      desc = "Sin personas sentadas o rostros para clasificación biométrica en este ciclo.";
    } else {
      const staffList = list.filter(p => p.isStaff);
      const freqList = list.filter(p => !p.isStaff && p.isFrequent);
      const newList = list.filter(p => !p.isStaff && !p.isFrequent);

      const parts = [];
      if (staffList.length > 0) parts.push(`${staffList.length} Barbero/Staff (${staffList.map(s => s.name).join(", ")})`);
      if (freqList.length > 0) parts.push(`${freqList.length} Cliente(s) Frecuente(s) (${freqList.map(f => `${f.name} - ${f.visitCount} visitas`).join(", ")})`);
      if (newList.length > 0) parts.push(`${newList.length} Nuevo(s) Cliente(s) (${newList.map(n => n.name).join(", ")})`);

      desc = `Clasificación biométrica: ${parts.join(" • ")}. Mostrando insignias sobre el Canvas.`;
    }

    this.currentState.stepDescription = desc;
    this.currentState.people = list.map(p => {
      // Find matching crop box
      const matchingRec = clientRecords.find(c => c.id === p.cropId);
      return {
        cropId: p.cropId,
        personId: p.personId,
        name: p.name,
        role: p.role || (p.isStaff ? "Barbero" : p.isFrequent ? "Cliente Frecuente" : "Nuevo Cliente"),
        isStaff: p.isStaff === true,
        isFrequent: p.isFrequent === true,
        visitCount: p.visitCount || 1,
        similarity: p.similarity || 0,
        confidence: p.confidence || 0.8,
        box: matchingRec ? matchingRec.box : null
      };
    });

    this._addHistoryEntry(
      `👥 ${desc}`,
      list.length > 0 ? "success" : "info"
    );

    await this._syncToFirestore();
  }

  /**
   * Fase 6: Ciclo completado y documento persistido
   */
  async reportCycleCompleted({ docId, summary, nextCaptureDate, intervalMinutes }) {
    const nextIso = nextCaptureDate ? nextCaptureDate.toISOString() : null;
    const remainingSec = nextCaptureDate ? Math.max(0, Math.round((nextCaptureDate.getTime() - Date.now()) / 1000)) : 0;

    this.currentState.step = "completed";
    this.currentState.stepIndex = 6;
    this.currentState.stepTitle = "Ciclo Completado Exitosamente";
    this.currentState.stepDescription = `Proceso finalizado. Fotograma guardado en Firestore (${docId}). Reiniciando contador para próxima captura...`;
    this.currentState.lastDocId = docId;
    this.currentState.completedAt = new Date().toISOString();
    this.currentState.summary = summary;

    if (nextCaptureDate) {
      this.currentState.countdown = {
        ...this.currentState.countdown,
        nextCaptureAt: nextIso,
        remainingSeconds: remainingSec,
        intervalMinutes: Number(intervalMinutes) || 3
      };
    }

    this._addHistoryEntry(
      `✅ Ciclo finalizado exitosamente. Documento registrado: ${docId}. Reiniciando contador regresivo.`,
      "success"
    );

    await this._syncToFirestore();
  }

  /**
   * Notificación de error en cualquier fase
   */
  async reportError(err) {
    this.currentState.step = "error";
    this.currentState.stepTitle = "Error en Ejecución de Captura";
    this.currentState.stepDescription = `Falló el proceso: ${err.message || err}`;
    this.currentState.lastError = err.message || String(err);
    this.currentState.lastErrorAt = new Date().toISOString();

    this._addHistoryEntry(
      `❌ Error en captura: ${err.message || err}`,
      "error"
    );

    await this._syncToFirestore();
  }
}

export const daemonReporter = new DaemonReporter();
