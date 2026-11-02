/**
 * Generador de Reportes, Visualización y Auditoría Causal
 * 
 * Módulo desacoplado para:
 * 1. Hoja de Contacto Visual (Sharp)
 * 2. Exportación de Rostros Representantes de Citas y Tramos
 * 3. Árbol Genealógico Mermaid (Paso 11 -> Validación Espacial Firebase -> Paso 12 -> Paso 13)
 * 4. Reporte Markdown Amigable con Métricas del Funnel
 * 5. Aserción Anti-Quimera (Argon 4)
 */

import fs from "fs";
import path from "path";
import sharp from "sharp";
import { computeCosineSimilarity } from "../../face_recognizer.js";
import { getRepresentativeFace } from "./appointment_finalizer.js";
import { ensureCanonicalFaceBuffer } from "../face_quality_service.js";
import { PIPELINE_CONFIG } from "../../core/pipeline_config.js";

const pad = (n) => String(n).padStart(2, "0");

export function formatSecondsToTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * Genera la hoja de contacto visual consolidada si hay <= maxAppointments
 */
export async function generateVisualContactSheet({
  completedAppts = [],
  outputDir,
  timestampFile,
  maxAppointments = 50
}) {
  if (completedAppts.length === 0 || completedAppts.length > maxAppointments) {
    return null;
  }

  const contactSheetFilename = `contact_sheet_funnel_${timestampFile}.jpg`;
  const contactSheetPath = path.join(outputDir, contactSheetFilename);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const rowHeight = 125;
  const thumbSize = 110;
  const colWidth = 115;
  const margin = 10;
  const maxPhotosPerRow = 12;
  const composites = [];

  for (let r = 0; r < completedAppts.length; r++) {
    const appt = completedAppts[r];
    const phs = (appt.photos || []).slice(0, maxPhotosPerRow);
    for (let c = 0; c < phs.length; c++) {
      const ph = phs[c];
      if (!ph.thumbnailBase64) continue;
      try {
        const canonicalBuf = await ensureCanonicalFaceBuffer(ph.thumbnailBase64, ph.pose);
        const resized = await sharp(canonicalBuf).resize(thumbSize, thumbSize, { fit: "cover" }).toBuffer();
        composites.push({
          input: resized,
          top: margin + r * rowHeight,
          left: margin + c * colWidth
        });
      } catch (_) {}
    }
  }

  if (composites.length > 0) {
    const sheetWidth = margin * 2 + maxPhotosPerRow * colWidth;
    const sheetHeight = margin * 2 + completedAppts.length * rowHeight;
    await sharp({
      create: {
        width: sheetWidth,
        height: Math.max(100, sheetHeight),
        channels: 3,
        background: { r: 18, g: 18, b: 18 }
      }
    })
      .composite(composites)
      .jpeg({ quality: 90 })
      .toFile(contactSheetPath);
    return contactSheetPath;
  }

  return null;
}

/**
 * Exporta miniaturas representativas para los pasos de auditoría visual
 */
export async function exportRepresentativeFaces({
  completedAppts = [],
  trackedClosures = [],
  repCitasDir
}) {
  if (!fs.existsSync(repCitasDir)) fs.mkdirSync(repCitasDir, { recursive: true });

  // 1. Representantes de citas definitivas
  for (let r = 0; r < completedAppts.length; r++) {
    const appt = completedAppts[r];
    const rep = getRepresentativeFace(appt.photos || [], appt.embeddings || []) || { photo: appt.photos?.[0] };
    const photo = rep?.photo || appt.photos?.[0];
    const numPad = String(r + 1).padStart(2, "0");
    if (photo && photo.thumbnailBase64) {
      try {
        const buf = await ensureCanonicalFaceBuffer(photo.thumbnailBase64, photo.pose);
        const outS12Path = path.join(repCitasDir, `s12_${numPad}.jpg`);
        const outRepPath = path.join(repCitasDir, `cita_${numPad}.jpg`);
        await sharp(buf).resize(100, 100, { fit: "cover" }).jpeg({ quality: 95 }).toFile(outS12Path);
        await sharp(buf).resize(100, 100, { fit: "cover" }).jpeg({ quality: 95 }).toFile(outRepPath);
      } catch (_) {}
    }
  }

  // 2. Representantes de tramos evaluados (Paso 11)
  for (const tramo of trackedClosures) {
    const idxPad = String(tramo.index).padStart(2, "0");
    const rep = getRepresentativeFace(tramo.photos || [], tramo.embeddings || []) || { photo: tramo.photos?.[0] };
    const photo = rep?.photo || tramo.photos?.[0];
    const outPath = path.join(repCitasDir, `s11_${idxPad}.jpg`);

    if (photo && photo.thumbnailBase64) {
      try {
        const buf = await ensureCanonicalFaceBuffer(photo.thumbnailBase64, photo.pose);
        await sharp(buf).resize(100, 100, { fit: "cover" }).jpeg({ quality: 95 }).toFile(outPath);
      } catch (_) {}
    } else {
      try {
        const placeholderSvg = Buffer.from(`
          <svg width="100" height="100" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
            <rect width="100" height="100" rx="14" fill="#37474f"/>
            <text x="50" y="46" font-family="Arial,sans-serif" font-size="28" fill="#cfd8dc" text-anchor="middle">💺</text>
            <text x="50" y="74" font-family="Arial,sans-serif" font-weight="bold" font-size="13" fill="#eceff1" text-anchor="middle">T#${idxPad}</text>
          </svg>
        `);
        await sharp(placeholderSvg).jpeg({ quality: 90 }).toFile(outPath);
      } catch (_) {}
    }
  }
}

