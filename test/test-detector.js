import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { detectObjectsAndQuadrants } from "../src/detector.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sampleImagePath = "/Users/javierli/.gemini/antigravity/brain/4b779ab0-e87d-421c-994f-5d82dc08f9e7/.user_uploaded/media_1790975016490.png";
const outputImagePath = path.join(__dirname, "test-annotated-output.jpg");

async function main() {
  console.log("=== Test de Detección de Cuadrantes con ONNX Runtime ===");
  console.log(`Leyendo imagen de prueba: ${sampleImagePath}`);

  const buffer = await fs.readFile(sampleImagePath);
  console.log(`Tamaño de imagen: ${buffer.length} bytes`);

  const tStart = Date.now();
  const result = await detectObjectsAndQuadrants(buffer, { confThreshold: 0.18, generateAnnotated: true, forceRecheck: true });
  const totalElapsed = Date.now() - tStart;

  console.log(`\nResultados:`);
  console.log(`- Tiempo de inferencia ONNX: ${result.inferenceMs} ms`);
  console.log(`- Tiempo total de procesamiento (incl. Sharp SVG): ${totalElapsed} ms`);
  console.log(`- Dimensiones: ${result.imageDimensions.width}x${result.imageDimensions.height}`);

  console.log(`\nDetecciones COCO Crudas:`);
  console.table(result.rawDetections.map(d => ({
    clase: d.class,
    confianza: d.score,
    caja: d.box.join(", ")
  })));

  console.log(`\nCuadrantes Mapeados de la Barbería:`);
  console.table(result.quadrants.map(q => ({
    etiqueta: q.label,
    estado: q.status,
    caja: q.box.join(", ")
  })));

  // Verify client crops
  console.log(`\nClientes Sentados Extraídos (${result.clientCrops ? result.clientCrops.length : 0}):`);
  if (result.clientCrops && result.clientCrops.length > 0) {
    for (let i = 0; i < result.clientCrops.length; i++) {
      const crop = result.clientCrops[i];
      const cropSavePath = path.join(__dirname, `test-client-${i + 1}-crop.jpg`);
      await fs.writeFile(cropSavePath, crop.buffer);
      console.log(`- Cliente #${i + 1}: Caja [${crop.box.join(", ")}], Confianza: ${crop.confidence}, Guardado en: ${cropSavePath}`);
    }
  }

  await fs.writeFile(outputImagePath, result.annotatedBuffer);
  console.log(`\nImagen anotada guardada en: ${outputImagePath}`);

  const mem = process.memoryUsage();
  console.log(`\nConsumo de Memoria:`);
  console.log(`- RSS: ${(mem.rss / 1024 / 1024).toFixed(1)} MB`);
  console.log(`- Heap Usado: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`);

  console.log(`\n--- Prueba 2: Fotograma Estático (Verificación de Frame Differencing) ---`);
  const t2Start = Date.now();
  const result2 = await detectObjectsAndQuadrants(buffer);
  const t2Elapsed = Date.now() - t2Start;

  console.log(`- ¿Omitió inferencia por falta de cambio?: ${result2.skippedDueToNoChange ? "SÍ (0% CPU / 0ms inferencia)" : "NO"}`);
  console.log(`- Variación calculada: ${result2.diffPercent}%`);
  console.log(`- Tiempo total de respuesta: ${t2Elapsed} ms`);
  console.log(`======================================================`);
}

main().catch(err => {
  console.error("Error en test:", err);
  process.exit(1);
});
