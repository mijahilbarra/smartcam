import { spawn } from "node:child_process";

console.log("\x1b[36m%s\x1b[0m", "🚀 Iniciando Entorno de Desarrollo Local Completo (Daemon + Frontend Web)...");

// 1. Iniciar Daemon Backend (Express en 8085 + Firestore test)
const server = spawn("node", ["src/index.js"], {
  stdio: "inherit",
  env: {
    ...process.env,
    FIRESTORE_DATABASE_ID: "test",
    STORAGE_BUCKET: "skip-bigotes-test",
    IS_LOCAL_SIMULATOR: "true"
  }
});

// 2. Iniciar Frontend Vite (puerto 5173)
const vite = spawn("npx", ["vite"], {
  stdio: "inherit",
  env: process.env
});

function cleanup() {
  console.log("\n\x1b[33m%s\x1b[0m", "🛑 Deteniendo Daemon y Vite...");
  server.kill("SIGINT");
  vite.kill("SIGINT");
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

server.on("exit", (code) => {
  if (code && code !== 0) {
    console.error(`\x1b[31m[Daemon] Finalizó con código de error ${code}\x1b[0m`);
  }
});

vite.on("exit", (code) => {
  if (code && code !== 0) {
    console.error(`\x1b[31m[Vite] Finalizó con código de error ${code}\x1b[0m`);
  }
});
