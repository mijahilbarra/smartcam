import assert from "assert";
import { CustomerService } from "../src/services/customer_service.js";
import { SQLiteClient } from "../src/infrastructure/storage/sqlite_client.js";

console.log("=== Test de CustomerService (Caché RAM + SQLite + Reflejo Firebase) ===");

// 1. Inicialización de CustomerService con SQLite en memoria
console.log("\n[1] Inicializando CustomerService con SQLite :memory:...");
const memoryDb = new SQLiteClient(":memory:");
const customerService = new CustomerService({ sqliteClient: memoryDb });

assert.strictEqual(customerService.isLoaded, false);
assert.strictEqual(customerService.getComparisonProfiles().length, 0);
assert.strictEqual(customerService.isLoaded, true);
console.log("-> CustomerService inicializado correctamente.");

// 2. Mock de Firestore
const firestoreStorage = new Map();
const mockFirestore = {
  collection: (name) => ({
    get: async () => {
      const docs = [];
      if (name === "camera_catcher_people") {
        for (const [id, data] of firestoreStorage.entries()) {
          if (id !== "staff") {
            docs.push({ id, data: () => data });
          }
        }
      }
      return docs;
    }
  }),
  doc: (path) => ({
    get: async () => {
      const id = path.replace("camera_catcher_people/", "").replace("camera_catcher/", "");
      const data = firestoreStorage.get(id);
      return { exists: !!data, data: () => data };
    },
    set: async (val, opts) => {
      const id = path.replace("camera_catcher_people/", "");
      if (opts?.merge && firestoreStorage.has(id)) {
        firestoreStorage.set(id, { ...firestoreStorage.get(id), ...val });
      } else {
        firestoreStorage.set(id, val);
      }
    },
    delete: async () => {
      const id = path.replace("camera_catcher_people/", "");
      firestoreStorage.delete(id);
    }
  })
};

// 3. Sincronización desde Firestore en arranque si SQLite está vacío
console.log("\n[2] Probando loadProfilesIntoMemory con Firestore (carga inicial)...");
const dummyVector = new Array(512).fill(0).map((_, i) => (i === 0 ? 0.9 : 0.1));
firestoreStorage.set("staff", {
  members: [
    {
      id: "staff_alex",
      name: "Alex Barbero",
      role: "barber",
      isStaff: true,
      embedding: dummyVector,
      embeddings: [dummyVector]
    }
  ]
});
firestoreStorage.set("client_carlos", {
  id: "client_carlos",
  name: "Carlos Mendoza",
  isStaff: false,
  role: "client",
  visitCount: 2,
  bestFaceScore: 75.0,
  embedding: dummyVector,
  embeddings: [dummyVector],
  photos: [{ thumbnailBase64: "data:thumb_carlos", sharpnessScore: 75.0 }]
});

customerService.clearMemoryCache();
const loadedProfiles = await customerService.loadProfilesIntoMemory({ db: mockFirestore });

assert.strictEqual(loadedProfiles.length, 2, "Debe cargar staff y cliente Carlos");
assert.ok(customerService.hasProfile("staff_alex"), "Debe tener en caché a staff_alex");
assert.ok(customerService.hasProfile("client_carlos"), "Debe tener en caché a client_carlos");
console.log("-> loadProfilesIntoMemory pobló SQLite y RAM desde Firestore exitosamente.");

// 4. Latencia de getComparisonProfiles (<1ms en RAM)
console.log("\n[3] Verificando rendimiento ultra-rápido de getComparisonProfiles (<1ms)...");
const t0 = performance.now();
for (let i = 0; i < 1000; i++) {
  customerService.getComparisonProfiles();
}
const totalMs = performance.now() - t0;
const avgMs = totalMs / 1000;
console.log(`-> 1000 consultas de getComparisonProfiles tomaron ${totalMs.toFixed(2)} ms (promedio: ${avgMs.toFixed(4)} ms/llamada).`);
assert.ok(avgMs < 0.5, "getComparisonProfiles debe responder en menos de 0.5 ms por llamada");

// 5. Inserción de nuevo cliente (isNew: true -> guarda local y refleja a Firestore)
console.log("\n[4] Probando saveOrUpdateCustomer para nuevo cliente (isNew: true)...");
const newCustomer = {
  id: "client_diego",
  name: "Diego Castro",
  isStaff: false,
  role: "client",
  visitCount: 1,
  bestFaceScore: 82.5,
  embedding: dummyVector,
  embeddings: [dummyVector],
  photos: [{ thumbnailBase64: "data:thumb_diego", sharpnessScore: 82.5 }]
};

const saveResult = await customerService.saveOrUpdateCustomer(newCustomer, {
  db: mockFirestore,
  isNew: true
});

