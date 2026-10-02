#!/bin/bash
set -e

echo "=== [1/6] Actualizando paquetes del sistema ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y docker.io curl git ca-certificates gnupg

systemctl enable docker
systemctl start docker

echo "=== [2/6] Instalando Node.js 20 LTS ==="
mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list
apt-get update -y
apt-get install -y nodejs

echo "=== [3/6] Descargando imagen Docker de Neolink ==="
docker pull quantumentangledandy/neolink:latest

echo "=== [4/6] Configurando directorio de la aplicación ==="
mkdir -p /opt/camera-catcher/src

# Escribir neolink.toml
cat << 'EOF' > /opt/camera-catcher/neolink.toml
bind = "0.0.0.0"
bind_port = 8554

[[cameras]]
name = "barberia"
username = "admin"
password = "l@lloque237"
uid = "9527000K49FGY65H"
EOF

# Escribir package.json
cat << 'EOF' > /opt/camera-catcher/package.json
{
  "name": "iot-camera-catcher",
  "version": "1.0.0",
  "main": "src/index.js",
  "type": "module",
  "scripts": {
    "start": "node src/index.js"
  },
  "dependencies": {
    "express": "^4.19.2",
    "firebase-admin": "^12.0.0"
  }
}
EOF

# Escribir src/gemini.js
cat << 'EOF' > /opt/camera-catcher/src/gemini.js
export async function analyzeImageWithGemini(
  imageBuffer,
  prompt = "Describe what do you see in the image",
  apiKey = process.env.GEMINI_API_KEY,
  model = process.env.GEMINI_MODEL || "gemini-flash-latest"
) {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not defined");
  }

  const base64Data = imageBuffer.toString("base64");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  console.log(`[Gemini] Llamando a ${model} con prompt: "${prompt}"...`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: base64Data
              }
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    console.warn("[Gemini] No se encontró texto de respuesta:", JSON.stringify(data));
    return "Sin análisis recibido del modelo.";
  }

  console.log(`[Gemini] Análisis recibido exitosamente (${text.length} caracteres).`);
  return text;
}
EOF

# Escribir src/index.js
cat << 'EOF' > /opt/camera-catcher/src/index.js
import express from "express";
import admin from "firebase-admin";
import { exec } from "child_process";
import fs from "fs/promises";
import path from "path";
import util from "util";
import { fileURLToPath } from "url";
import { analyzeImageWithGemini } from "./gemini.js";

const execPromise = util.promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const TOML_PATH = path.join(PROJECT_ROOT, "neolink.toml");

// Inicializar Firebase Admin (usa Application Default Credentials de la VM de GCP)
admin.initializeApp({
  projectId: process.env.FIREBASE_PROJECT_ID || "skip-bigotes",
  storageBucket: process.env.STORAGE_BUCKET || "skip-bigotes.firebasestorage.app"
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

const app = express();
app.use(express.json());

const DEFAULT_PROMPT = "Describe what do you see in the image";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AQ.Ab8RN6INfNkg0w5zqDOcming00kU9aN0SjMF71fHqISR9BxUHg";

let isCapturing = false;

async function getDynamicPrompt() {
  try {
    const promptRef = db.doc("camera_catcher/prompt");
    const doc = await promptRef.get();
    if (!doc.exists) {
      console.log("[Prompt] camera_catcher/prompt no existe. Creando con prompt default...");
      await promptRef.set({ default: DEFAULT_PROMPT });
      return DEFAULT_PROMPT;
    }
    return doc.data()?.default || DEFAULT_PROMPT;
  } catch (err) {
    console.warn("[Prompt] Error leyendo prompt de Firestore, usando default:", err.message);
    return DEFAULT_PROMPT;
  }
}

export async function executeCaptureProcess() {
  if (isCapturing) {
    console.log("[Capture] Ya hay una captura en proceso. Omitiendo concurrencia.");
    return { status: "already_running" };
  }

  isCapturing = true;
  const timestamp = Date.now();
  const docId = `photo_${timestamp}`;
  const localOutputPath = `/tmp/snap_${timestamp}.jpeg`;

  try {
    console.log(`\n========================================`);
    console.log(`[1/5] Ejecutando captura P2P (${docId})...`);

    const cmd = `docker run --rm -v "${TOML_PATH}":/etc/neolink.toml -v /tmp:/out quantumentangledandy/neolink:latest neolink image -c /etc/neolink.toml --use-stream -f /out/snap_${timestamp}.jpeg barberia`;

    try {
      await execPromise(cmd, { timeout: 45000 });
    } catch (err) {
      try {
        await fs.stat(localOutputPath);
      } catch (_) {
        throw new Error(`Neolink capture failed: ${err.message}`);
      }
    }

    // 2. Leer buffer de imagen
    const buffer = await fs.readFile(localOutputPath);
    console.log(`[2/5] Fotograma capturado: ${buffer.length} bytes.`);

    // 3. Subir a Firebase Storage
    const storagePath = `camera_catcher/photos/${docId}.jpg`;
    console.log(`[3/5] Subiendo a Firebase Storage: ${storagePath}...`);
    const file = bucket.file(storagePath);
    await file.save(buffer, {
      metadata: {
        contentType: "image/jpeg",
        metadata: {
          capturedAt: new Date().toISOString(),
          camera: "barberia",
          source: "gcp-e2-micro"
        }
      }
    });

    try {
      await fs.unlink(localOutputPath);
    } catch (_) {}

    // 4. Leer prompt dinámico
    console.log(`[4/5] Leyendo prompt dinámico de camera_catcher/prompt...`);
    const promptText = await getDynamicPrompt();

    // 5. Análisis Gemini Vision
    console.log(`[5/5] Analizando con Gemini Vision...`);
    const analysis = await analyzeImageWithGemini(buffer, promptText, GEMINI_API_KEY, "gemini-flash-latest");

    // 6. Guardar en Firestore
    const docRef = db.doc(`camera_catcher/photos/photos/${docId}`);
    const record = {
      id: docId,
      imageStoragePath: storagePath,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: new Date().toISOString(),
      epoch: timestamp,
      promptUsed: promptText,
      analysis: analysis,
      camera: "barberia",
      source: "gcp-e2-micro"
    };

    await docRef.set(record);
    console.log(`[Firestore] Documento guardado exitosamente en camera_catcher/photos/photos/${docId}`);
    console.log(`========================================\n`);

    return record;
  } finally {
    isCapturing = false;
  }
}

// Endpoint local para healthcheck
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "iot-camera-catcher",
    vm: "gcp-e2-micro",
    timestamp: new Date().toISOString()
  });
});

