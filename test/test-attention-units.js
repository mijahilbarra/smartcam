import assert from "node:assert";
import { SQLiteClient } from "../src/infrastructure/storage/sqlite_client.js";

console.log("=== Test de Unidades de Atención (Service Atoms) y Drag & Drop Ops ===");

// 1. Inicialización en memoria
console.log("\n[1] Inicializando SQLiteClient en memoria (:memory:)...");
const client = new SQLiteClient(":memory:");
assert.ok(client.db, "Instancia SQLite debe inicializarse");

// Crear cliente base
client.upsertCustomer({
  id: "client_carlos",
  name: "Carlos Méndez",
  isStaff: false,
  role: "client"
});

// 2. Creación y guardado de Unidades de Atención
console.log("\n[2] Probando saveAttentionUnit y getAttentionUnitById...");
const t0 = new Date("2026-10-24T16:00:00.000Z").getTime();
const t1 = new Date("2026-10-24T16:25:00.000Z").getTime();

const unit1 = {
  id: "unit_test_01",
  appointmentId: "appt_test_main",
  chairId: "silla_corte_1",
  chairName: "Silla de Corte 1",
  clientId: "client_carlos",
  clientName: "Carlos Méndez",
  startedAt: new Date(t0).toISOString(),
  endedAt: new Date(t1).toISOString(),
  startedEpoch: t0,
  endedEpoch: t1,
  durationMinutes: 25,
  durationSeconds: 1500,
  status: "completed",
  bestFaceScore: 82.5,
  thumbnailPath: "camera_catcher/faces/carlos1.jpg",
  photos: [
    { thumbnailBase64: "data:image/jpeg;base64,thumb1", sharpnessScore: 82.5, capturedAt: new Date(t0).toISOString() }
  ],
  embeddingsCount: 1
};

client.saveAttentionUnit(unit1);
const retrievedUnit1 = client.getAttentionUnitById("unit_test_01");
assert.ok(retrievedUnit1, "Debe recuperar la unidad creada");
assert.strictEqual(retrievedUnit1.id, "unit_test_01");
assert.strictEqual(retrievedUnit1.appointmentId, "appt_test_main");
assert.strictEqual(retrievedUnit1.durationMinutes, 25);
assert.strictEqual(retrievedUnit1.photos.length, 1);
assert.strictEqual(retrievedUnit1.bestFaceScore, 82.5);
console.log("  ✓ Unidad de atención persistida y consultada por ID correctamente");

// 3. Crear segunda unidad para la misma cita (Caso de Cita Compuesta / Quimera)
console.log("\n[3] Creando segunda unidad y cita contenedora con 2 unidades...");
const t2 = new Date("2026-10-24T16:30:00.000Z").getTime();
const t3 = new Date("2026-10-24T16:45:00.000Z").getTime();

const unit2 = {
  id: "unit_test_02",
  appointmentId: "appt_test_main",
  chairId: "silla_corte_1",
  chairName: "Silla de Corte 1",
  clientId: "client_carlos",
  clientName: "Carlos Méndez",
  startedAt: new Date(t2).toISOString(),
  endedAt: new Date(t3).toISOString(),
  startedEpoch: t2,
  endedEpoch: t3,
  durationMinutes: 15,
  durationSeconds: 900,
  status: "completed",
  bestFaceScore: 91.0,
  thumbnailPath: "camera_catcher/faces/carlos2.jpg",
  photos: [
    { thumbnailBase64: "data:image/jpeg;base64,thumb2", sharpnessScore: 91.0, capturedAt: new Date(t2).toISOString() }
  ],
  embeddingsCount: 1
};
client.saveAttentionUnit(unit2);

// Crear cita que agrupa a ambas unidades
const mainAppt = {
  id: "appt_test_main",
  chairId: "silla_corte_1",
  chairName: "Silla de Corte 1",
  clientId: "client_carlos",
  clientName: "Carlos Méndez",
  startedAt: unit1.startedAt,
  endedAt: unit2.endedAt,
  startedEpoch: t0,
  endedEpoch: t3,
  durationMinutes: 40,
  status: "completed",
  bestFaceScore: 91.0,
  thumbnailPath: unit2.thumbnailPath,
  photos: [...unit1.photos, ...unit2.photos],
  unitsCount: 2
};
client.saveAppointment(mainAppt);

const unitsForMain = client.getAttentionUnitsByAppointmentId("appt_test_main");
assert.strictEqual(unitsForMain.length, 2, "Debe tener 2 unidades asociadas a appt_test_main");
console.log("  ✓ Cita contenedora con 2 unidades validada");

// 4. Prueba de Separación de Unidad (Split)
console.log("\n[4] Probando splitAttentionUnit (Separación de Quimera / Unidad Absorbida)...");
const splitResult = client.splitAttentionUnit("unit_test_02");
assert.ok(splitResult.newAppointment, "Debe generar una nueva cita para la unidad extraída");
assert.ok(splitResult.oldAppointment, "Debe retornar la cita origen actualizada");
assert.strictEqual(splitResult.oldAppointment.unitsCount, 1, "Cita origen ahora debe tener unitsCount: 1");
assert.strictEqual(splitResult.newAppointment.unitsCount, 1, "Cita nueva debe tener unitsCount: 1");
assert.strictEqual(splitResult.oldAppointment.durationMinutes, 25, "Cita origen debe recalcular su duración a 25 min");
assert.strictEqual(splitResult.newAppointment.durationMinutes, 15, "Cita nueva debe tener duración de 15 min");

