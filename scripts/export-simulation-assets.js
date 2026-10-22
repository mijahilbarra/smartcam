/**
 * Script de utilidad para exportar los assets fotográficos (miniaturas base64)
 * de los reportes de auditoría generados durante la simulación de 7 horas.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDirName = process.env.SIM_DATA_DIR || 'data';
const auditDir = path.join(__dirname, '..', dataDirName, 'audit_reports');
const targetDirs = [
  path.join(__dirname, '..', 'docs', 'assets', 'simulacion_7h'),
  '/Users/javierli/.gemini/antigravity/brain/cc53144b-6a66-4bb4-a06c-b2ad7ae70455/assets/simulacion_7h'
];

targetDirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const auditFiles = fs.readdirSync(auditDir)
  .filter(f => f.startsWith('audit_appt_') && f.endsWith('.json'))
  .sort();

auditFiles.forEach((file) => {
  const filePath = path.join(auditDir, file);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const apptId = data.appointmentId;

  targetDirs.forEach(baseOutDir => {
    const outDir = path.join(baseOutDir, apptId);
    fs.mkdirSync(outDir, { recursive: true });

    const afterThumbs = new Set((data.photosAfterClose || []).map(p => p.thumbnailBase64));

    // 1. Guardar fotos consolidadas finales
    (data.photosAfterClose || []).forEach(p => {
      if (!p.thumbnailBase64) return;
      const b64Data = p.thumbnailBase64.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(b64Data, 'base64');
      const filename = `photo_final_${p.idx}_${p.pose}_score${p.sharpnessScore}.jpg`;
      fs.writeFileSync(path.join(outDir, filename), buf);
    });

    // 2. Guardar fotos antes de cierre y aislar las purgadas (si hubiera)
    (data.photosBeforeClose || []).forEach(p => {
      if (!p.thumbnailBase64) return;
      const b64Data = p.thumbnailBase64.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(b64Data, 'base64');
      const isPurged = !afterThumbs.has(p.thumbnailBase64);

      const beforeFilename = `photo_before_${p.idx}_${p.pose}_score${p.sharpnessScore}.jpg`;
      fs.writeFileSync(path.join(outDir, beforeFilename), buf);

      if (isPurged) {
        const purgedFilename = `purged_barber_${p.idx}_${p.pose}_score${p.sharpnessScore}.jpg`;
        fs.writeFileSync(path.join(outDir, purgedFilename), buf);
      }
    });
  });

  console.log(`[Export] ${apptId}: imágenes exportadas para ${targetDirs.length} destinos.`);
});

console.log('✅ Exportación de assets de simulación 7H finalizada con éxito.');
