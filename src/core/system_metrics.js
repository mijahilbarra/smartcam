import os from "os";

/**
 * Retorna métricas de memoria del sistema y del proceso de Node.js a costo 0 de RAM (<0.001 ms CPU)
 */
export function getSystemMemoryMetrics() {
  const mem = process.memoryUsage();
  const totalMemBytes = os.totalmem();
  const freeMemBytes = os.freemem();
  const usedMemBytes = totalMemBytes - freeMemBytes;

  return {
    rssMB: Number((mem.rss / 1024 / 1024).toFixed(1)),
    heapUsedMB: Number((mem.heapUsed / 1024 / 1024).toFixed(1)),
    heapTotalMB: Number((mem.heapTotal / 1024 / 1024).toFixed(1)),
    externalMB: Number((mem.external / 1024 / 1024).toFixed(1)),
    osTotalMB: Math.round(totalMemBytes / 1024 / 1024),
    osFreeMB: Math.round(freeMemBytes / 1024 / 1024),
    osUsedMB: Math.round(usedMemBytes / 1024 / 1024),
    usagePercent: Number(((mem.rss / totalMemBytes) * 100).toFixed(1))
  };
}