/**
 * Genera el Árbol Genealógico Real Mermaid JS
 */
export function generateMermaidLineage({
  trackedClosures = [],
  completedAppts = [],
  repCitasDir
}) {
  const apptIndexMap = new Map();
  completedAppts.forEach((a, idx) => {
    if (a.id) apptIndexMap.set(a.id, idx);
  });

  const tramosPerAppt = new Map();
  trackedClosures.forEach(t => {
    if (t.resultAppt) {
      const aIdx = apptIndexMap.get(t.resultAppt.id);
      if (aIdx !== undefined) {
        tramosPerAppt.set(aIdx, (tramosPerAppt.get(aIdx) || 0) + 1);
      }
    }
  });

  let mermaidTree = "```mermaid\nflowchart LR\n";

  // Subgraph Paso 11: Continuidad en Silla
  const validTramos = trackedClosures.filter(t => !!t.resultAppt);
  const discardedTramos = trackedClosures.filter(t => !t.resultAppt);

  mermaidTree += `    subgraph G11 ["Paso 11: Continuidad en Silla (${trackedClosures.length} Tramos)"]\n`;
  mermaidTree += "        direction TB\n";
  mermaidTree += `        subgraph G11_VALID ["Tramos Válidos (${validTramos.length} Tramos)"]\n`;
  mermaidTree += "            direction TB\n";
  for (const t of validTramos) {
    const idxPad = String(t.index).padStart(2, "0");
    mermaidTree += `            S11_${idxPad}["<img src='${repCitasDir}/s11_${idxPad}.jpg' width='50' style='border-radius:4px;'/><br/>T#${idxPad} (${t.durationMinutes}m)"]\n`;
  }
  mermaidTree += "        end\n\n";

  mermaidTree += `        subgraph G11_DISC ["Tramos Descartados (${discardedTramos.length} Tramos)"]\n`;
  mermaidTree += "            direction TB\n";
  for (const t of discardedTramos) {
    const idxPad = String(t.index).padStart(2, "0");
    mermaidTree += `            S11_${idxPad}["<img src='${repCitasDir}/s11_${idxPad}.jpg' width='50' style='border:2px solid #e53935; border-radius:4px;'/><br/>T#${idxPad} (${t.durationMinutes}m)"]\n`;
  }
  mermaidTree += "        end\n";
  mermaidTree += "    end\n\n";

  // Subgraph Validación Espacial: Caja Humano YOLO vs Caja Silla Firebase
  const spatialApproved = trackedClosures.filter(t => t.spatialCheck?.isValid !== false);
  const spatialRejected = trackedClosures.filter(t => t.spatialCheck?.isValid === false);

  mermaidTree += `    subgraph G_SPATIAL ["Validación Espacial: Caja YOLO vs Silla Firebase (${spatialApproved.length} Aprobados)"]\n`;
  mermaidTree += "        direction TB\n";
  mermaidTree += `        subgraph G_SPATIAL_OK ["Dentro de Caja Silla (${spatialApproved.length})"]\n`;
  mermaidTree += "            direction TB\n";
  for (const t of spatialApproved) {
    const idxPad = String(t.index).padStart(2, "0");
    mermaidTree += `            SP_${idxPad}["📐 Silla OK<br/>T#${idxPad}"]\n`;
  }
  mermaidTree += "        end\n";
  if (spatialRejected.length > 0) {
    mermaidTree += `        subgraph G_SPATIAL_REJ ["Fuera de Caja Firebase (${spatialRejected.length})"]\n`;
    mermaidTree += "            direction TB\n";
    for (const t of spatialRejected) {
      const idxPad = String(t.index).padStart(2, "0");
      mermaidTree += `            SP_DISC_${idxPad}["❌ Fuera Silla<br/>T#${idxPad}"]\n`;
    }
    mermaidTree += "        end\n";
  }
  mermaidTree += "    end\n\n";

  // Subgraph Paso 12: Filtro de Ruido
  mermaidTree += `    subgraph G12 ["Paso 12: Filtro de Ruido (${completedAppts.length} Válidas)"]\n`;
  mermaidTree += "        direction TB\n";
  for (let k = 0; k < completedAppts.length; k++) {
    const a = completedAppts[k];
    const numPad = String(k + 1).padStart(2, "0");
    mermaidTree += `        S12_${numPad}["<img src='${repCitasDir}/s12_${numPad}.jpg' width='50' style='border-radius:4px;'/><br/>Válida #${numPad} (${a.durationMinutes}m)"]\n`;
  }
  mermaidTree += "    end\n\n";

  // Subgraph Paso 13: Citas Definitivas Consolidadas
  mermaidTree += `    subgraph G13 ["Paso 13: Citas Definitivas (${completedAppts.length} Clientes)"]\n`;
  mermaidTree += "        direction TB\n";
  for (let r = 0; r < completedAppts.length; r++) {
    const a = completedAppts[r];
    const numPad = String(r + 1).padStart(2, "0");
    mermaidTree += `        S13_${numPad}["<img src='${repCitasDir}/cita_${numPad}.jpg' width='50' style='border-radius:4px;'/><br/>Cliente #${numPad} (${a.durationMinutes}m)"]\n`;
  }
  mermaidTree += "    end\n\n";

  // Conexiones Paso 11 -> Validación Espacial
  mermaidTree += "    %% Conexiones Paso 11 -> Validación Espacial Firebase\n";
  for (const t of trackedClosures) {
    const idxPad = String(t.index).padStart(2, "0");
    if (t.spatialCheck?.isValid !== false) {
      mermaidTree += `    S11_${idxPad} -->|Caja Silla OK| SP_${idxPad}\n`;
    } else {
      mermaidTree += `    S11_${idxPad} -->|Fuera de Silla| SP_DISC_${idxPad}\n`;
    }
  }

  // Conexiones Validación Espacial -> Paso 12
  mermaidTree += "\n    %% Conexiones Validación Espacial -> Paso 12\n";
  for (const t of trackedClosures) {
    const idxPad = String(t.index).padStart(2, "0");
    if (t.spatialCheck?.isValid !== false && t.resultAppt) {
      const aIdx = apptIndexMap.get(t.resultAppt.id);
      if (aIdx !== undefined) {
        const numPad = String(aIdx + 1).padStart(2, "0");
        const count = tramosPerAppt.get(aIdx) || 1;
        if (count > 1) {
          mermaidTree += `    SP_${idxPad} -->|Fusión Paso 11| S12_${numPad}\n`;
        } else {
          mermaidTree += `    SP_${idxPad} --> S12_${numPad}\n`;
        }
      }
    }
  }

  // Conexiones Paso 12 -> Paso 13
  mermaidTree += "\n    %% Conexiones Paso 12 -> Paso 13\n";
  for (let r = 0; r < completedAppts.length; r++) {
    const rPad = String(r + 1).padStart(2, "0");
    mermaidTree += `    S12_${rPad} --> S13_${rPad}\n`;
  }

  // Estilos
  mermaidTree += "\n    %% Estilos de Nodos\n";
  for (const t of trackedClosures) {
    if (!t.resultAppt) {
      const idxPad = String(t.index).padStart(2, "0");
      mermaidTree += `    style S11_${idxPad} stroke:#e53935,stroke-width:2px,fill:#ffebee\n`;
    }
  }
  for (const t of spatialApproved) {
    const idxPad = String(t.index).padStart(2, "0");
    mermaidTree += `    style SP_${idxPad} fill:#f1f8e9,stroke:#689f38,stroke-width:1.5px\n`;
  }
  for (const t of spatialRejected) {
    const idxPad = String(t.index).padStart(2, "0");
    mermaidTree += `    style SP_DISC_${idxPad} fill:#ffebee,stroke:#e53935,stroke-width:1.5px\n`;
  }
  tramosPerAppt.forEach((cnt, aIdx) => {
    if (cnt > 1) {
      const numPad = String(aIdx + 1).padStart(2, "0");
      mermaidTree += `    style S12_${numPad} fill:#e1f5fe,stroke:#0288d1,stroke-width:2px,color:#01579b\n`;
    }
  });

  mermaidTree += "    style G11_DISC stroke:#e53935,stroke-dasharray: 4 4,fill:#fff8f8\n";
  mermaidTree += "    style G11_VALID stroke:#0288d1,stroke-width:1.5px,fill:#f4faff\n";
  mermaidTree += "    style G_SPATIAL stroke:#7cb342,stroke-width:1.5px,fill:#fafafa\n";
  mermaidTree += "    style G_SPATIAL_OK stroke:#689f38,stroke-width:1px,fill:#f1f8e9\n";
  mermaidTree += "```\n";

  return mermaidTree;
}

