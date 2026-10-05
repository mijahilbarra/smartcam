/**
 * Logger de Infraestructura
 * Duplica console.log y console.error hacia archivos locales daemon.log y /tmp para diagnóstico SSH remoto.
 */

import fsSync from "fs";

let isInitialized = false;

export function initLogger(daemonLogPath, tmpLogPath = "/tmp/camera-catcher.log") {
  if (isInitialized) return;
  isInitialized = true;

  const origLog = console.log;
  const origErr = console.error;

  function appendToLog(prefix, args) {
    try {
      const text = args.map(a => (typeof a === "object" ? JSON.stringify(a) : a)).join(" ");
      const logLine = `[${new Date().toISOString()}] ${prefix} ${text}\n`;
      if (daemonLogPath) {
        try { fsSync.appendFileSync(daemonLogPath, logLine); } catch (_) {}
      }
      if (tmpLogPath) {
        try { fsSync.appendFileSync(tmpLogPath, logLine); } catch (_) {}
      }
    } catch (_) {}
  }

  console.log = (...args) => {
    origLog(...args);
    appendToLog("[INFO]", args);
  };

  console.error = (...args) => {
    origErr(...args);
    appendToLog("[ERROR]", args);
  };
}
