/**
 * Listeners en Tiempo Real de Firestore
 * Escucha cambios de configuración (prompt/intervalos), comandos manuales de captura y calibración de cuadrantes.
 */

import { setCustomQuadrants, getDefaultQuadrantsArray } from "../../detector.js";

/**
 * Inicializa y carga la configuración inicial de cámara_catcher/prompt
 * @param {Object} db
 * @param {string} defaultPrompt
 * @returns {Promise<Object>}
 */
export async function getDynamicConfig(db, defaultPrompt = "Describe what do you see in the image") {
  try {
    const promptRef = db.doc("camera_catcher/prompt");
    const doc = await promptRef.get();
    if (!doc.exists) {
      console.log("[Config] camera_catcher/prompt no existe. Creando con configuración por defecto (11am a 11pm)...");
      const initialConfig = {
        default: defaultPrompt,
        intervalMinutes: 15,
        workStartTime: "11:00",
        workEndTime: "23:00",
        timezone: "America/Lima",
        updatedAt: new Date().toISOString()
      };
      await promptRef.set(initialConfig);
      return initialConfig;
    }
    const data = doc.data();

    const missingDefaults = {};
    if (!data?.workStartTime && !data?.workStart) missingDefaults.workStartTime = "11:00";
    if (!data?.workEndTime && !data?.workEnd) missingDefaults.workEndTime = "23:00";
    if (!data?.timezone) missingDefaults.timezone = "America/Lima";

    if (Object.keys(missingDefaults).length > 0) {
      await promptRef.set(missingDefaults, { merge: true });
    }

    return {
      prompt: data?.default || defaultPrompt,
      intervalMinutes: data?.intervalMinutes !== undefined ? Number(data.intervalMinutes) : 3,
      workStartTime: String(data?.workStartTime || data?.workStart || "11:00"),
      workEndTime: String(data?.workEndTime || data?.workEnd || "23:00"),
      timezone: data?.timezone || "America/Lima"
    };
  } catch (err) {
    console.warn("[Config] Error leyendo configuración de Firestore, usando defaults:", err.message);
    return { prompt: defaultPrompt, intervalMinutes: 3, workStartTime: "11:00", workEndTime: "23:00", timezone: "America/Lima" };
  }
}

/**
 * Registra todos los listeners en tiempo real de Firestore
 * @param {Object} options
 * @param {Object} options.db
 * @param {Object} options.scheduler
 * @param {Function} options.onManualCapture
 */
export function registerFirestoreListeners({ db, scheduler, onManualCapture }) {
  // 1. Listener de configuración (intervalo y horario laboral)
  db.doc("camera_catcher/prompt").onSnapshot(async (snapshot) => {
    const data = snapshot.data();
    if (!data) return;

    if (data.intervalMinutes !== undefined) {
      const newInterval = Number(data.intervalMinutes);
      if (!isNaN(newInterval) && newInterval !== scheduler.currentIntervalMinutes) {
        console.log(`[Config] Actualización de intervalo detectada en Firestore: ${newInterval} minutos.`);
        scheduler.setupTimer(newInterval);
      }
    }

    const newStart = data.workStartTime || data.workStart || data.startHour || "11:00";
    const newEnd = data.workEndTime || data.workEnd || data.endHour || "23:00";
    const newTz = data.timezone || "America/Lima";

    scheduler.updateWorkingHours(newStart, newEnd, newTz);

    const missingDefaults = {};
    if (!data.workStartTime && !data.workStart) missingDefaults.workStartTime = "11:00";
    if (!data.workEndTime && !data.workEnd) missingDefaults.workEndTime = "23:00";
    if (!data.timezone) missingDefaults.timezone = "America/Lima";
    if (Object.keys(missingDefaults).length > 0) {
      try {
        await db.doc("camera_catcher/prompt").set(missingDefaults, { merge: true });
      } catch (_) {}
    }
  }, (err) => {
    console.warn(`[Config] Error escuchando camera_catcher/prompt:`, err.message);
  });

  // 2. Listener de comandos manuales ("Capturar Ahora")
  let lastTriggerHandled = Date.now();
  console.log(`[Listener] Escuchando comandos en tiempo real de Firestore: camera_catcher/commands...`);
  db.doc("camera_catcher/commands").onSnapshot((snapshot) => {
    const data = snapshot.data();
    if (data && data.action === "capture" && data.requestedAt > lastTriggerHandled) {
      lastTriggerHandled = data.requestedAt;
      console.log(`[Listener] Disparo manual recibido desde la web a las ${new Date(data.requestedAt).toLocaleTimeString()}`);
      if (typeof onManualCapture === "function") {
        onManualCapture("manual").catch(err => {
          console.error(`[Listener] Error procesando captura manual:`, err.message);
        });
      }
    }
  }, (err) => {
    console.warn(`[Listener] Error en snapshot listener de commands:`, err.message);
  });

  // 3. Listener de cuadrantes dinámicos
  console.log(`[Quadrants] Escuchando configuración de cuadrantes en tiempo real: camera_catcher/quadrants...`);
  db.doc("camera_catcher/quadrants").onSnapshot(async (snapshot) => {
    if (!snapshot.exists) {
      console.log(`[Quadrants] camera_catcher/quadrants no existe. Creando con valores por defecto...`);
      try {
        await db.doc("camera_catcher/quadrants").set({
          updatedAt: new Date().toISOString(),
          updatedBy: "system_init",
          quadrants: getDefaultQuadrantsArray()
        });
        console.log(`[Quadrants] Valores iniciales de cuadrantes guardados en Firestore.`);
      } catch (e) {
        console.warn(`[Quadrants] No se pudo autoinicializar camera_catcher/quadrants:`, e.message);
      }
      return;
    }

    const data = snapshot.data();
    if (data && data.quadrants) {
      setCustomQuadrants(data.quadrants);
    }
  }, (err) => {
    console.warn(`[Quadrants] Error escuchando camera_catcher/quadrants:`, err.message);
  });
}

/**
 * Precarga los cuadrantes de Firestore al iniciar la aplicación
 * @param {Object} db
 */
export async function prefetchQuadrants(db) {
  try {
    const snap = await db.doc("camera_catcher/quadrants").get();
    if (snap.exists && snap.data()?.quadrants) {
      setCustomQuadrants(snap.data().quadrants);
      console.log(`[Quadrants] Cuadrantes dinámicos precargados exitosamente de Firestore (${snap.data().quadrants.length} zonas).`);
    }
  } catch (err) {
    console.warn(`[Quadrants] No se pudieron precargar cuadrantes al iniciar:`, err.message);
  }
}