/**
 * Genera el archivo Markdown del reporte de clasificación causal
 */
export async function generateFunnelReportMarkdown({
  reportPath,
  videoName,
  dbPath,
  elapsedSec,
  metrics,
  completedAppts = [],
  trackedClosures = [],
  mermaidTree,
  contactSheetPath = null,
  baseVideoEpoch = 0,
  allTrackBlocks = []
}) {
  const now = new Date();
  const spatialApproved = trackedClosures.filter(t => t.spatialCheck?.isValid !== false);
  const spatialRejected = trackedClosures.filter(t => t.spatialCheck?.isValid === false);

  let md = `# Reporte de Clasificación Causal (Replay en Tiempo Real)

- **Fecha y Hora:** ${now.toISOString().replace("T", " ").slice(0, 19)}
- **Video Evaluado:** \`${videoName}\`
- **Motor de Procesos:** \`src/services/pipeline/causal_cycle_orchestrator.js\` (Canónico Unificado)
- **Base de Datos:** \`${dbPath}\`
- **Tiempo de Ejecución:** **${elapsedSec}s**

---

## 🌪️ Embudo Causal de Filtrado (Funnel de 7 Etapas Canónicas + Capa 13)

1. **Cosecha inicial:** ${metrics.countHarvested.toLocaleString()} fotos (frames evaluados secuencialmente).
2. **Detección facial:** ${metrics.countFaceDetected.toLocaleString()} imágenes con rostro detectable.
3. **Filtro Anti-Objetos (Celulares) y Piel Humana:** ${metrics.countAntiObjects.toLocaleString()} imágenes humanas confirmadas.
4. **Filtro de Nitidez Mínima (Score >= 20):** ${metrics.countSharpness.toLocaleString()} imágenes con nitidez válida.
5. **Poses Anatómicas Válidas:** ${metrics.countValidPoses.toLocaleString()} capturas biométricas (excluye orejas/nucas ciegas).
6. **Clasificación Anatómica:** ${metrics.countUpright.toLocaleString()} Erguidas vs ${metrics.countReclined.toLocaleString()} Reclinadas.
7. **Exclusión de Barbero / Personal:** ${metrics.countStaffExcluded.toLocaleString()} capturas descartadas como staff/de pie.
8. **Recortes de Cliente Aprobados:** ${metrics.countClientPassed.toLocaleString()} fotos genuinas de clientes en silla.
9. **Bloques Confirmados en Silla:** ${metrics.confirmedBlocksCount} bloques por TrackBlockManager.
10. **Tramos en Silla Evaluados (Paso 11):** ${trackedClosures.length} tramos cerrados.
11. **Validación Espacial de Caja (Humano YOLO vs Silla Firebase):** ${spatialApproved.length} tramos aprobados dentro de la caja de la silla (${spatialRejected.length} descartados por \`fuera_de_caja_silla_firebase\`).
12. **Filtro de Ruido (Paso 12):** ${completedAppts.length} atenciones válidas pre-consolidación.
13. **Citas Finales Consolidadas (Paso 13 / Capa 13 Causal):** ${completedAppts.length} clientes definitivos.

---

## 🌳 Árbol Genealógico de Continuidad y Consolidación (Pasos 11, Validación Espacial Firebase, 12 y 13)

${mermaidTree}

---

## 📋 Detalle Cronológico por Cliente

| # | Cliente | Duración | Rango Video | Fotos | Mejor Score | Pureza Biometría | Inicio (ISO) |
|---|---------|----------|-------------|-------|-------------|------------------|--------------|
`;

  const chimeraThreshold = PIPELINE_CONFIG.biometrics?.chimeraThreshold ?? 0.38;

  for (let i = 0; i < completedAppts.length; i++) {
    const a = completedAppts[i];
    const startEp = a.startedAtEpoch || new Date(a.startedAt).getTime();
    const endEp = a.endedAtEpoch || new Date(a.endedAt).getTime();
    const durMin = a.durationMinutes || Math.round((endEp - startEp) / 60000);
    const startSec = Math.max(0, Math.round((startEp - baseVideoEpoch) / 1000));
    const endSec = Math.max(startSec, Math.round((endEp - baseVideoEpoch) / 1000));
    const rangeStr = `${formatSecondsToTime(startSec)} - ${formatSecondsToTime(endSec)}`;
    const photos = a.photos || [];
    const embeddings = (a.embeddings || []).map(e => (Array.isArray(e) ? e : e?.vector || null)).filter(Boolean);

    let minPairSim = 1.0;
    for (let x = 0; x < embeddings.length; x++) {
      for (let y = x + 1; y < embeddings.length; y++) {
        const sim = computeCosineSimilarity(embeddings[x], embeddings[y]);
        if (sim < minPairSim) minPairSim = sim;
      }
    }
    const isChimera = embeddings.length > 1 && minPairSim < chimeraThreshold;
    const purityStr = isChimera ? `❌ Quimera (minSim=${minPairSim.toFixed(3)})` : `✅ Pura (minSim=${minPairSim.toFixed(3)})`;
    const clientName = a.customerName || a.clientName || `Cliente #${i + 1}`;
    md += `| ${i + 1} | **${clientName}** | ${durMin} min | ${rangeStr} | ${photos.length} fotos | Score ${a.bestFaceScore || 0} | ${purityStr} | \`${a.startedAt || new Date(startEp).toISOString()}\` |\n`;
  }

  if (completedAppts.length <= 50 && completedAppts.length > 0) {
    md += `\n## 📸 Reporte Fotográfico (${completedAppts.length} Atenciones Finales)\n\n`;
    if (contactSheetPath) {
      md += `### 🖼️ Hoja de Contacto Consolidada\n![Hoja de Contacto](${contactSheetPath})\n\n`;
    }
    md += `### 👥 Desglose de Muestras Faciales por Cita\n\n`;

    for (let i = 0; i < completedAppts.length; i++) {
      const a = completedAppts[i];
      const clientName = a.customerName || a.clientName || `Cliente #${i + 1}`;
      const startEp = a.startedAtEpoch || new Date(a.startedAt).getTime();
      const endEp = a.endedAtEpoch || new Date(a.endedAt).getTime();
      const startSec = Math.max(0, Math.round((startEp - baseVideoEpoch) / 1000));
      const endSec = Math.max(startSec, Math.round((endEp - baseVideoEpoch) / 1000));
      const durMin = a.durationMinutes || Math.round((endEp - startEp) / 60000);

      md += `#### ${clientName} (${durMin} min, ${(a.photos || []).length} fotos)\n`;
      md += `- **Intervalo en video:** ${formatSecondsToTime(startSec)} a ${formatSecondsToTime(endSec)}\n`;
      md += `- **Mejor nitidez:** Score ${a.bestFaceScore || 0}\n\n`;

      const sampleThumbs = (a.photos || []).slice(0, 6);
      const imgTags = (await Promise.all(
        sampleThumbs
          .filter(p => p.thumbnailBase64)
          .map(async p => {
            let thumbSrc = p.thumbnailBase64;
            try {
              const canonicalBuf = await ensureCanonicalFaceBuffer(p.thumbnailBase64, p.pose);
              thumbSrc = `data:image/jpeg;base64,${canonicalBuf.toString("base64")}`;
            } catch (_) {}
            return `<img src="${thumbSrc}" width="100" style="border-radius:6px; margin-right:6px;" title="Nitidez: ${p.sharpnessScore || 0} | ${p.poseLabel || p.pose || ""}" />`;
          })
      )).join(" ");

      if (imgTags) {
        md += `${imgTags}\n\n`;
      }
      md += `---\n\n`;
    }
  }

  if (Array.isArray(allTrackBlocks) && allTrackBlocks.length > 0) {
    md += `\n## 🧱 Historial de Segmentación de Bloques (TrackBlocks Timeline)\n\n`;
    md += `Total de bloques evaluados por TrackBlockManager: **${allTrackBlocks.length}**\n\n`;
    md += `| # | TrackId | Silla | Duración | Veredicto | Poses | Standing% | StaffSim | Decisión / Razón |\n`;
    md += `|---|---------|-------|----------|-----------|-------|-----------|----------|------------------|\n`;

    const displayBlocks = allTrackBlocks.length > 120
      ? allTrackBlocks.filter(b => b.status === "confirmado" || b.status === "puente_presencia" || b.verdict === "CONFIRMED_CLIENT_BLOCK").concat(allTrackBlocks.slice(-30))
      : allTrackBlocks;

    const seenIds = new Set();
    let idx = 0;
    for (const b of displayBlocks) {
      if (seenIds.has(b.id || `${b.trackId}_${b.startedAtEpoch}`)) continue;
      seenIds.add(b.id || `${b.trackId}_${b.startedAtEpoch}`);
      idx++;
      const durStr = b.durationSeconds >= 60 ? `${b.durationMinutes}m (${b.durationSeconds}s)` : `${b.durationSeconds}s`;
      const verdictIcon = b.status === "confirmado" ? "✅" : (b.status === "puente_presencia" ? "🪑" : "⚠️");
      const posesStr = (b.poses && b.poses.length > 0) ? b.poses.join(", ") : "-";
      const standingStr = `${Math.round((b.standingRatio || 0) * 100)}%`;
      const staffSimStr = b.maxStaffSim ? b.maxStaffSim.toFixed(3) : "0.000";
      const reasonStr = (b.reason || "").replace(/\|/g, "\\|");
      md += `| ${idx} | #${b.trackId} | ${b.chairName || b.chairId || "Silla"} | ${durStr} | ${verdictIcon} \`${b.verdict}\` | ${posesStr} | ${standingStr} | ${staffSimStr} | ${reasonStr} |\n`;
    }
    md += `\n`;
  }

  const reportDir = path.dirname(reportPath);
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportPath, md);
  return reportPath;
}

