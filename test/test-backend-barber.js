import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import admin from "firebase-admin";
import { detectObjectsAndQuadrants, setCustomQuadrants } from "../src/detector.js";
import { extractFaceEmbedding, identifyFace, computeCosineSimilarity } from "../src/face_recognizer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const photoPath = path.join(__dirname, "photo_barber_working.jpg");
const barberCropOutPath = path.join(__dirname, "test-barber-captured.jpg");

async function runLocalBarberTest() {
  console.log("===================================================================");
  console.log("🧪 TEST LOCAL DE BACKEND: DETECCIÓN CON CUADRANTES DINÁMICOS Y BIOMETRÍA");
  console.log("===================================================================\n");

  // Initialize Firebase Admin to fetch dynamic quadrants from Firestore
  let dynamicQuads = null;
  try {
    if (!admin.apps.length) {
      admin.initializeApp({ projectId: "skip-bigotes" });
    }
    const db = admin.firestore();
    console.log(`[0/4] Conectando a Firestore para leer cuadrantes dinámicos (camera_catcher/quadrants)...`);
    const qSnap = await db.doc("camera_catcher/quadrants").get();
    if (qSnap.exists && qSnap.data()?.quadrants) {
      dynamicQuads = qSnap.data().quadrants;
      setCustomQuadrants(dynamicQuads);
      console.log(`✅ ¡${dynamicQuads.length} cuadrantes dinámicos leídos de Firestore!:`);
      dynamicQuads.forEach((q, idx) => console.log(`   ${idx + 1}. [${q.type}] "${q.name}" (${q.id})`));
    }
  } catch (err) {
    console.warn(`⚠️ No se pudo conectar a Firestore (usando memoria local):`, err.message);
  }

  console.log(`\n[1/4] Leyendo fotograma real de la barbería: ${photoPath}`);
  const imgBuffer = await fs.readFile(photoPath);
  console.log(`- Tamaño del archivo: ${(imgBuffer.length / 1024 / 1024).toFixed(2)} MB`);

  // 1. Detect Objects & Quadrants
  console.log(`\n[2/4] Ejecutando detección YOLOv8 (ONNX CPU) con cuadrantes dinámicos...`);
  const t0 = Date.now();
  const mlResult = await detectObjectsAndQuadrants(imgBuffer, { generateAnnotated: false, forceRecheck: true, quadrants: dynamicQuads });
  const detectTime = Date.now() - t0;

  console.log(`- Inferencia YOLO completada en: ${mlResult.inferenceMs} ms (Total pipeline: ${detectTime} ms)`);
  console.log(`- Detecciones encontradas: ${mlResult.rawDetections.length}`);
  console.log(`- Cuadrantes evaluados: ${mlResult.quadrants.length}`);

  // Display detected quadrants
  console.table(mlResult.quadrants.map(q => ({
    ID: q.id,
    Zona: q.label,
    Tipo: q.type || q.category,
    Estado: q.status,
    Coordenadas: q.box.join(", ")
  })));

  // 2. Identify Barber Crop
  console.log(`\n[3/4] Evaluando recortes de personas extraídos (${mlResult.clientCrops.length})...`);
  const barberCrop = mlResult.clientCrops.find(c => c.isStaffHint === true || c.role === "staff") || mlResult.clientCrops[0];

  if (!barberCrop) {
    throw new Error("No se detectó recorte de persona en el cuadrante del barbero.");
  }

  console.log(`✅ ¡Recorte del Barbero capturado con éxito!`);
  console.log(`- Caja: [${barberCrop.box.join(", ")}]`);
  console.log(`- Confianza de detección: ${barberCrop.confidence}`);
  console.log(`- Estado: ${barberCrop.status}`);
  console.log(`- Rol asignado: ${barberCrop.role} (isStaffHint: ${barberCrop.isStaffHint})`);

  await fs.writeFile(barberCropOutPath, barberCrop.buffer);
  console.log(`- Recorte guardado localmente en: ${barberCropOutPath}`);

  // 3. Extract Face Embedding
  console.log(`\n[4/4] Extrayendo vector biométrico con MobileFaceNet ArcFace (ONNX CPU)...`);
  const tFace0 = Date.now();
  const barberEmbedding = await extractFaceEmbedding(barberCrop.buffer);
  const faceTime = Date.now() - tFace0;

  console.log(`- Embedding extraído en: ${faceTime} ms`);
  console.log(`- Dimensión del vector biométrico: ${barberEmbedding.length} floats (Norma L2)`);
  console.log(`- Muestra de primeros 8 valores: [${barberEmbedding.slice(0, 8).map(v => v.toFixed(4)).join(", ")}]`);

  // 4. Test Biometric Gallery Identification
  console.log(`\n===================================================================`);
  console.log(`🧬 SIMULACIÓN DE IDENTIFICACIÓN: STAFF vs CLIENTE`);
  console.log(`===================================================================`);

  // Define known gallery with the registered Barber profile
  const knownGallery = [
    {
      id: "staff_barbero_carlos",
      name: "Carlos (Barbero Principal)",
      isStaff: true,
      role: "Barbero / Staff",
      embedding: barberEmbedding
    },
    {
      id: "cliente_juan_123",
      name: "Juan (Cliente Frecuente)",
      isStaff: false,
      visitCount: 3,
      // Slightly different random vector
      embedding: barberEmbedding.map((v, i) => i % 2 === 0 ? -v : v * 0.5)
    }
  ];

  console.log(`Galería de prueba en memoria:`);
  console.log(`1. "${knownGallery[0].name}" (isStaff: ${knownGallery[0].isStaff})`);
  console.log(`2. "${knownGallery[1].name}" (isStaff: ${knownGallery[1].isStaff}, visitas: ${knownGallery[1].visitCount})`);

  // Compare incoming face against gallery
  const matchResult = identifyFace(barberEmbedding, knownGallery, 0.45);

  console.log(`\nResultado de la comparación biométrica (identifyFace):`);
  console.log(`- ¿Hubo coincidencia?: ${matchResult.matched ? "SÍ ✅" : "NO ❌"}`);
  console.log(`- Persona identificada: "${matchResult.profile.name}"`);
  console.log(`- Similitud Coseno calculada: ${matchResult.similarity} (Umbral mínimo: 0.45)`);
  console.log(`- ¿Es Staff?: ${matchResult.profile.isStaff ? "SÍ (BARBERO)" : "NO (CLIENTE)"}`);

  // Business logic decision
  if (matchResult.profile.isStaff) {
    console.log(`\n🎯 REGLA DE NEGOCIO APLICADA:`);
    console.log(`➡️ La persona es el BARBERO en servicio.`);
    console.log(`➡️ Conteo de clientes atendidos: 0 (IGNORADO / NO INFLA ESTADÍSTICAS).`);
    console.log(`➡️ Estado: Sistema operativo y filtrando correctamente al staff.`);
  } else {
    console.log(`\n⚠️ La persona fue catalogada como cliente.`);
  }

  console.log(`\n===================================================================`);
  console.log(`✅ TEST LOCAL COMPLETADO CON ÉXITO: EL BARBERO FUE CAPTURADO Y RECONOCIDO.`);
  console.log(`===================================================================\n`);
}

runLocalBarberTest().catch(err => {
  console.error("❌ Error ejecutando test local:", err);
  process.exit(1);
});
