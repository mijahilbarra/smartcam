import assert from "assert";
import {
  SQLiteClient,
  vectorToBlob,
  blobToVector,
  getResolvedSqlitePath,
  getSqliteClient,
  resetSqliteClients
} from "../src/infrastructure/storage/sqlite_client.js";

console.log("=== Test de SQLite Client para Almacenamiento Biométrico Local ===");

// 1. Test de serialización binaria Float32Array <-> Buffer BLOB
console.log("\n[1] Probando serialización y deserialización de vectores (vectorToBlob / blobToVector)...");
const sampleVector = [0.123456, -0.654321, 0.987654, 0.0, 1.0];
const blob = vectorToBlob(sampleVector);
assert.ok(Buffer.isBuffer(blob), "Debe generar un Buffer de Node.js");
assert.strictEqual(blob.length, sampleVector.length * 4, "Debe medir 4 bytes por float (Float32)");

const deserialized = blobToVector(blob);
assert.strictEqual(deserialized.length, sampleVector.length);
for (let i = 0; i < sampleVector.length; i++) {
  assert.ok(Math.abs(deserialized[i] - sampleVector[i]) < 1e-5, `Valor en índice ${i} debe coincidir con precisión de 32 bits`);
}
console.log("-> Conversión binaria de vectores validada exitosamente.");

// 2. Inicialización de SQLiteClient en memoria
console.log("\n[2] Inicializando SQLiteClient en memoria (:memory:)...");
const client = new SQLiteClient(":memory:");
assert.ok(client.db, "Instancia de SQLite debe estar inicializada");
console.log("-> Base de datos SQLite en memoria inicializada en modo WAL y foreign keys activas.");

// 3. Inserción de cliente con upsertCustomer
console.log("\n[3] Probando upsertCustomer y getCustomerById...");
const dummyVector1 = new Array(512).fill(0).map((_, i) => (i === 0 ? 1 : 0));
const dummyVector2 = new Array(512).fill(0).map((_, i) => (i === 1 ? 1 : 0));

const newCustomer = {
  id: "client_test_01",
  name: "Roberto Martínez",
  isStaff: false,
  role: "client",
  firstSeen: "2026-10-01T10:00:00.000Z",
  lastSeen: "2026-10-01T10:30:00.000Z",
  visitCount: 1,
  bestFaceScore: 78.5,
  thumbnailBase64: "data:image/jpeg;base64,thumb_roberto",
  thumbnailPath: "camera_catcher/faces/roberto.jpg",
  photos: [
    { thumbnailBase64: "data:image/jpeg;base64,thumb_roberto", sharpnessScore: 78.5, capturedAt: "2026-10-01T10:00:00.000Z" }
  ],
  embeddings: [dummyVector1, dummyVector2]
};

client.upsertCustomer(newCustomer);

const retrieved = client.getCustomerById("client_test_01");
assert.ok(retrieved, "Debe recuperar el cliente recién insertado");
assert.strictEqual(retrieved.id, "client_test_01");
assert.strictEqual(retrieved.name, "Roberto Martínez");
assert.strictEqual(retrieved.isStaff, false);
assert.strictEqual(retrieved.visitCount, 1);
assert.strictEqual(retrieved.bestFaceScore, 78.5);
assert.strictEqual(retrieved.photos.length, 1);
assert.strictEqual(retrieved.embeddings.length, 2, "Debe haber persistido los 2 embeddings en customer_embeddings");
assert.strictEqual(retrieved.embeddings[0][0], 1, "Vector 1 index 0 debe ser 1");
assert.strictEqual(retrieved.embeddings[1][1], 1, "Vector 2 index 1 debe ser 1");
console.log("-> Inserción y consulta por ID validadas con fotos y embeddings.");

// 4. Actualización con mayor nitidez y visitas acumuladas
console.log("\n[4] Probando actualización (upsert) con mayor nitidez y nueva visita...");
const updatedCustomer = {
  id: "client_test_01",
  visitCount: 2,
  bestFaceScore: 92.0,
  lastSeen: "2026-10-07T14:00:00.000Z"
};

client.upsertCustomer(updatedCustomer);
const retrievedAfterUpdate = client.getCustomerById("client_test_01");
assert.strictEqual(retrievedAfterUpdate.visitCount, 2, "visitCount debe actualizarse a 2");
assert.strictEqual(retrievedAfterUpdate.bestFaceScore, 92.0, "bestFaceScore debe subir a 92.0");
assert.strictEqual(retrievedAfterUpdate.name, "Roberto Martínez", "Debe conservar los campos no sobreescritos (COALESCE)");
console.log("-> Actualización acumulativa validada exitosamente.");

// 5. Inserción individual de embedding vía saveEmbedding
console.log("\n[5] Probando inserción individual con saveEmbedding...");
const dummyVector3 = new Array(512).fill(0).map((_, i) => (i === 2 ? 1 : 0));
client.saveEmbedding("client_test_01", 2, dummyVector3, 85);

const retrievedWith3 = client.getCustomerById("client_test_01");
assert.strictEqual(retrievedWith3.embeddings.length, 3, "Debe contener 3 embeddings tras saveEmbedding");
console.log("-> Inserción individual de embedding validada exitosamente.");

// 6. getAllComparisonProfiles para identifyFace (<1ms)
console.log("\n[6] Probando getAllComparisonProfiles...");
const t0 = Date.now();
const profiles = client.getAllComparisonProfiles();
const elapsed = Date.now() - t0;

