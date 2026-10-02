import { runSingleCapture } from "./local_capture.js";

const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

console.log("==================================================");
console.log("🚀 IOT Camera Catcher - Servicio Automático Iniciado");
console.log(`⏱️  Frecuencia: Cada 15 minutos`);
console.log(`📅 Hora de inicio: ${new Date().toLocaleString("es-PE", { timeZone: "America/Lima" })}`);
console.log("==================================================\n");

async function executeLoop() {
  try {
    console.log(`[Cron] Iniciando ciclo de captura programada (${new Date().toLocaleTimeString("es-PE")})...`);
    await runSingleCapture();
    console.log(`[Cron] Ciclo completado. Próxima captura en 15 minutos.\n`);
  } catch (err) {
    console.error(`[Cron Error] Falló el ciclo: ${err.message}\nReintentará en el próximo ciclo en 15 minutos.\n`);
  }
}

// Iniciar primer ciclo de inmediato
executeLoop();

// Programar cada 15 minutos
setInterval(executeLoop, INTERVAL_MS);
