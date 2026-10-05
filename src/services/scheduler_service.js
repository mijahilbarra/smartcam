/**
 * Servicio Programador de Capturas (Cron Dinámico)
 * Administra los intervalos periódicos, la evaluación de horarios laborales y el reporte de cuenta regresiva.
 */

import { isWithinWorkingHours } from "../core/working_hours.js";
import { daemonReporter } from "../daemon_reporter.js";

export class SchedulerService {
  constructor({ onTick, defaultIntervalMinutes = 15, defaultStart = "11:00", defaultEnd = "23:00", defaultTz = "America/Lima" } = {}) {
    this.onTick = onTick;
    this.currentIntervalMinutes = defaultIntervalMinutes;
    this.workStart = defaultStart;
    this.workEnd = defaultEnd;
    this.configuredTimeZone = defaultTz;
    this.cronTimerId = null;
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
      console.log(`[Scheduler] Horario actualizado: ${this.workStart} a ${this.workEnd} (${this.configuredTimeZone}). ¿Dentro de horario?: ${this.isWorkingNow() ? "SÍ" : "NO"}`);
    }
    return changed;
  }

  setupTimer(minutes = this.currentIntervalMinutes) {
    if (this.cronTimerId) {
      clearInterval(this.cronTimerId);
      this.cronTimerId = null;
    }

    const num = Number(minutes);
    this.currentIntervalMinutes = (!isNaN(num) && num > 0) ? Math.max(0.1, num) : 15;
    const intervalMs = Math.round(this.currentIntervalMinutes * 60 * 1000);

    console.log(`[Scheduler] Programador configurado cada ${this.currentIntervalMinutes} min (${intervalMs / 1000} seg). Horario laboral: ${this.workStart} a ${this.workEnd} (${this.configuredTimeZone}).`);

    const nextCaptureDate = new Date(Date.now() + intervalMs);
    daemonReporter.setCountdown(nextCaptureDate, this.currentIntervalMinutes, {
      isWithinWorkingHours: this.isWorkingNow(),
      workStart: this.workStart,
      workEnd: this.workEnd,
      timezone: this.configuredTimeZone
    });

    this.cronTimerId = setInterval(async () => {
      if (!this.isWorkingNow()) {
        console.log(`[Scheduler] Fuera de horario laboral (${this.workStart} a ${this.workEnd} ${this.configuredTimeZone}). Omitiendo captura programada.`);
        const nextDate = new Date(Date.now() + intervalMs);
        daemonReporter.setCountdown(nextDate, this.currentIntervalMinutes, {
          isWithinWorkingHours: false,
          workStart: this.workStart,
          workEnd: this.workEnd,
          timezone: this.configuredTimeZone
        });
        return;
      }

      console.log(`[Scheduler] Ejecutando captura programada periódica (${this.currentIntervalMinutes} min)...`);
      if (typeof this.onTick === "function") {
        try {
          await this.onTick("scheduled");
        } catch (err) {
          console.error(`[Scheduler] Error en captura periódica:`, err.message);
        }
      }
    }, intervalMs);
  }

  stop() {
    if (this.cronTimerId) {
      clearInterval(this.cronTimerId);
      this.cronTimerId = null;
    }
  }

  getState() {
    return {
      currentIntervalMinutes: this.currentIntervalMinutes,
      workStart: this.workStart,
      workEnd: this.workEnd,
      timezone: this.configuredTimeZone,
      isWithinWorkingHours: this.isWorkingNow()
    };
  }
}
