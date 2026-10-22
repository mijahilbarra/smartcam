/**
 * Listeners en Tiempo Real de Firestore
 * Escucha cambios de configuración (prompt/horario laboral) y calibración de cuadrantes.
 */

import fs from "fs";
import path from "path";
import { setCustomQuadrants } from "../../detector.js";

/**
 * Inicializa y carga la configuración inicial de cámara_catcher/prompt
 * @param {Object} db
 * @param {string} defaultPrompt
 * @returns {Promise<Object>}
 */
export async function getDynamicConfig(db, defaultPrompt = "Describe what do you see in the image") {
  if (!db) {
    return { prompt: defaultPrompt, workStartTime: "00:00", workEndTime: "23:59", timezone: "America/Lima" };
  }
  try {
    const promptRef = db.doc("camera_catcher/prompt");
    const doc = await promptRef.get();
    if (!doc.exists) {
      console.log("[Config] camera_catcher/prompt no existe. Creando con configuración por defecto (11am a 11pm)...");
      const initialConfig = {
        default: defaultPrompt,
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
      workStartTime: String(data?.workStartTime || data?.workStart || "11:00"),
      workEndTime: String(data?.workEndTime || data?.workEnd || "23:00"),
      timezone: data?.timezone || "America/Lima"
    };
  } catch (err) {
    console.warn("[Config] Error leyendo configuración de Firestore, usando defaults:", err.message);
    return { prompt: defaultPrompt, workStartTime: "11:00", workEndTime: "23:00", timezone: "America/Lima" };
  }
}

/**
 * Registra todos los listeners en tiempo real de Firestore
 * @param {Object} options
 * @param {Object} options.db
 * @param {Object} options.workingHours
 */
export function registerFirestoreListeners({ db, workingHours, customerService }) {
  if (!db) {
    console.log(`[Firestore] 🧪 Modo Test activo: Listeners de Firestore omitidos. Operando 100% con SQLite.`);
    return;
  }

  // 1. Listener de configuración (horario laboral y prompt)
  db.doc("camera_catcher/prompt").onSnapshot(async (snapshot) => {
    const data = snapshot.data();
    if (!data) return;

    const newStart = data.workStartTime || data.workStart || data.startHour || "11:00";
    const newEnd = data.workEndTime || data.workEnd || data.endHour || "23:00";
    const newTz = data.timezone || "America/Lima";

    if (workingHours?.updateWorkingHours) {
      workingHours.updateWorkingHours(newStart, newEnd, newTz);
    }

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

  // 2. Listener de cuadrantes dinámicos
  console.log(`[Quadrants] Escuchando configuración de cuadrantes en tiempo real: camera_catcher/quadrants...`);
  db.doc("camera_catcher/quadrants").onSnapshot((snapshot) => {
    if (!snapshot.exists) {
      console.log(`[Quadrants] No hay cuadrantes configurados en Firestore (camera_catcher/quadrants). Se requiere calibración inicial desde el Calibrador Visual.`);
      setCustomQuadrants([]);
      return;
    }

    const data = snapshot.data();
    if (data) {
      let quads = [];
      if (Array.isArray(data.quadrants)) {
        quads = data.quadrants;
      } else if (data.quadrants && typeof data.quadrants === "object") {
        quads = Object.values(data.quadrants);
      } else if (Array.isArray(data.zones)) {
        quads = data.zones;
      }
      setCustomQuadrants(quads);
    }
  }, (err) => {
    console.warn(`[Quadrants] Error escuchando camera_catcher/quadrants:`, err.message);
  });

  // 3. Listener de directorio biométrico de personas en tiempo real
  if (customerService && typeof customerService.setupPeopleListener === "function") {
    customerService.setupPeopleListener(db);
  }
}

/**
 * Precarga los cuadrantes de Firestore al iniciar la aplicación (o desde data/quadrants.json en modo test)
 * @param {Object} db
 */
export async function prefetchQuadrants(db) {
  if (!db) {
    try {
      const localFile = path.resolve(process.cwd(), "data", "quadrants.json");
      if (fs.existsSync(localFile)) {
        const raw = fs.readFileSync(localFile, "utf8");
        const quads = JSON.parse(raw);
        setCustomQuadrants(quads);
        console.log(`[Quadrants] 🧪 Cuadrantes locales precargados desde data/quadrants.json (${quads.length} zonas).`);
        return;
      }
    } catch (err) {
      console.warn(`[Quadrants] Aviso leyendo data/quadrants.json:`, err.message);
    }
    setCustomQuadrants([]);
    return;
  }

  try {
    const snap = await db.doc("camera_catcher/quadrants").get();
    if (snap.exists) {
      const data = snap.data();
      let quads = [];
      if (Array.isArray(data?.quadrants)) {
        quads = data.quadrants;
      } else if (data?.quadrants && typeof data.quadrants === "object") {
        quads = Object.values(data.quadrants);
      } else if (Array.isArray(data?.zones)) {
        quads = data.zones;
      }
      setCustomQuadrants(quads);
      if (quads.length === 0) {
        console.log(`[Quadrants] camera_catcher/quadrants existe pero tiene 0 zonas configuradas. Se requiere calibración inicial desde el Calibrador Visual.`);
      } else {
        console.log(`[Quadrants] Cuadrantes dinámicos precargados exitosamente de Firestore (${quads.length} zonas).`);
      }
    } else {
      console.log(`[Quadrants] No hay cuadrantes configurados en Firestore (camera_catcher/quadrants). Se requiere calibración inicial desde el Calibrador Visual.`);
      setCustomQuadrants([]);
    }
  } catch (err) {
    console.warn(`[Quadrants] No se pudieron precargar cuadrantes al iniciar:`, err.message);
  }
}
