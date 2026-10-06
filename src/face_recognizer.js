import ort from "onnxruntime-node";
import sharp from "sharp";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FACE_MODEL_PATH = process.env.FACE_MODEL_PATH || path.join(__dirname, "models", "w600k_mbf.onnx");

let faceSession = null;

/**
 * Initialize or get cached MobileFaceNet ArcFace ONNX inference session
 */
export async function getFaceInferenceSession() {
  if (!faceSession) {
    if (!fs.existsSync(FACE_MODEL_PATH)) {
      throw new Error(`Modelo facial no encontrado en: ${FACE_MODEL_PATH}`);
    }
    console.log(`[FaceRecognizer] Cargando modelo MobileFaceNet ONNX desde: ${FACE_MODEL_PATH}...`);
    const t0 = Date.now();
    faceSession = await ort.InferenceSession.create(FACE_MODEL_PATH, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "basic",
      intraOpNumThreads: 1, // Cap to 1 thread for low CPU footprint
      interOpNumThreads: 1
    });
    console.log(`[FaceRecognizer] Modelo facial inicializado en ${Date.now() - t0} ms.`);
  }
  return faceSession;
}

/**
 * Normalize vector with L2 norm (Euclidean length = 1.0)
 * @param {Float32Array|number[]} vec 
 * @returns {number[]}
 */
export function l2Normalize(vec) {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    sumSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(sumSq) || 1e-8;
  const result = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    result[i] = Number((vec[i] / norm).toFixed(6));
  }
  return result;
}

/**
 * Calculate Cosine Similarity between two L2-normalized 512-dim face embeddings
 * @param {number[]} vecA 
 * @param {number[]} vecB 
 * @returns {number} Value between -1.0 and 1.0 (typically >= 0.45 indicates same person)
 */
export function computeCosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dot = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
  }
  return Number(dot.toFixed(4));
}

/**
 * Extract 512-dimensional face embedding from an image buffer using MobileFaceNet ONNX
 * @param {Buffer} imageBuffer - Face or person crop image
 * @returns {Promise<number[]>} 512-dim unit vector
 */
export async function extractFaceEmbedding(imageBuffer) {
  const session = await getFaceInferenceSession();

  // Resize and normalize to 112x112 RGB Float32Array (InsightFace format)
  // Input pixel normalization: (pixel - 127.5) / 127.5
  const { data } = await sharp(imageBuffer)
    .resize(112, 112, { fit: "cover", position: "top" }) // Focus on top (face/head)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const totalPixels = 112 * 112;
  const float32Data = new Float32Array(3 * totalPixels);

  // CHW format: [1, 3, 112, 112]
  for (let i = 0; i < totalPixels; i++) {
    float32Data[i] = (data[i * 3] - 127.5) / 127.5;                   // R
    float32Data[totalPixels + i] = (data[i * 3 + 1] - 127.5) / 127.5; // G
    float32Data[2 * totalPixels + i] = (data[i * 3 + 2] - 127.5) / 127.5; // B
  }

  const tensor = new ort.Tensor("float32", float32Data, [1, 3, 112, 112]);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  const results = await session.run({ [inputName]: tensor });
  const rawEmbedding = results[outputName].data;

  // Apply L2 normalization to unit hypersphere
  return l2Normalize(rawEmbedding);
}

/**
 * Identify a face embedding against a gallery of known profiles
 * @param {number[]} embedding - 512-dim query embedding
 * @param {Array<{ id: string, name: string, isStaff: boolean, embedding: number[] }>} knownProfiles 
 * @param {number} threshold - Match threshold (default 0.65)
 * @returns {{ matched: boolean, profile: object|null, similarity: number }}
 */
export function identifyFace(embedding, knownProfiles = [], threshold = 0.65) {
  if (!embedding || !knownProfiles || knownProfiles.length === 0) {
    return { matched: false, profile: null, similarity: 0 };
  }

  let bestMatch = null;
  let maxSim = -1;

  for (const profile of knownProfiles) {
    if (!profile.embedding) continue;
    const sim = computeCosineSimilarity(embedding, profile.embedding);
    if (sim > maxSim) {
      maxSim = sim;
      bestMatch = profile;
    }
  }

  const matched = maxSim >= threshold;
  return {
    matched,
    profile: matched ? bestMatch : null,
    similarity: maxSim > -1 ? maxSim : 0
  };
}
