import admin from "firebase-admin";
import { exec } from "child_process";
import fs from "fs/promises";
import path from "path";
import util from "util";
import { analyzeImageWithGemini } from "./src/gemini.js";

const execPromise = util.promisify(exec);

// Initialize Firebase Admin with application default credentials or project ID
admin.initializeApp({
  projectId: "skip-bigotes",
  storageBucket: "skip-bigotes.firebasestorage.app"
});

const db = admin.firestore();
const bucket = admin.storage().bucket();
const GEMINI_API_KEY = "AQ.Ab8RN6INfNkg0w5zqDOcming00kU9aN0SjMF71fHqISR9BxUHg";
const TOML_PATH = path.resolve("./neolink.toml");

async function getDynamicPrompt() {
  const promptRef = db.doc("camera_catcher/prompt");
  const doc = await promptRef.get();
  if (!doc.exists) {
    console.log("[Prompt] camera_catcher/prompt does not exist. Creating default...");
    await promptRef.set({ default: "Describe what do you see in the image" });
    return "Describe what do you see in the image";
  }
  return doc.data()?.default || "Describe what do you see in the image";
}

export async function runSingleCapture() {
  const timestamp = Date.now();
  const docId = `photo_${timestamp}`;
  const localOutputPath = `/tmp/snap_${timestamp}.jpeg`;

  console.log(`\n========================================`);
  console.log(`[1/5] Ejecutando captura efímera de fotograma...`);
  
  // One-shot docker run that captures a single frame and terminates immediately
  const cmd = `docker run --rm -v "${TOML_PATH}":/etc/neolink.toml -v /tmp:/out quantumentangledandy/neolink:latest neolink image -c /etc/neolink.toml --use-stream -f /out/snap_${timestamp}.jpeg barberia`;

  try {
    const { stdout, stderr } = await execPromise(cmd, { timeout: 45000 });
    console.log("[Capture] Neolink finalizado con éxito.");
  } catch (err) {
    // Check if the file was created even if process received SIGTERM
    try {
      await fs.stat(localOutputPath);
    } catch (_) {
      throw new Error(`Neolink capture failed: ${err.message}`);
    }
  }

  // 2. Read image buffer
  const buffer = await fs.readFile(localOutputPath);
  console.log(`[2/5] Imagen capturada: ${buffer.length} bytes.`);

  // 3. Upload to Firebase Storage
  const storagePath = `camera_catcher/photos/${docId}.jpg`;
  console.log(`[3/5] Subiendo a Firebase Storage: ${storagePath}...`);
  const file = bucket.file(storagePath);
  await file.save(buffer, {
    metadata: {
      contentType: "image/jpeg",
      metadata: {
        capturedAt: new Date().toISOString(),
        camera: "barberia"
      }
    }
  });

  // Clean up local temp file
  try {
    await fs.unlink(localOutputPath);
  } catch (_) {}

  // 4. Fetch dynamic prompt from Firestore: camera_catcher/prompt
  console.log(`[4/5] Obteniendo prompt dinámico desde Firestore (camera_catcher/prompt)...`);
  const promptText = await getDynamicPrompt();
  console.log(`[Prompt] Texto: "${promptText}"`);

  // 5. Call Gemini Vision
  console.log(`[5/5] Analizando con Gemini Vision (gemini-flash-latest)...`);
  const analysis = await analyzeImageWithGemini(buffer, promptText, GEMINI_API_KEY, "gemini-flash-latest");
  console.log(`[Gemini] Análisis completado:\n${analysis}`);

  // 6. Save document in Firestore: camera_catcher/photos/photos/<docId>
  const docRef = db.doc(`camera_catcher/photos/photos/${docId}`);
  const record = {
    id: docId,
    imageStoragePath: storagePath,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: new Date().toISOString(),
    epoch: timestamp,
    promptUsed: promptText,
    analysis: analysis,
    camera: "barberia"
  };

  await docRef.set(record);
  console.log(`[Firestore] Documento guardado exitosamente en camera_catcher/photos/photos/${docId}`);
  console.log(`========================================\n`);

  return record;
}

// If executed directly
if (process.argv[1]?.endsWith("local_capture.js")) {
  runSingleCapture()
    .then((r) => {
      console.log("¡Captura y análisis finalizados con éxito!");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Error en captura:", err);
      process.exit(1);
    });
}
