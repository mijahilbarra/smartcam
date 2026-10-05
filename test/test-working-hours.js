import assert from "assert";
import { parseTimeToMinutes, isWithinWorkingHours } from "../src/core/working_hours.js";
import { parseTimeToMinutes as parseFromIndex, isWithinWorkingHours as isWorkingFromIndex } from "../src/index.js";

console.log("=== Test de Horario Laboral y Conversión de Tiempos ===");

// 1. Test parseTimeToMinutes
assert.strictEqual(parseTimeToMinutes("11:00"), 11 * 60, "11:00 debe ser 660 min");
assert.strictEqual(parseTimeToMinutes("23:00"), 23 * 60, "23:00 debe ser 1380 min");
assert.strictEqual(parseTimeToMinutes("11:30"), 11 * 60 + 30, "11:30 debe ser 690 min");
assert.strictEqual(parseTimeToMinutes("11 am"), 11 * 60, "11 am debe ser 660 min");
assert.strictEqual(parseTimeToMinutes("11 pm"), 23 * 60, "11 pm debe ser 1380 min");
assert.strictEqual(parseTimeToMinutes(11), 11 * 60, "11 numérico debe ser 660 min");
assert.strictEqual(parseTimeToMinutes(23), 23 * 60, "23 numérico debe ser 1380 min");
console.log("✓ parseTimeToMinutes validado con éxito");

// 2. Test isWithinWorkingHours (11:00 a 23:00 America/Lima)
// 2026-10-02T15:59:00Z -> Lima (UTC-5) es 10:59:00 (Antes de las 11:00 AM)
const beforeOpen = new Date("2026-10-02T15:59:00Z");
assert.strictEqual(isWithinWorkingHours(beforeOpen, "11:00", "23:00", "America/Lima"), false, "10:59 AM debe estar fuera de horario");

// 2026-10-02T16:00:00Z -> Lima (UTC-5) es 11:00:00 (Apertura 11:00 AM)
const atOpen = new Date("2026-10-02T16:00:00Z");
assert.strictEqual(isWithinWorkingHours(atOpen, "11:00", "23:00", "America/Lima"), true, "11:00 AM debe estar dentro de horario");

// 2026-10-02T20:30:00Z -> Lima (UTC-5) es 15:30:00 (3:30 PM)
const midDay = new Date("2026-10-02T20:30:00Z");
assert.strictEqual(isWithinWorkingHours(midDay, "11:00", "23:00", "America/Lima"), true, "3:30 PM debe estar dentro de horario");

// 2026-10-03T03:59:00Z -> Lima (UTC-5) es 22:59:00 (10:59 PM)
const beforeClose = new Date("2026-10-03T03:59:00Z");
assert.strictEqual(isWithinWorkingHours(beforeClose, "11:00", "23:00", "America/Lima"), true, "10:59 PM debe estar dentro de horario");

// 2026-10-03T04:00:00Z -> Lima (UTC-5) es 23:00:00 (Cierre 11:00 PM)
const atClose = new Date("2026-10-03T04:00:00Z");
assert.strictEqual(isWithinWorkingHours(atClose, "11:00", "23:00", "America/Lima"), false, "11:00 PM debe estar fuera de horario");

// 2026-10-03T06:00:00Z -> Lima (UTC-5) es 01:00:00 (1:00 AM de madrugada)
const overnight = new Date("2026-10-03T06:00:00Z");
assert.strictEqual(isWithinWorkingHours(overnight, "11:00", "23:00", "America/Lima"), false, "1:00 AM debe estar fuera de horario");

console.log("✓ isWithinWorkingHours validado en zona horaria America/Lima (11:00 a 23:00)");
console.log("=== Todas las pruebas de horario pasaron correctamente ===");
process.exit(0);
