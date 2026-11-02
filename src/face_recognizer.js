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
    const defaultThreads = process.env.STREAM_FAST_FORWARD === "true" ? 4 : 1;
    const threads = Number(process.env.ONNX_THREADS) || defaultThreads;
    const isMac = process.platform === "darwin";
    const explicitProvider = process.env.ONNX_PROVIDER;
    const executionProviders = explicitProvider
      ? [explicitProvider, "cpu"]
      : (isMac && (process.env.IS_LOCAL_SIMULATOR === "true" || process.env.STREAM_FAST_FORWARD === "true") ? ["coreml", "cpu"] : ["cpu"]);
    faceSession = await ort.InferenceSession.create(FACE_MODEL_PATH, {
      executionProviders,
      graphOptimizationLevel: "all",
      intraOpNumThreads: threads,
      interOpNumThreads: threads,
      enableCpuMemArena: false,
      enableMemPattern: false
    });
    console.log(`[FaceRecognizer] Modelo facial inicializado en ${Date.now() - t0} ms (${threads} hilo(s) CPU, providers: ${executionProviders.join(", ")}).`);
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
  const a = Array.isArray(vecA) ? vecA : (vecA?.vector || null);
  const b = Array.isArray(vecB) ? vecB : (vecB?.vector || null);
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return Number(dot.toFixed(4));
}

/**
 * Determina si dos orientaciones / poses faciales pertenecen al mismo grupo o son compatibles
 * para optimizar la comparación biométrica por perspectiva.
 * @param {string} poseA 
 * @param {string} poseB 
 * @returns {boolean}
 */
export function arePosesCompatible(poseA, poseB) {
  if (!poseA || !poseB) return true;
  if (poseA === poseB) return true;

  const leftGroup = ['profile_left', 'semi_left', 'tilted_down_left', 'tilted_up_left'];
  const rightGroup = ['profile_right', 'semi_right', 'tilted_down_right', 'tilted_up_right'];
  const downGroup = ['tilted_down', 'tilted_down_left', 'tilted_down_right'];
  const upGroup = ['tilted_up', 'tilted_up_left', 'tilted_up_right'];
  const frontalGroup = ['frontal', 'semi_left', 'semi_right'];

  if (leftGroup.includes(poseA) && leftGroup.includes(poseB)) return true;
  if (rightGroup.includes(poseA) && rightGroup.includes(poseB)) return true;
  if (downGroup.includes(poseA) && downGroup.includes(poseB)) return true;
  if (upGroup.includes(poseA) && upGroup.includes(poseB)) return true;
  if (frontalGroup.includes(poseA) && frontalGroup.includes(poseB)) return true;

  return false;
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
  // Usar fit: "fill" para preservar el rostro completo (ojos, nariz, boca y mentón)
  const { data } = await sharp(imageBuffer)
    .resize(112, 112, { fit: "fill" })
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
 * Supports multi-angle galleries (profile.embeddings) and fallback to single embedding (profile.embedding)
 * @param {number[]} embedding - 512-dim query embedding
 * @param {Array<{ id: string, name: string, isStaff: boolean, embedding?: number[], embeddings?: Array<number[]|{ vector: number[] }> }>} knownProfiles 
 * @param {number} threshold - Match threshold (default 0.50)
 * @returns {{ matched: boolean, profile: object|null, similarity: number }}
 */
export function identifyFace(embedding, knownProfiles = [], threshold = 0.50) {
  if (!embedding || !knownProfiles || knownProfiles.length === 0) {
    return { matched: false, profile: null, similarity: 0 };
  }

  let bestMatch = null;
  let maxSim = -1;

  for (const profile of knownProfiles) {
    const candidateVectors = [];
    if (Array.isArray(profile.embeddings) && profile.embeddings.length > 0) {
      for (const item of profile.embeddings) {
        if (Array.isArray(item)) {
          candidateVectors.push(item);
        } else if (item && Array.isArray(item.vector)) {
          candidateVectors.push(item.vector);
        }
      }
    }
    if (candidateVectors.length === 0 && Array.isArray(profile.embedding)) {
      candidateVectors.push(profile.embedding);
    }

    if (candidateVectors.length === 0) continue;

    const sim = Math.max(...candidateVectors.map(v => computeCosineSimilarity(embedding, v)));
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
