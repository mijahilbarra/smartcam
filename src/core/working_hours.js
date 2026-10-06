/**
 * Dominio de Horarios Laborales y Zonas Horarias
 * Funciones puras para evaluar ventanas de operación del daemon.
 */

/**
 * Convierte un formato de hora (ej: "11:00", "11:00 AM", "11pm", "23:00", 11) a minutos desde las 00:00
 * @param {string|number} timeVal
 * @returns {number|null}
 */
export function parseTimeToMinutes(timeVal) {
  if (typeof timeVal === "number") {
    return Math.floor(timeVal * 60);
  }
  if (!timeVal || typeof timeVal !== "string") return null;
  const match = timeVal.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;
  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const period = match[3]?.toLowerCase();

  if (period === "pm" && hours < 12) hours += 12;
  if (period === "am" && hours === 12) hours = 0;

  return hours * 60 + minutes;
}

/**
 * Evalúa si una fecha dada se encuentra dentro del rango horario laboral en la zona horaria especificada
 * @param {Date} date
 * @param {string|number} start
 * @param {string|number} end
 * @param {string} tz
 * @returns {boolean}
 */
export function isWithinWorkingHours(date = new Date(), start = "11:00", end = "23:00", tz = "America/Lima") {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "numeric",
      hour12: false
    });
    const parts = formatter.formatToParts(date);
    const hour = parseInt(parts.find(p => p.type === "hour")?.value || "0", 10);
    const minute = parseInt(parts.find(p => p.type === "minute")?.value || "0", 10);
    const currentMins = hour * 60 + minute;

    const startMins = parseTimeToMinutes(start) ?? (11 * 60);
    const endMins = parseTimeToMinutes(end) ?? (23 * 60);

    if (startMins <= endMins) {
      return currentMins >= startMins && currentMins < endMins;
    } else {
      // Para rangos que cruzan la medianoche (ej: 22:00 a 04:00)
      return currentMins >= startMins || currentMins < endMins;
    }
  } catch (err) {
    console.warn("[WorkingHours] Error evaluando horario:", err.message);
    return true; // En caso de fallo con la zona horaria, permitir para no bloquear
  }
}

/**
 * Gestor de Horarios Laborales
 * Mantiene el estado activo del horario laboral y evalúa si el daemon debe operar en tiempo real.
 */
export class WorkingHoursManager {
  constructor({ defaultStart = "11:00", defaultEnd = "23:00", defaultTz = "America/Lima" } = {}) {
    this.workStart = defaultStart;
    this.workEnd = defaultEnd;
    this.configuredTimeZone = defaultTz;
  }

  isWorkingNow() {
    return isWithinWorkingHours(new Date(), this.workStart, this.workEnd, this.configuredTimeZone);
  }

  updateWorkingHours(start, end, tz) {
    let changed = false;
    if (start && String(start) !== String(this.workStart)) {
      this.workStart = String(start);
      changed = true;
    }
    if (end && String(end) !== String(this.workEnd)) {
      this.workEnd = String(end);
      changed = true;
    }
    if (tz && tz !== this.configuredTimeZone) {
      this.configuredTimeZone = tz;
      changed = true;
    }
    if (changed) {
      console.log(`[WorkingHours] Horario actualizado: ${this.workStart} a ${this.workEnd} (${this.configuredTimeZone}). ¿Dentro de horario?: ${this.isWorkingNow() ? "SÍ" : "NO"}`);
    }
    return changed;
  }

  getState() {
    return {
      workStart: this.workStart,
      workEnd: this.workEnd,
      timezone: this.configuredTimeZone,
      isWithinWorkingHours: this.isWorkingNow()
    };
  }
}

