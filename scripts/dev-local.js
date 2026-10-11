import { spawn } from "node:child_process";

console.log("\x1b[36m%s\x1b[0m", "🚀 Iniciando Entorno de Desarrollo Local Directo: Daemon Node.js + Frontend Vite...");

const daemon = spawn("node", ["--optimize-for-size", "--max-old-space-size=192", "src/index.js"], {
  stdio: "inherit",
  env: process.env
});

const vite = spawn("npx", ["vite"], {
  stdio: "inherit"
});

let isCleaningUp = false;
function cleanup() {
  if (isCleaningUp) return;
  isCleaningUp = true;
  console.log("\n\x1b[33m%s\x1b[0m", "🛑 Deteniendo Frontend Vite y Daemon Node.js...");
  vite.kill("SIGINT");
  daemon.kill("SIGINT");
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

daemon.on("exit", (code) => {
  if (code && code !== 0 && !isCleaningUp) {
    console.warn("\x1b[33m%s\x1b[0m", `[Daemon] Finalizó con código ${code}`);
  }
});

vite.on("exit", (code) => {
  if (code && code !== 0 && !isCleaningUp) {
    console.error(`\x1b[31m[Vite] Finalizó con código ${code}\x1b[0m`);
  }
});
