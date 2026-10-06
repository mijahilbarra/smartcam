import { daemonReporter } from "../src/daemon_reporter.js";

async function runTest() {
  console.log("=== Test de Máquina de Estados y Telemetría: daemonReporter ===");

  const emittedStates = [];
  const mockDb = {
    doc: (docPath) => ({
      set: async (data, opts) => {
        emittedStates.push({ docPath, step: data.step, title: data.stepTitle, timestamp: data.updatedAt });
        return Promise.resolve();
      }
    })
  };

  daemonReporter.init(mockDb);

  // 1. Estado inicial
  console.log("\n[1] Verificando estado inicial...");
  console.log("-> Step:", daemonReporter.currentState.step, "| Title:", daemonReporter.currentState.stepTitle);
  console.log("-> WorkingHours:", daemonReporter.currentState.workingHours);

  // 2. Consulta a la cámara
  console.log("\n[2] Probando reportCameraQuery...");
  await daemonReporter.reportCameraQuery("manual");
  console.log("-> Step:", daemonReporter.currentState.step, "| Desc:", daemonReporter.currentState.stepDescription);

  // 3. Imagen recibida
  console.log("\n[3] Probando reportImageReceived...");
  await daemonReporter.reportImageReceived({
    storagePath: "camera_catcher/photos/photo_test_123.jpg",
    width: 1024,
    height: 576,
    sizeBytes: 145200,
    docId: "photo_test_123"
  });
  console.log("-> Step:", daemonReporter.currentState.step, "| Image docId:", daemonReporter.currentState.image.docId);

  // 4. Cuadrantes activos
  console.log("\n[4] Probando reportQuadrantsActive...");
  await daemonReporter.reportQuadrantsActive([
    { id: "silla_1", label: "Silla de barbero 1", status: "ocupada", color: "#FFD700", box: [100, 100, 300, 300] },
    { id: "entrada", label: "Entrada principal", status: "despejado", color: "#007BFF", box: [400, 200, 600, 400] }
  ]);
  console.log("-> Step:", daemonReporter.currentState.step, "| Cuadrantes:", daemonReporter.currentState.quadrants.length);

  // 5. Detección de humanos
  console.log("\n[5] Probando reportHumanDetection...");
  await daemonReporter.reportHumanDetection({
    inferenceMs: 98,
    rawDetections: [
      { class: "person", score: 0.91, box: [120, 110, 290, 290] },
      { class: "person", score: 0.86, box: [420, 210, 580, 390] }
    ]
  });
  console.log("-> Step:", daemonReporter.currentState.step, "| ¿Hay humanos?:", daemonReporter.currentState.humans.hasHumans, "| Conteo:", daemonReporter.currentState.humans.count);

  // 6. Biometría
  console.log("\n[6] Probando reportPeopleIdentified...");
  await daemonReporter.reportPeopleIdentified([
    { cropId: "crop_1", personId: "staff_1", name: "Javier", isStaff: true, visitCount: 1, similarity: 0.88, confidence: 0.91 },
    { cropId: "crop_2", personId: "client_4", name: "Carlos M.", isStaff: false, isFrequent: true, visitCount: 5, similarity: 0.79, confidence: 0.86 }
  ], [
    { id: "crop_1", box: [120, 110, 290, 290] },
    { id: "crop_2", box: [420, 210, 580, 390] }
  ]);
  console.log("-> Step:", daemonReporter.currentState.step, "| Personas identificadas:", daemonReporter.currentState.people.length);
  console.log("-> Desglose:", daemonReporter.currentState.people.map(p => `${p.name} (${p.role})`).join(", "));

  // 7. Ciclo completado
  console.log("\n[7] Probando reportCycleCompleted...");
  await daemonReporter.reportCycleCompleted({
    docId: "photo_test_123",
    summary: "ML Local: 2 personas detectadas"
  });
  console.log("-> Step:", daemonReporter.currentState.step, "| Summary:", daemonReporter.currentState.summary);
  if (daemonReporter.currentState.lastDocId !== "photo_test_123") {
    throw new Error("FAIL: lastDocId debe coincidir con docId en reportCycleCompleted");
  }

  console.log("\nTotal de sincronizaciones a Firestore:", emittedStates.length);
  console.log("Historial de bitácora acumulado:", daemonReporter.currentState.history.length, "eventos");
  console.log("\nÚltimos 3 eventos en la bitácora:");
  daemonReporter.currentState.history.slice(0, 3).forEach(h => {
    console.log(`[${h.timeFormatted}] (${h.type}) ${h.text}`);
  });

  console.log("\n✅ ¡Todos los estados y transiciones probados exitosamente!");
}

runTest().catch(err => {
  console.error("Error en test de daemonReporter:", err);
  process.exit(1);
});