app.all("/capture", async (req, res) => {
  try {
    const result = await executeCaptureProcess();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 8085;
app.listen(PORT, () => {
  console.log(`[Server] Daemon escuchando localmente en puerto ${PORT}`);
});

// Programador automático: cada 15 minutos
const INTERVAL_15_MIN = 15 * 60 * 1000;
console.log(`[Cron] Programador automático configurado para ejecutarse cada 15 minutos.`);
setInterval(async () => {
  console.log(`[Cron] Ejecutando captura programada periódica de 15 min...`);
  try {
    await executeCaptureProcess();
  } catch (err) {
    console.error(`[Cron] Error en captura periódica:`, err.message);
  }
}, INTERVAL_15_MIN);

// Listener en tiempo real desde Firestore para el botón "Capturar Ahora" de la web
let lastTriggerHandled = Date.now();
console.log(`[Listener] Escuchando comandos en tiempo real de Firestore: camera_catcher/commands...`);
db.doc("camera_catcher/commands").onSnapshot((snapshot) => {
  const data = snapshot.data();
  if (data && data.action === "capture" && data.requestedAt > lastTriggerHandled) {
    lastTriggerHandled = data.requestedAt;
    console.log(`[Listener] Disparo manual recibido desde la web a las ${new Date(data.requestedAt).toLocaleTimeString()}`);
    executeCaptureProcess().catch(err => {
      console.error(`[Listener] Error procesando captura manual:`, err.message);
    });
  }
}, (err) => {
  console.warn(`[Listener] Error en snapshot listener:`, err.message);
});

// Ejecutar una primera captura al arrancar el servicio
setTimeout(() => {
  console.log("[Boot] Ejecutando captura inicial de verificación al iniciar el sistema...");
  executeCaptureProcess().catch(err => console.error("[Boot] Error en captura inicial:", err.message));
}, 5000);
EOF

echo "=== [5/6] Instalando dependencias de Node.js ==="
cd /opt/camera-catcher
npm install --production

echo "=== [6/6] Creando y activando servicio systemd ==="
cat << 'EOF' > /etc/systemd/system/camera-catcher.service
[Unit]
Description=IOT Camera Catcher Daemon
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/camera-catcher
Environment=NODE_ENV=production
Environment=FIREBASE_PROJECT_ID=skip-bigotes
Environment=STORAGE_BUCKET=skip-bigotes.firebasestorage.app
Environment=GEMINI_API_KEY=AQ.Ab8RN6INfNkg0w5zqDOcming00kU9aN0SjMF71fHqISR9BxUHg
ExecStart=/usr/bin/node /opt/camera-catcher/src/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable camera-catcher.service
systemctl restart camera-catcher.service

echo "=== Despliegue completado exitosamente! ==="
