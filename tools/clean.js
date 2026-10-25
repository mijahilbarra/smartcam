#!/usr/bin/env node
/**
 * tools/clean.js
 *
 * Herramienta CLI para purgar y limpiar todos los artefactos residuales
 * y temporales generados por step2_causal_replay, simulaciones y tests locales:
 * - Reportes Markdown de Funnel (docs/REPORTE_FUNNEL_*.md)
 * - Activos visuales y hojas de contacto (docs/assets/simulacion_*)
 * - Reportes de auditoría en JSON (data/audit_reports/*)
 * - Recortes e imágenes temporales de tests (test/*-output.jpg, test/*-crop.jpg)
 * - Opcional (--db o --all): Purgar tablas experimentales y VACUUM en data/experiments.db
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const cleanDb = args.includes("--db") || args.includes("--all");
const isQuiet = args.includes("--quiet");

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

function safeGetFileSize(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

function cleanFilesByPattern(dirPath, predicate, label) {
  if (!fs.existsSync(dirPath)) return { count: 0, bytes: 0 };
  let count = 0;
  let bytes = 0;

  const entries = fs.readdirSync(dirPath);
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isFile() && predicate(entry)) {
        count++;
        bytes += stat.size;
        if (!isDryRun) {
          fs.unlinkSync(fullPath);
        }
      }
    } catch (_) {}
  }

  if (!isQuiet && count > 0) {
    console.log(`  ✓ ${label}: ${count} archivo(s) (${formatBytes(bytes)})${isDryRun ? " [DRY-RUN]" : ""}`);
  }
  return { count, bytes };
}

function cleanDirectoryContents(dirPath, label) {
  if (!fs.existsSync(dirPath)) return { count: 0, bytes: 0 };
  let count = 0;
  let bytes = 0;

  function walk(current) {
    const entries = fs.readdirSync(current);
    for (const entry of entries) {
      const fullPath = path.join(current, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
          if (!isDryRun) {
            try { fs.rmdirSync(fullPath); } catch (_) {}
          }
        } else {
          count++;
          bytes += stat.size;
          if (!isDryRun) {
            fs.unlinkSync(fullPath);
          }
        }
      } catch (_) {}
    }
  }

  walk(dirPath);
  if (!isQuiet && count > 0) {
    console.log(`  ✓ ${label}: ${count} archivo(s) (${formatBytes(bytes)})${isDryRun ? " [DRY-RUN]" : ""}`);
  }
  return { count, bytes };
}

function cleanSimulationAssets(assetsRoot) {
  if (!fs.existsSync(assetsRoot)) return { count: 0, bytes: 0 };
  let totalCount = 0;
  let totalBytes = 0;

  const entries = fs.readdirSync(assetsRoot);
  for (const entry of entries) {
    if (entry.startsWith("simulacion_")) {
      const simDir = path.join(assetsRoot, entry);
      const res = cleanDirectoryContents(simDir, `docs/assets/${entry}`);
      totalCount += res.count;
      totalBytes += res.bytes;
      if (!isDryRun) {
        try { fs.rmdirSync(simDir); } catch (_) {}
      }
    }
  }
  return { count: totalCount, bytes: totalBytes };
}

function cleanExperimentalDatabase(dbPath) {
  if (!fs.existsSync(dbPath)) return { tablesCleared: 0, sizeBefore: 0, sizeAfter: 0 };
  const sizeBefore = safeGetFileSize(dbPath);

  if (isDryRun) {
    return { tablesCleared: 3, sizeBefore, sizeAfter: sizeBefore };
  }

  try {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`
      DROP TABLE IF EXISTS experiment_appointments;
      DROP TABLE IF EXISTS experiment_customer_embeddings;
      DROP TABLE IF EXISTS experiment_customers;
    `);
    db.close();
    const sizeAfter = safeGetFileSize(dbPath);
    return { tablesCleared: 3, sizeBefore, sizeAfter };
  } catch (err) {
    if (!isQuiet) console.warn(`  ⚠️ Aviso en data/experiments.db:`, err.message);
    return { tablesCleared: 0, sizeBefore, sizeAfter: sizeBefore };
  }
}

export function runClean({ dryRun = false, all = false, quiet = false } = {}) {
  const t0 = Date.now();
  let totalFiles = 0;
  let totalBytes = 0;

  if (!quiet) {
    console.log("===============================================================");
    console.log(` 🧹 LIMPIEZA DE ARTEFACTOS Y RESIDUOS DE SIMULACIÓN ${dryRun ? "[DRY-RUN]" : ""}`);
    console.log("===============================================================");
  }

  // 1. Reportes Markdown en docs/
  const docsRes = cleanFilesByPattern(
    path.join(PROJECT_ROOT, "docs"),
    (name) => (name.startsWith("REPORTE_FUNNEL_") || name.startsWith("REPORTE_FOTOGRAFICO_")) && name.endsWith(".md"),
    "Reportes Markdown (docs/REPORTE_FUNNEL_*.md)"
  );
  totalFiles += docsRes.count;
  totalBytes += docsRes.bytes;

  // 2. Activos de simulaciones (docs/assets/simulacion_*)
  const assetsRes = cleanSimulationAssets(path.join(PROJECT_ROOT, "docs", "assets"));
  totalFiles += assetsRes.count;
  totalBytes += assetsRes.bytes;

  // 3. Auditorías JSON temporales (data/audit_reports/*)
  const auditRes = cleanDirectoryContents(
    path.join(PROJECT_ROOT, "data", "audit_reports"),
    "Auditorías JSON (data/audit_reports/*)"
  );
  totalFiles += auditRes.count;
  totalBytes += auditRes.bytes;

  // 4. Artefactos de imágenes de pruebas en test/
  const testRes = cleanFilesByPattern(
    path.join(PROJECT_ROOT, "test"),
    (name) => (name.endsWith("-output.jpg") || name.endsWith("-crop.jpg")),
    "Imágenes de prueba (test/*-output.jpg, test/*-crop.jpg)"
  );
  totalFiles += testRes.count;
  totalBytes += testRes.bytes;

  // 5. Tablas experimentales en base de datos si se solicita
  if (all) {
    const dbRes = cleanExperimentalDatabase(path.join(PROJECT_ROOT, "data", "experiments.db"));
    if (!quiet && dbRes.tablesCleared > 0) {
      console.log(`  ✓ Base de datos (data/experiments.db): Tablas experimentales purgadas.`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  if (!quiet) {
    console.log("---------------------------------------------------------------");
    if (totalFiles === 0) {
      console.log(" ✨ El espacio de trabajo ya está 100% limpio (0 archivos residuales).");
    } else {
      console.log(` 🎉 Limpieza completada en ${elapsed}s:`);
      console.log(`    - Archivos eliminados: ${totalFiles.toLocaleString()}`);
      console.log(`    - Espacio recuperado:  ${formatBytes(totalBytes)}`);
    }
    console.log("===============================================================\n");
  }

  return { totalFiles, totalBytes };
}

// Ejecución directa CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runClean({
    dryRun: isDryRun,
    all: cleanDb,
    quiet: isQuiet
  });
}