/**
 * Evalúa las aserciones de pureza biométrica anti-quimera (Argon 4)
 */
export function assertAntiChimeraPurity(completedAppts = [], chimeraThreshold = 0.38) {
  let hasChimera = false;
  const results = [];

  for (let i = 0; i < completedAppts.length; i++) {
    const appt = completedAppts[i];
    const startEp = appt.startedAtEpoch || new Date(appt.startedAt).getTime();
    const endEp = appt.endedAtEpoch || new Date(appt.endedAt).getTime();
    const durMin = appt.durationMinutes || Math.round((endEp - startEp) / 60000);
    const photos = appt.photos || [];
    const embeddings = (appt.embeddings || []).map(e => (Array.isArray(e) ? e : e?.vector || null)).filter(Boolean);

    let minPairSim = 1.0;
    let maxPairSim = 0.0;
    let sumSim = 0;
    let pairCount = 0;

    for (let a = 0; a < embeddings.length; a++) {
      for (let b = a + 1; b < embeddings.length; b++) {
        const sim = computeCosineSimilarity(embeddings[a], embeddings[b]);
        if (sim < minPairSim) minPairSim = sim;
        if (sim > maxPairSim) maxPairSim = sim;
        sumSim += sim;
        pairCount++;
      }
    }

    const avgPairSim = pairCount > 0 ? (sumSim / pairCount).toFixed(3) : "1.000";
    const isChimeraDetected = pairCount > 0 && minPairSim < chimeraThreshold;
    if (isChimeraDetected) hasChimera = true;

    results.push({
      index: i + 1,
      clientName: appt.customerName || appt.clientName || "Cliente",
      durMin,
      startIso: new Date(startEp).toISOString().slice(11, 19),
      endIso: new Date(endEp).toISOString().slice(11, 19),
      photosCount: photos.length,
      bestFaceScore: appt.bestFaceScore || 0,
      embeddingsCount: embeddings.length,
      minPairSim,
      avgPairSim,
      maxPairSim,
      isChimeraDetected
    });
  }

  return {
    hasChimera,
    results
  };
}
