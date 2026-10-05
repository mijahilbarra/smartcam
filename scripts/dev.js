import { spawn } from "node:child_process";

console.log("\x1b[36m%s\x1b[0m", "🚀 Iniciando Entorno de Desarrollo Unificado: Simulador Docker E2 (1GB RAM) + Frontend Vite...");

// 1. Iniciar el simulador Docker E2 (daemon con límites de GCP e2-micro, puerto 8085)
const sim = spawn("docker", ["compose", "-f", "docker-compose.e2-sim.yml", "up", "--build"], {
  stdio: "inherit"
});

// 2. Iniciar el frontend Vite (puerto 5173)
const vite = spawn("npx", ["vite"], {
  stdio: "inherit"
});

let isCleaningUp = false;
function cleanup() {
  if (isCleaningUp) return;
  isCleaningUp = true;
  console.log("\n\x1b[33m%s\x1b[0m", "🛑 Deteniendo Frontend Vite y Simulador Docker E2...");
  vite.kill("SIGINT");
  sim.kill("SIGINT");

  const down = spawn("docker", ["compose", "-f", "docker-compose.e2-sim.yml", "down"], {
    stdio: "ignore"
  });
  down.on("exit", () => {
    process.exit(0);
  });
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

sim.on("error", (err) => {
  console.error("\x1b[31m%s\x1b[0m", `[Simulador E2 Error] No se pudo iniciar Docker: ${err.message}. Asegúrate de tener Docker Desktop abierto.`);
});

sim.on("exit", (code) => {
  if (code && code !== 0 && !isCleaningUp) {
    console.warn("\x1b[33m%s\x1b[0m", `[Simulador E2] Salió con código ${code}. (Verifica que Docker Desktop esté encendido).`);
  }
});

vite.on("exit", (code) => {
  if (code && code !== 0 && !isCleaningUp) {
    console.error(`\x1b[31m[Vite] Finalizó con código ${code}\x1b[0m`);
  }
});
