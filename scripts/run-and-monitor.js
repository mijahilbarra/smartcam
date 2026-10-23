import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
import Database from 'better-sqlite3';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const SIM_CONTAINER_NAME = process.env.SIM_CONTAINER_NAME || 'fast-sim';
const SIM_PORT = process.env.SIM_PORT || '8085';
const SIM_DATA_DIR = process.env.SIM_DATA_DIR || 'data';
const COMPOSE_PROJECT_NAME = process.env.COMPOSE_PROJECT_NAME || '';

function getVideoDuration(filePath) {
  try {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(PROJECT_ROOT, filePath);
    const output = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${fullPath}"`,
      { encoding: 'utf8', timeout: 5000 }
    );
    const dur = parseFloat(output.trim());
    return Number.isFinite(dur) && dur > 0 ? dur : null;
  } catch (_) {
    return null;
  }
}

const VIDEO_PATH = process.argv[2] || process.env.MOCK_VIDEO_PATH || 'data/recordings/barberia_stream_10h.mp4';
const SIM_FPS = Number(process.env.STREAM_FPS) || 1;
const START_SS = process.env.MOCK_VIDEO_START_SS ? Number(process.env.MOCK_VIDEO_START_SS) : 0;
const detectedDuration = getVideoDuration(VIDEO_PATH);
const TOTAL_DURATION = detectedDuration ? Math.round(detectedDuration) : (VIDEO_PATH.includes('7h') ? 20076 : 33939);
const TOTAL_SECONDS = Math.max(1, TOTAL_DURATION - START_SS);
const TOTAL_FRAMES = Math.round(TOTAL_SECONDS * SIM_FPS);


function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}

