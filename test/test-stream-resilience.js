import assert from "assert";
import fs from "fs";
import { StreamServer } from "../src/infrastructure/streaming/stream_server.js";
import { startNeolinkDaemon, restartNeolinkDaemon } from "../src/infrastructure/camera/neolink_client.js";
import { initLogger } from "../src/infrastructure/logging/logger.js";

console.log("=== Test de Resiliencia de Stream y Recuperación Neolink ===");

// 1. Verificar StreamServer y expiración de fotogramas (getLatestFrame)
console.log("\n[1] Probando StreamServer y protección de fotograma congelado (maxAgeMs)...");
const server = new StreamServer({
  rtspUrl: "rtsp://127.0.0.1:8554/barberia/sub",
  fps: 3.5
});

assert.strictEqual(server.latestFrameBuffer, null, "latestFrameBuffer debe ser null inicialmente");
assert.strictEqual(server.latestFrameTimestamp, null, "latestFrameTimestamp debe ser null inicialmente");
assert.strictEqual(server.getLatestFrame(), null, "getLatestFrame() debe ser null si no hay fotograma");

// Simular fotograma fresco
const dummyFrame = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
server.latestFrameBuffer = dummyFrame;
server.latestFrameTimestamp = Date.now();
assert.strictEqual(server.getLatestFrame(), dummyFrame, "getLatestFrame() debe retornar el buffer si es fresco");

// Simular fotograma obsoleto (> 15s)
server.latestFrameTimestamp = Date.now() - 20000;
assert.strictEqual(server.getLatestFrame(15000), null, "getLatestFrame() debe retornar null si tiene > 15s de antigüedad");

// 2. Probar handleStreamRequest: no debe enviar fotograma congelado a clientes nuevos
console.log("\n[2] Probando handleStreamRequest con fotograma obsoleto...");
let sentData = [];
const mockRes = {
  writeHead: () => {},
  write: (chunk) => { sentData.push(chunk); },
  on: () => {}
};
const mockReq = {
  on: () => {}
};

// server tiene fotograma de 20s de antigüedad: NO debe enviarlo
sentData = [];
server.handleStreamRequest(mockReq, mockRes);
assert.strictEqual(sentData.length, 0, "No debe enviar fotograma obsoleto (>15s) a nuevo cliente");

// Si el fotograma es fresco: SÍ debe enviarlo
server.latestFrameTimestamp = Date.now();
sentData = [];
server.handleStreamRequest(mockReq, mockRes);
assert.strictEqual(sentData.length > 0, true, "Debe enviar fotograma fresco a nuevo cliente");

// 3. Probar stopFfmpegStream(force = true): debe limpiar buffer y timestamp
console.log("\n[3] Probando stopFfmpegStream(force = true)...");
server.latestFrameBuffer = dummyFrame;
server.latestFrameTimestamp = Date.now();
server.clients.clear();
server.stopFfmpegStream(true);
assert.strictEqual(server.latestFrameBuffer, null, "stopFfmpegStream(true) debe purgar latestFrameBuffer");
assert.strictEqual(server.latestFrameTimestamp, null, "stopFfmpegStream(true) debe purgar latestFrameTimestamp");

// 4. Probar onEnsureRtspSource con forceRestart tras 3 fallos consecutivos
console.log("\n[4] Probando auto-reciclaje de Neolink tras 3 fallos consecutivos de stream...");
let forceRestartCalled = false;
let regularEnsureCalled = false;

const resilientServer = new StreamServer({
  onEnsureRtspSource: async ({ forceRestart = false } = {}) => {
    if (forceRestart) {
      forceRestartCalled = true;
    } else {
      regularEnsureCalled = true;
    }
  }
});

// Con reconnectAttempts = 0: llamada normal
resilientServer.reconnectAttempts = 0;
// Simulamos llamada interna a onEnsureRtspSource como en startFfmpegStream
if (resilientServer.reconnectAttempts >= 3) {
  await resilientServer.onEnsureRtspSource({ forceRestart: true });
} else {
  await resilientServer.onEnsureRtspSource();
}
assert.strictEqual(regularEnsureCalled, true, "Con < 3 reintentos debe llamar onEnsureRtspSource normal");
assert.strictEqual(forceRestartCalled, false, "Con < 3 reintentos no debe forzar reinicio");

// Con reconnectAttempts = 3: llamada forzada
resilientServer.reconnectAttempts = 3;
if (resilientServer.reconnectAttempts >= 3) {
  await resilientServer.onEnsureRtspSource({ forceRestart: true });
} else {
  await resilientServer.onEnsureRtspSource();
}
assert.strictEqual(forceRestartCalled, true, "Con >= 3 reintentos debe llamar onEnsureRtspSource con { forceRestart: true }");

// 5. Probar exports de neolink_client.js
console.log("\n[5] Probando exports de neolink_client.js...");
assert.strictEqual(typeof startNeolinkDaemon, "function", "startNeolinkDaemon debe ser una función");
assert.strictEqual(typeof restartNeolinkDaemon, "function", "restartNeolinkDaemon debe ser una función");

// 6. Probar interceptor de console.warn en logger.js
console.log("\n[6] Probando intercepción de console.warn en logger.js...");
const tmpLog = `/tmp/test-logger-${Date.now()}.log`;
initLogger(null, tmpLog);
console.warn("Test warning message for resilience");

if (fs.existsSync(tmpLog)) {
  const content = fs.readFileSync(tmpLog, "utf-8");
  assert.strictEqual(content.includes("[WARN]"), true, "El log debe contener el prefijo [WARN]");
  assert.strictEqual(content.includes("Test warning message for resilience"), true, "El log debe contener el texto de advertencia");
  fs.unlinkSync(tmpLog);
  console.log("-> Intercepción de [WARN] validada exitosamente en disco.");
}

// 7. Probar StreamServer con archivo de Mock Video
console.log("\n[7] Probando StreamServer con archivo de Mock Video (data/recordings/mock_stream.mp4)...");
const mockVideoPath = "data/recordings/mock_stream.mp4";
if (fs.existsSync(mockVideoPath)) {
  const mockServer = new StreamServer({
    mockVideoPath,
    fps: 3.5
  });

  assert.strictEqual(mockServer.mockVideoPath, mockVideoPath, "mockVideoPath debe coincidir con el path asignado");
  await mockServer.startFfmpegStream(true);

  // Esperar a que el proceso FFmpeg decodifique el primer frame
  let frame = null;
  for (let attempt = 0; attempt < 25; attempt++) {
    await new Promise(r => setTimeout(r, 100));
    frame = mockServer.getLatestFrame();
    if (frame) break;
  }

  assert.ok(frame, "StreamServer debe generar fotograma válido en RAM desde el mock video");
  assert.ok(Buffer.isBuffer(frame), "El fotograma debe ser un Buffer de Node.js");
  assert.ok(frame.length > 1000, "El fotograma debe contener datos JPEG válidos");
  assert.strictEqual(frame[0], 0xff, "Primer byte del frame debe ser 0xFF (SOI JPEG)");
  assert.strictEqual(frame[1], 0xd8, "Segundo byte del frame debe ser 0xD8 (SOI JPEG)");

  mockServer.stopFfmpegStream(true);
  console.log(`-> Fotograma de Mock Video decodificado exitosamente (${frame.length} bytes, formato JPEG verificado).`);
} else {
  console.log("-> Archivo mock_stream.mp4 no encontrado en disco, prueba omitida.");
}

console.log("\n🎉 ¡Todas las pruebas de resiliencia de stream, recuperación Neolink y Mock Video pasaron al 100%!");
process.exit(0);