assert.strictEqual(profiles.length, 1);
assert.strictEqual(profiles[0].id, "client_test_01");
assert.strictEqual(profiles[0].embeddings.length, 3);
assert.ok(elapsed < 10, `Debe ejecutarse en tiempo despreciable (tardó ${elapsed} ms)`);
console.log(`-> getAllComparisonProfiles entregó ${profiles.length} perfil(es) en ${elapsed} ms.`);

// 7. Eliminación en cascada con deleteCustomer
console.log("\n[7] Probando eliminación en cascada con deleteCustomer...");
const deleted = client.deleteCustomer("client_test_01");
assert.strictEqual(deleted, true);
assert.strictEqual(client.getCustomerById("client_test_01"), null);

// Verificar que también se eliminaron los embeddings
const remainingEmbeddings = client.db.prepare("SELECT * FROM customer_embeddings WHERE customer_id = ?").all("client_test_01");
assert.strictEqual(remainingEmbeddings.length, 0, "Las claves foráneas ON DELETE CASCADE deben eliminar los embeddings asociados");
console.log("-> Eliminación en cascada validada exitosamente.");

client.close();

// 8. Test de Atenciones (Appointments)
console.log("\n[8] Probando gestión de Atenciones (Appointments) en SQLiteClient...");
const appClient = new SQLiteClient(":memory:");
const sampleCustomer = {
  id: "cust_app_01",
  name: "Carlos Mendoza",
  isStaff: false,
  firstSeen: "2026-10-08T10:00:00.000Z",
  lastSeen: "2026-10-08T10:45:00.000Z",
  visitCount: 1
};
appClient.upsertCustomer(sampleCustomer);

const sampleAppointment = {
  id: "appt_01",
  chairId: "silla_corte_1",
  chairName: "Silla de Corte 1",
  clientId: "cust_app_01",
  clientName: "Carlos Mendoza",
  startedAt: "2026-10-08T10:00:00.000Z",
  endedAt: "2026-10-08T10:45:00.000Z",
  durationMinutes: 45,
  status: "completed",
  bestFaceScore: 85.4,
  photos: [{ url: "photo1.jpg" }]
};

appClient.saveAppointment(sampleAppointment);

const retrievedAppt = appClient.getAppointmentById("appt_01");
assert.ok(retrievedAppt, "Debe recuperar la atención guardada");
assert.strictEqual(retrievedAppt.id, "appt_01");
assert.strictEqual(retrievedAppt.clientId, "cust_app_01");
assert.strictEqual(retrievedAppt.durationMinutes, 45);
assert.strictEqual(retrievedAppt.photos.length, 1);

const listByClient = appClient.getAppointmentsByClient("cust_app_01");
assert.strictEqual(listByClient.length, 1);

const allApps = appClient.getAppointments({ status: "completed" });
assert.strictEqual(allApps.length, 1);

const deletedAppt = appClient.deleteAppointment("appt_01");
assert.strictEqual(deletedAppt, true);
assert.strictEqual(appClient.getAppointmentById("appt_01"), null);
appClient.close();
console.log("-> Gestión de Atenciones (Appointments) validada exitosamente.");

// 9. Paridad de entornos de base de datos SQLite con Firestore ('(default)' y 'test')
console.log("\n[8] Probando paridad de entornos de base de datos SQLite (getResolvedSqlitePath / getSqliteClient)...");

// 8.1 Resolución de rutas
const pathDefault = getResolvedSqlitePath("(default)");
assert.ok(pathDefault.endsWith("data/barberia.db") || pathDefault.endsWith("data\\barberia.db"), "Debe resolver a data/barberia.db para (default)");

const pathTest = getResolvedSqlitePath("test");
assert.ok(pathTest.endsWith("data/barberia_test.db") || pathTest.endsWith("data\\barberia_test.db"), "Debe resolver a data/barberia_test.db para test");

const pathCustom = getResolvedSqlitePath("sucursal_sur");
assert.ok(pathCustom.endsWith("data/barberia_sucursal_sur.db") || pathCustom.endsWith("data\\barberia_sucursal_sur.db"), "Debe resolver a data/barberia_sucursal_sur.db");

const pathMemory = getResolvedSqlitePath(":memory:");
assert.strictEqual(pathMemory, ":memory:", "Debe respetar :memory:");

const pathExplicit = getResolvedSqlitePath("test", { dbPath: "/tmp/custom_test.db" });
assert.strictEqual(pathExplicit, "/tmp/custom_test.db", "Debe respetar options.dbPath");

// 8.2 Singleton y caché por databaseId
const clientDef1 = getSqliteClient("(default)", { dbPath: ":memory:", cacheKey: "default_test" });
const clientDef2 = getSqliteClient("(default)", { dbPath: ":memory:", cacheKey: "default_test" });
assert.strictEqual(clientDef1, clientDef2, "Debe devolver la misma instancia en caché");

const clientTest1 = getSqliteClient("test", { dbPath: ":memory:", cacheKey: "test_isolated" });
assert.notStrictEqual(clientDef1, clientTest1, "Instancias para distintos entornos deben ser independientes");

// 8.3 Resolución automática por entorno activo
const resolvedAutoPath = getResolvedSqlitePath();
assert.ok(resolvedAutoPath.endsWith("barberia_test.db"), "En entorno de test local debe resolver por defecto a barberia_test.db");

resetSqliteClients();
console.log("-> Paridad de entornos y resolución de SQLite validada exitosamente.");

console.log("\n🎉 ¡Todos los tests de SQLiteClient pasaron exitosamente!");