function getTimestampStr() {
  const d = new Date();
  const YYYY = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const DD = String(d.getDate()).padStart(2, '0');
  const HH = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${YYYY}${MM}${DD}_${HH}${mm}`;
}

async function cleanTestDatabases() {
  console.log(`[Setup] 🧹 Limpiando base de datos SQLite (${SIM_DATA_DIR}) y preparando entorno...`);
  try {
    // 1. Detener el contenedor previo para liberar locks de WAL en SQLite
    try {
      execSync(`docker compose -f docker-compose.fast-sim.yml down`, { cwd: PROJECT_ROOT, stdio: 'ignore' });
    } catch (_) {}

    const dataDirPath = path.join(PROJECT_ROOT, SIM_DATA_DIR);
    const auditDir = path.join(dataDirPath, 'audit_reports');
    if (SIM_DATA_DIR !== 'data') {
      fs.mkdirSync(auditDir, { recursive: true });
      const targetSqlite = path.join(dataDirPath, 'barberia_test.db');
      const sourceSqlite = path.join(PROJECT_ROOT, 'data', 'barberia_test.db');
      if (!fs.existsSync(targetSqlite) && fs.existsSync(sourceSqlite)) {
        fs.copyFileSync(sourceSqlite, targetSqlite);
      }
      const recordingsLink = path.join(dataDirPath, 'recordings');
      if (!fs.existsSync(recordingsLink)) {
        fs.symlinkSync('../data/recordings', recordingsLink);
      }
    }

    const sqlitePath = path.join(PROJECT_ROOT, SIM_DATA_DIR, 'barberia_test.db');
    // Eliminar archivo y archivos temporales de WAL para evitar cualquier corrupción previa
    try { fs.unlinkSync(sqlitePath); } catch (_) {}
    try { fs.unlinkSync(`${sqlitePath}-shm`); } catch (_) {}
    try { fs.unlinkSync(`${sqlitePath}-wal`); } catch (_) {}

    // Inicializar SQLite completamente limpio y saludable
    const { getSqliteClient, resetSqliteClients, blobToVector } = await import('../src/infrastructure/storage/sqlite_client.js');
    resetSqliteClients();
    const sqliteClient = getSqliteClient('test', { dataDir: dataDirPath });
    try {
      const db = sqliteClient.db;
      db.prepare("DELETE FROM appointments;").run();
      db.prepare("DELETE FROM customer_embeddings WHERE customer_id != 'staff_barbero';").run();
      db.prepare("DELETE FROM customers WHERE id != 'staff_barbero';").run();

      // Asegurar que el perfil de staff_barbero y sus embeddings estén en SQLite test
      const hasStaff = db.prepare("SELECT id FROM customers WHERE id = 'staff_barbero'").get();
      if (!hasStaff) {
        const prodPath = path.join(PROJECT_ROOT, 'data', 'barberia.db');
        if (fs.existsSync(prodPath)) {
          const prodDb = new Database(prodPath, { readonly: true });
          const staffRow = prodDb.prepare("SELECT * FROM customers WHERE is_staff = 1 OR id = 'staff_barbero' LIMIT 1").get();
          if (staffRow) {
            const embRows = prodDb.prepare("SELECT * FROM customer_embeddings WHERE customer_id = ? ORDER BY embedding_index ASC").all(staffRow.id);
            const vectors = embRows.map(r => ({
              vector: blobToVector(r.embedding_blob),
              pose: r.pose || "frontal",
              poseLabel: r.pose_label || "Frontal",
              sharpnessScore: r.sharpness_score || 0
            })).filter(e => Array.isArray(e.vector));

            sqliteClient.upsertCustomer({
              id: staffRow.id,
              name: staffRow.name || "Barbero",
              isStaff: true,
              role: staffRow.role || "barber",
              embedding: vectors[0]?.vector || null,
              embeddings: vectors,
              photos: staffRow.photos_json ? JSON.parse(staffRow.photos_json) : [],
              thumbnailBase64: staffRow.thumbnail_base64 || null,
              bestFaceScore: staffRow.best_face_score || 0
            });
            console.log(`[Setup] 👤 Staff '${staffRow.id}' sembrado en SQLite test (${vectors.length} embeddings).`);
          }
          prodDb.close();
        }
      }
      sqliteClient.close();
    } catch (e) {
      console.warn('[Setup] Aviso inicializando SQLite test:', e.message);
    }
    // 2. Limpiar también Firestore test y sincronizar staff_barbero
    try {
      execSync(`node scripts/prepare_test_environment.js`, { cwd: PROJECT_ROOT, stdio: 'inherit' });
    } catch (e) {
      console.warn('[Setup] Aviso limpiando Firestore test:', e.message);
    }
  } catch (err) {
    console.warn('[Setup] Aviso limpiando base de datos:', err.message);
  }

  const auditDir = path.join(PROJECT_ROOT, SIM_DATA_DIR, 'audit_reports');
  if (fs.existsSync(auditDir)) {
    const files = fs.readdirSync(auditDir);
    for (const f of files) {
      try { fs.unlinkSync(path.join(auditDir, f)); } catch (_) {}
    }
  }
  console.log('[Setup] ✅ Entorno de prueba 100% limpio y listo (SQLite + Firestore test).');
}

async function startDockerSimulator() {
  console.log(`[Docker] 🚀 Iniciando contenedor ${SIM_CONTAINER_NAME} (${SIM_FPS} FPS, Fast-Forward) (${VIDEO_PATH})...`);
  const projectFlag = COMPOSE_PROJECT_NAME ? `-p ${COMPOSE_PROJECT_NAME} ` : '';
  execSync(`USE_FIREBASE="true" STREAM_FPS="${SIM_FPS}" REALTIME_INTERVAL_MS="10" SIM_CONTAINER_NAME="${SIM_CONTAINER_NAME}" SIM_PORT="${SIM_PORT}" SIM_DATA_DIR="./${SIM_DATA_DIR}" MOCK_VIDEO_PATH="${VIDEO_PATH}" MOCK_VIDEO_START_SS="${START_SS}" docker compose ${projectFlag}-f docker-compose.fast-sim.yml up -d --force-recreate`, {
    cwd: PROJECT_ROOT,
    stdio: 'ignore'
  });
}

function renderProgressBar(percent, barLength = 28) {
  const p = Math.max(0, Math.min(100, percent));
  const filled = Math.round((p / 100) * barLength);
  const empty = barLength - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

async function generateFinalReport(timestampStr) {
  console.log(`\n[Reporte] 📑 Generando reporte fotográfico con timestamp: ${timestampStr}...`);

  // 1. Exportar assets
  execSync(`SIM_DATA_DIR="${SIM_DATA_DIR}" node scripts/export-simulation-assets.js`, { cwd: PROJECT_ROOT, stdio: 'inherit' });

  // 2. Generar hoja de contacto visual con timestamp
  const auditDir = path.join(PROJECT_ROOT, SIM_DATA_DIR, 'audit_reports');
  const auditFiles = fs.readdirSync(auditDir).filter(f => f.startsWith('audit_appt_') && f.endsWith('.json')).sort();

  const contactSheetFilename = `contact_sheet_${timestampStr}.jpg`;
  const contactSheetPath = path.join(PROJECT_ROOT, 'docs', 'assets', 'simulacion_7h', contactSheetFilename);
  const brainDir = process.env.BRAIN_DIR || '/Users/javierli/.gemini/antigravity/brain/6b0a0246-e5a0-4031-9928-6107401af0c2';
  const brainContactSheetPath = path.join(brainDir, contactSheetFilename);

  const rowComposites = [];
  const rowHeight = 125;
  const thumbSize = 110;
  const colWidth = 115;
  const margin = 10;
  const maxPhotosPerRow = 12;

  for (let r = 0; r < auditFiles.length; r++) {
    const filePath = path.join(auditDir, auditFiles[r]);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const photos = (data.photosAfterClose && data.photosAfterClose.length > 0)
      ? data.photosAfterClose
      : (data.photosBeforeClose || []);

    const photosToDraw = photos.slice(0, maxPhotosPerRow);
    for (let i = 0; i < photosToDraw.length; i++) {
      const p = photosToDraw[i];
      if (!p.thumbnailBase64) continue;
      const b64Data = p.thumbnailBase64.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(b64Data, 'base64');
      try {
        const resized = await sharp(buf).resize(thumbSize, thumbSize, { fit: 'cover' }).toBuffer();
        rowComposites.push({
          input: resized,
          left: margin + i * colWidth,
          top: margin + r * rowHeight
        });
      } catch (_) {}
    }
  }

  if (auditFiles.length > 0 && rowComposites.length > 0) {
    const canvasWidth = margin * 2 + maxPhotosPerRow * colWidth;
    const canvasHeight = Math.max(rowHeight, margin * 2 + auditFiles.length * rowHeight);
    const baseSvg = `<svg width="${canvasWidth}" height="${canvasHeight}"><rect width="${canvasWidth}" height="${canvasHeight}" fill="#18181b"/></svg>`;
    const finalImg = await sharp(Buffer.from(baseSvg)).composite(rowComposites).jpeg({ quality: 90 }).toBuffer();
    fs.writeFileSync(contactSheetPath, finalImg);
    if (fs.existsSync(brainDir)) fs.writeFileSync(brainContactSheetPath, finalImg);
  }

  // 3. Generar archivo Markdown
  const dbPath = path.join(PROJECT_ROOT, SIM_DATA_DIR, 'barberia_test.db');
  let appts = [];
  try {
    const db = new Database(dbPath);
    appts = db.prepare('SELECT * FROM appointments ORDER BY rowid ASC').all();
    db.close();
  } catch (_) {}

  const reportFilename = `REPORTE_FOTOGRAFICO_${timestampStr}.md`;
  const reportPath = path.join(PROJECT_ROOT, 'docs', reportFilename);
  const brainReportPath = path.join(brainDir, reportFilename);

  const hoursDesc = (TOTAL_SECONDS / 3600).toFixed(2);
  let md = `# Reporte Fotográfico de Simulación (${timestampStr})

**Fecha de Ejecución:** ${new Date().toISOString()}  
**Video Analizado:** \`${VIDEO_PATH}\` (${hoursDesc} horas, ${TOTAL_FRAMES.toLocaleString('en-US')} fotogramas a ${SIM_FPS} FPS)  
**Arquitectura:** Modelo de Segmentos y Agrupación por Cuadrante (Sin tiempos estáticos)  

---

## 1. Resumen de Citas Registradas

| # | ID Cita | Cliente | Duración | Inicio | Fin | Fotos |
| :-: | :--- | :--- | :---: | :---: | :---: | :---: |
`;

  const apptMap = new Map();
  appts.forEach(a => apptMap.set(a.id, a));

  auditFiles.forEach((file, idx) => {
    const data = JSON.parse(fs.readFileSync(path.join(auditDir, file), 'utf8'));
    const sqliteRow = apptMap.get(data.appointmentId);
    const sTime = data.startedAt?.split('T')[1]?.slice(0, 8) || sqliteRow?.started_at?.split('T')[1]?.slice(0, 8) || '-';
    const eTime = data.endedAt?.split('T')[1]?.slice(0, 8) || sqliteRow?.ended_at?.split('T')[1]?.slice(0, 8) || '-';
    const photosCount = (data.photosAfterClose || []).length || sqliteRow?.photos_count || '-';
    md += `| ${idx + 1} | \`${data.appointmentId}\` | **${data.clientName}** | **${data.durationMinutes} min** | \`${sTime}\` | \`${eTime}\` | ${photosCount} |\n`;
  });

  md += `\n---\n\n## 2. Hoja de Contacto Consolidada\n\n![Hoja de Contacto](assets/simulacion_7h/${contactSheetFilename})\n\n---\n\n## 3. Desglose Detallado por Cita\n\n`;

  auditFiles.forEach((file, idx) => {
    const data = JSON.parse(fs.readFileSync(path.join(auditDir, file), 'utf8'));
    md += `### Cita ${idx + 1}: ${data.clientName} (\`${data.appointmentId}\`)\n`;
    md += `- **Duración:** ${data.durationMinutes} minutos\n`;
    md += `- **Fotos Aprobadas:** ${(data.photosAfterClose || []).length}\n\n`;
    md += `| Toma 1 (Portada Frontal) | Toma 2 | Toma 3 | Toma 4 |\n| :---: | :---: | :---: | :---: |\n`;
    const thumbs = (data.photosAfterClose || []).slice(0, 4);
    md += '| ' + thumbs.map(p => `![${p.pose}](assets/simulacion_7h/${data.appointmentId}/photo_final_${p.idx}_${p.pose}_score${p.sharpnessScore}.jpg)`).join(' | ') + ' |\n';
    md += '| ' + thumbs.map(p => `\`${p.pose}\` (nitidez: ${p.sharpnessScore})`).join(' | ') + ' |\n\n';
  });

  fs.writeFileSync(reportPath, md, 'utf8');
  if (fs.existsSync(brainDir)) fs.writeFileSync(brainReportPath, md, 'utf8');

  console.log(`\n✅ Reporte final generado con éxito en:\n -> ${reportPath}\n -> ${brainReportPath}`);
}