assert.strictEqual(saveResult.localSaved, true);
assert.strictEqual(saveResult.synced, true);
assert.ok(customerService.hasProfile("client_diego"), "Debe estar en RAM");
assert.ok(memoryDb.getCustomerById("client_diego"), "Debe estar en SQLite");
assert.ok(firestoreStorage.has("client_diego"), "Debe estar reflejado en Firestore");
console.log("-> Nuevo cliente persistido localmente y reflejado en Firestore.");

// 6. Actualización menor sin cambios significativos (no debe llamar a Firestore)
console.log("\n[5] Probando actualización menor sin banderas de sincronización...");
let firestoreWriteCount = 0;
const trackingDb = {
  ...mockFirestore,
  doc: (path) => ({
    ...mockFirestore.doc(path),
    set: async (val, opts) => {
      firestoreWriteCount++;
      return mockFirestore.doc(path).set(val, opts);
    }
  })
};

const minorUpdate = {
  id: "client_diego",
  lastSeen: new Date().toISOString()
};

const minorResult = await customerService.saveOrUpdateCustomer(minorUpdate, {
  db: trackingDb
  // Sin isNew, higherSharpness, newAngle ni forceSync
});

assert.strictEqual(minorResult.localSaved, true);
assert.strictEqual(minorResult.synced, false, "No debe sincronizar a Firestore para un tick menor");
assert.strictEqual(firestoreWriteCount, 0, "No debe haber realizado llamadas de escritura a Firestore");
console.log("-> Actualización rutinaria guardada localmente sin consumo de cuota Firestore.");

// 7. Actualización con mayor nitidez (higherSharpness: true -> refleja a Firestore)
console.log("\n[6] Probando actualización con mayor nitidez (higherSharpness: true)...");
const sharpUpdate = {
  id: "client_diego",
  bestFaceScore: 95.0,
  thumbnailBase64: "data:thumb_diego_sharp"
};

const sharpResult = await customerService.saveOrUpdateCustomer(sharpUpdate, {
  db: trackingDb,
  higherSharpness: true
});

assert.strictEqual(sharpResult.localSaved, true);
assert.strictEqual(sharpResult.synced, true, "Debe sincronizar al detectar mayor nitidez");
assert.strictEqual(firestoreWriteCount, 1, "Debe haber llamado a Firestore exactamente 1 vez");
assert.strictEqual(firestoreStorage.get("client_diego").bestFaceScore, 95.0);
console.log("-> Reflejo en Firestore activado selectivamente por mayor nitidez.");

// 8. Eliminación de cliente
console.log("\n[7] Probando deleteCustomer...");
await customerService.deleteCustomer("client_diego", { db: mockFirestore });
assert.strictEqual(customerService.hasProfile("client_diego"), false, "Eliminado de RAM");
assert.strictEqual(memoryDb.getCustomerById("client_diego"), null, "Eliminado de SQLite");
assert.strictEqual(firestoreStorage.has("client_diego"), false, "Eliminado de Firestore");
console.log("-> Cliente eliminado correctamente de RAM, SQLite y Firestore.");

// 9. Reset de CustomerService
console.log("\n[8] Probando reset...");
customerService.reset();
assert.strictEqual(customerService.isLoaded, false);
assert.strictEqual(customerService.profilesCache.size, 0);
assert.strictEqual(memoryDb.getAllComparisonProfiles().length, 0);
console.log("-> reset limpió RAM y SQLite por completo.");

// 10. Configuración dinámica de entorno con initForDatabase
console.log("\n[9] Probando cambio y configuración dinámica con initForDatabase...");
const dynamicService = new CustomerService();

// Inicializar explícitamente para "test" en memoria
const testClient = dynamicService.initForDatabase("test", { dbPath: ":memory:" });
assert.strictEqual(dynamicService.databaseId, "test");
assert.strictEqual(dynamicService.sqliteClient, testClient);
assert.strictEqual(dynamicService.profilesCache.size, 0);

// Guardar cliente en base de datos "test"
await dynamicService.saveOrUpdateCustomer({
  id: "test_user_1",
  name: "Usuario de Pruebas",
  isStaff: false
});
assert.strictEqual(dynamicService.hasProfile("test_user_1"), true);
assert.ok(testClient.getCustomerById("test_user_1"));

// Cambiar a entorno "(default)" en memoria
const defaultClient = dynamicService.initForDatabase("(default)", { dbPath: ":memory:" });
assert.strictEqual(dynamicService.databaseId, "(default)");
assert.strictEqual(dynamicService.sqliteClient, defaultClient);
assert.strictEqual(dynamicService.profilesCache.size, 0, "Al cambiar de entorno debe limpiar la caché en RAM");
assert.strictEqual(defaultClient.getCustomerById("test_user_1"), null, "La base de datos (default) debe estar separada de test");

testClient.close();
defaultClient.close();
console.log("-> initForDatabase y separación de entornos SQLite validados exitosamente.");

memoryDb.close();
console.log("\n🎉 ¡Todos los tests de CustomerService pasaron exitosamente!");