const newApptId = splitResult.newAppointment.id;
const unitsOld = client.getAttentionUnitsByAppointmentId("appt_test_main");
const unitsNew = client.getAttentionUnitsByAppointmentId(newApptId);
assert.strictEqual(unitsOld.length, 1);
assert.strictEqual(unitsOld[0].id, "unit_test_01");
assert.strictEqual(unitsNew.length, 1);
assert.strictEqual(unitsNew[0].id, "unit_test_02");
console.log("  ✓ Split atómico ejecutado: 1 cita de 40m separada en 2 citas independientes (25m y 15m)");

// 5. Intentar separar una cita con 1 sola unidad (No-op seguro)
console.log("\n[5] Probando splitAttentionUnit sobre cita de 1 sola unidad...");
const noopSplit = client.splitAttentionUnit("unit_test_01");
assert.strictEqual(noopSplit.alreadySingle, true, "Debe indicar que ya es unitaria");
assert.strictEqual(noopSplit.newAppointment, null);
console.log("  ✓ Protección de cita unitaria (alreadySingle) validada");

// 6. Prueba de Fusión de Unidad (Merge Unit / Drag & Drop)
console.log("\n[6] Probando mergeAttentionUnits (Arrastrar unidad a otra cita)...");
const mergeUnitResult = client.mergeAttentionUnits("unit_test_02", "appt_test_main");
assert.ok(mergeUnitResult.targetAppointment);
assert.strictEqual(mergeUnitResult.targetAppointment.unitsCount, 2, "La cita destino ahora debe tener 2 unidades");
assert.strictEqual(mergeUnitResult.targetAppointment.photos.length, 2, "Debe contener las 2 fotos");

// La cita extraída temporalmente quedó vacía y debió ser eliminada
const deletedAppt = client.getAppointmentById(newApptId);
assert.strictEqual(deletedAppt, null, "La cita origen huérfana debe haberse eliminado automáticamente");
console.log("  ✓ Fusión por unidad (Drag & Drop) ejecutada: unidad transferida y contenedor huérfano purgado");

// 7. Prueba de Fusión Completa de Citas (Merge Appointments)
console.log("\n[7] Probando mergeAppointments (Fusionar dos clientes separados erróneamente)...");
// Creamos una tercera cita con su unidad
const t4 = new Date("2026-10-24T17:00:00.000Z").getTime();
const t5 = new Date("2026-10-24T17:20:00.000Z").getTime();
const unit3 = {
  id: "unit_test_03",
  appointmentId: "appt_test_secondary",
  chairId: "silla_corte_1",
  chairName: "Silla de Corte 1",
  clientId: "client_carlos",
  clientName: "Carlos Méndez",
  startedAt: new Date(t4).toISOString(),
  endedAt: new Date(t5).toISOString(),
  startedEpoch: t4,
  endedEpoch: t5,
  durationMinutes: 20,
  durationSeconds: 1200,
  status: "completed",
  bestFaceScore: 88.0,
  photos: [{ thumbnailBase64: "thumb3", sharpnessScore: 88.0 }]
};
client.saveAttentionUnit(unit3);
client.saveAppointment({
  id: "appt_test_secondary",
  chairId: "silla_corte_1",
  startedAt: unit3.startedAt,
  endedAt: unit3.endedAt,
  startedEpoch: t4,
  endedEpoch: t5,
  durationMinutes: 20,
  photos: unit3.photos,
  unitsCount: 1
});

// Fusionamos appt_test_secondary en appt_test_main
const mergeApptsResult = client.mergeAppointments("appt_test_secondary", "appt_test_main");
assert.ok(mergeApptsResult.targetAppointment);
assert.strictEqual(mergeApptsResult.targetAppointment.unitsCount, 3, "Debe acumular las 3 unidades");
assert.strictEqual(client.getAppointmentById("appt_test_secondary"), null, "Cita secundaria eliminada");

const allMainUnits = client.getAttentionUnitsByAppointmentId("appt_test_main");
assert.strictEqual(allMainUnits.length, 3, "Las 3 unidades deben pertenecer ahora a appt_test_main");
console.log("  ✓ Fusión total de citas validada: 3 unidades consolidadas en una sola cita madre");

// 8. Filtros en getAttentionUnits
console.log("\n[8] Probando getAttentionUnits con filtros...");
const filteredUnits = client.getAttentionUnits({ chairId: "silla_corte_1" });
assert.strictEqual(filteredUnits.length, 3);
const filteredByAppt = client.getAttentionUnits({ appointmentId: "appt_test_main" });
assert.strictEqual(filteredByAppt.length, 3);
console.log("  ✓ Consultas filtradas de unidades de atención validadas");

console.log("\n🎉 ¡Todos los tests de Unidades de Atención y Drag & Drop pasaron al 100%!");