async function monitorProgress() {
  const timestampStr = getTimestampStr();
  process.stdout.write('\x1Bc');
  console.log(`===============================================================`);
  console.log(`  SIMULACIÓN EN VIVO (${VIDEO_PATH} @ ${SIM_FPS} FPS)`);
  console.log(`  Timestamp de Sesión: ${timestampStr}`);
  console.log(`===============================================================\n`);

  let lastTrackId = 0;
  let videoFinished = false;

  while (!videoFinished) {
    await new Promise(r => setTimeout(r, 1200));

    let logs = '';
    try {
      logs = execSync(`docker logs --tail 100 ${SIM_CONTAINER_NAME} 2>&1`).toString();
    } catch (_) {}

    if (logs.includes('Reproducción de video mock finalizada') || logs.includes('Proceso FFmpeg finalizó con código: 0')) {
      videoFinished = true;
      break;
    }

    // Extraer número de track más reciente
    const trackMatches = logs.match(/#(\d+)/g);
    if (trackMatches && trackMatches.length > 0) {
      const ids = trackMatches.map(m => parseInt(m.replace('#', ''), 10));
      const maxId = Math.max(...ids);
      if (maxId > lastTrackId) lastTrackId = maxId;
    }

    // Intentar obtener progreso exacto desde el endpoint /api/simulation/progress
    let exactPercent = null;
    let exactElapsedSec = null;
    try {
      const resp = await fetch(`http://localhost:${SIM_PORT}/api/simulation/progress`, { signal: AbortSignal.timeout(600) });
      if (resp.ok) {
        const pData = await resp.json();
        if (pData.framesEmitted > 0) {
          const targetFrames = (pData.totalFrames > 0) ? pData.totalFrames : TOTAL_FRAMES;
          exactPercent = (pData.framesEmitted / targetFrames) * 100;
          exactElapsedSec = pData.elapsedSec ? Math.round(pData.elapsedSec) : Math.round((pData.framesEmitted / targetFrames) * TOTAL_SECONDS);
        }
      }
    } catch (_) {}

    // Consultar citas acumuladas en SQLite
    let apptCount = 0;
    let lastApptName = 'Esperando cliente...';
    try {
      const db = new Database(path.join(PROJECT_ROOT, SIM_DATA_DIR, 'barberia_test.db'));
      const row = db.prepare('SELECT COUNT(*) as c FROM appointments').get();
      apptCount = row ? row.c : 0;
      const lastRow = db.prepare('SELECT client_name, duration_minutes FROM appointments ORDER BY rowid DESC LIMIT 1').get();
      if (lastRow) {
        lastApptName = `${lastRow.client_name} (${lastRow.duration_minutes}m)`;
      }
      db.close();
    } catch (_) {}

    const progressPercent = exactPercent !== null
      ? Math.min(99.9, exactPercent)
      : Math.min(99.5, (lastTrackId / 1200) * 100);
    const progressSeconds = exactElapsedSec !== null
      ? Math.min(TOTAL_SECONDS, exactElapsedSec)
      : Math.min(TOTAL_SECONDS, Math.round((progressPercent / 100) * TOTAL_SECONDS));
    const bar = renderProgressBar(progressPercent, 22);

    process.stdout.write('\x1Bc');
    console.log(`===============================================================`);
    console.log(`  SIMULACIÓN EN VIVO (${VIDEO_PATH} @ ${SIM_FPS} FPS)`);
    console.log(`  Timestamp de Sesión: ${timestampStr}`);
    console.log(`===============================================================\n`);
    process.stdout.write(`⏳ [${bar}] ${progressPercent.toFixed(1)}% | Video: ${formatTime(progressSeconds)} / ${formatTime(TOTAL_SECONDS)} | Citas: ${apptCount} | Última: ${lastApptName}   `);
  }

  process.stdout.write('\x1Bc');
  console.log(`===============================================================`);
  console.log(`  SIMULACIÓN EN VIVO (${VIDEO_PATH} @ ${SIM_FPS} FPS)`);
  console.log(`  Timestamp de Sesión: ${timestampStr}`);
  console.log(`===============================================================\n`);
  process.stdout.write(`⏳ [${renderProgressBar(100, 22)}] 100.0% | Video: ${formatTime(TOTAL_SECONDS)} / ${formatTime(TOTAL_SECONDS)} | ¡Video finalizado! Procesando cierre...   \n`);

  // Asegurar cierre de la última sesión si seguía abierta
  try {
    await fetch(`http://localhost:${SIM_PORT}/api/session/close`, { method: 'POST' });
  } catch (_) {}

  await new Promise(r => setTimeout(r, 2000));
  await generateFinalReport(timestampStr);
}

async function main() {
  await cleanTestDatabases();
  await startDockerSimulator();
  await monitorProgress();
}

main().catch(err => {
  console.error('[Error]:', err);
  process.exit(1);
});
