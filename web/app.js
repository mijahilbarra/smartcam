import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { 
  getFirestore, 
  collection, 
  doc, 
  onSnapshot, 
  setDoc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { 
  getStorage, 
  ref, 
  getDownloadURL 
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

// Firebase Web Configuration for skip-bigotes
const firebaseConfig = {
  projectId: "skip-bigotes",
  appId: "1:1033289992711:web:4a490808d63b933a08f8a2",
  storageBucket: "skip-bigotes.firebasestorage.app",
  apiKey: "AIzaSyB0ihpyYO-jBnsYF4x9Uy77WbgpwqVPYUo",
  authDomain: "skip-bigotes.firebaseapp.com",
  messagingSenderId: "1033289992711",
  measurementId: "G-3369KSG3CS"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);

// Backend API URL
let storedUrl = localStorage.getItem("CAMERA_CATCHER_API_URL");
if (storedUrl && storedUrl.includes("run.app")) {
  localStorage.removeItem("CAMERA_CATCHER_API_URL");
  storedUrl = null;
}
let BACKEND_URL = storedUrl || "http://localhost:8085";

// Cache resolved image URLs from Storage SDK to avoid redundant network calls
const urlCache = new Map();

// Elements
const promptInput = document.getElementById("promptInput");
const intervalInput = document.getElementById("intervalInput");
const savePromptBtn = document.getElementById("savePromptBtn");
const promptStatus = document.getElementById("promptStatus");
const captureBtn = document.getElementById("captureBtn");
const photosTableBody = document.getElementById("photosTableBody");
const photoCountBadge = document.getElementById("photoCount");

// Modal Elements
const imageModal = document.getElementById("imageModal");
const closeModalBtn = document.getElementById("closeModalBtn");
const modalImage = document.getElementById("modalImage");
const modalTimestamp = document.getElementById("modalTimestamp");
const modalAnalysis = document.getElementById("modalAnalysis");
const modalClientsContainer = document.getElementById("modalClientsContainer");
const modalClientsList = document.getElementById("modalClientsList");

/**
 * Format timestamp into local Spanish readable format
 */
function formatDateTime(timestampOrIso, epoch) {
  let date;
  if (epoch) {
    date = new Date(epoch);
  } else if (timestampOrIso?.toDate) {
    date = timestampOrIso.toDate();
  } else if (typeof timestampOrIso === "string") {
    date = new Date(timestampOrIso);
  } else {
    date = new Date();
  }

  return new Intl.DateTimeFormat("es-PE", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "America/Lima"
  }).format(date);
}

/**
 * Resolve download URL for an image path using Firebase Storage Client SDK
 */
async function resolveStorageUrl(imageStoragePath) {
  if (!imageStoragePath) return "";
  if (urlCache.has(imageStoragePath)) {
    return urlCache.get(imageStoragePath);
  }
  try {
    const storageRef = ref(storage, imageStoragePath);
    const url = await getDownloadURL(storageRef);
    urlCache.set(imageStoragePath, url);
    return url;
  } catch (err) {
    console.warn(`[Storage] getDownloadURL falló para ${imageStoragePath}, usando fallback público:`, err);
    const encodedPath = encodeURIComponent(imageStoragePath);
    const fallbackUrl = `https://firebasestorage.googleapis.com/v0/b/${firebaseConfig.storageBucket}/o/${encodedPath}?alt=media`;
    urlCache.set(imageStoragePath, fallbackUrl);
    return fallbackUrl;
  }
}

/**
 * 1. Listen and update dynamic prompt & interval from camera_catcher/prompt
 */
function initPromptListener() {
  const promptDocRef = doc(db, "camera_catcher", "prompt");
  
  onSnapshot(promptDocRef, (snap) => {
    if (snap.exists()) {
      const data = snap.data();
      promptInput.value = data?.default || "Describe what do you see in the image";
      if (intervalInput) {
        intervalInput.value = data?.intervalMinutes !== undefined ? data.intervalMinutes : 15;
      }
    } else {
      promptInput.value = "Describe what do you see in the image";
      if (intervalInput) intervalInput.value = 15;
      // Auto initialize if missing
      setDoc(promptDocRef, { 
        default: "Describe what do you see in the image",
        intervalMinutes: 15
      }, { merge: true });
    }
  }, (err) => {
    console.error("[Firestore] Error reading config/prompt:", err);
  });

  savePromptBtn.addEventListener("click", async () => {
    const newPrompt = promptInput.value.trim();
    if (!newPrompt) return;

    const intervalVal = parseFloat(intervalInput?.value);
    const validInterval = (!isNaN(intervalVal) && intervalVal > 0) ? intervalVal : 15;

    savePromptBtn.disabled = true;
    savePromptBtn.innerText = "Guardando...";
    try {
      await setDoc(promptDocRef, { 
        default: newPrompt,
        intervalMinutes: validInterval,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      showStatus(`¡Configuración guardada! (Intervalo: ${validInterval} min)`, "success");
    } catch (err) {
      console.error("[Firestore] Error saving config:", err);
      showStatus("Error al guardar: " + err.message, "error");
    } finally {
      savePromptBtn.disabled = false;
      savePromptBtn.innerText = "Guardar";
    }
  });
}

function showStatus(msg, type) {
  promptStatus.textContent = msg;
  promptStatus.className = `status-badge ${type}`;
  setTimeout(() => {
    promptStatus.className = "status-badge hidden";
  }, 4000);
}

/**
 * 2. Real-time subscription to camera_catcher/photos/photos/<doc>
 */
function initPhotosListener() {
  const photosColRef = collection(db, "camera_catcher", "photos", "photos");

  onSnapshot(photosColRef, async (snapshot) => {
    const docs = [];
    snapshot.forEach((d) => {
      docs.push({ id: d.id, ...d.data() });
    });

    // Sort by timestamp / epoch descending (newest first)
    docs.sort((a, b) => {
      const timeA = a.epoch || (a.timestamp?.toMillis ? a.timestamp.toMillis() : 0);
      const timeB = b.epoch || (b.timestamp?.toMillis ? b.timestamp.toMillis() : 0);
      return timeB - timeA;
    });

    photoCountBadge.textContent = `${docs.length} ${docs.length === 1 ? 'captura' : 'capturas'}`;

    if (docs.length === 0) {
      photosTableBody.innerHTML = `
        <tr>
          <td colspan="4" class="text-center py-8 text-muted">
            No se han registrado capturas aún. Haz clic en "Capturar Ahora" para iniciar la primera.
          </td>
        </tr>
      `;
      return;
    }

    renderTableRows(docs);
  }, (err) => {
    console.error("[Firestore] Error listening to photos:", err);
    photosTableBody.innerHTML = `
      <tr>
        <td colspan="4" class="text-center py-8 text-muted" style="color: var(--danger)">
          Error al cargar capturas: ${err.message}
        </td>
      </tr>
    `;
  });
}

/**
 * Render the table rows and resolve images asynchronously
 */
async function renderTableRows(docs) {
  const rowsHtml = docs.map((docData, index) => {
    const dateStr = formatDateTime(docData.timestamp || docData.createdAt, docData.epoch);
    const analysisText = escapeHtml(docData.analysis || "Sin análisis");
    const promptUsed = docData.promptUsed ? `<div class="analysis-prompt-used">Prompt: "${escapeHtml(docData.promptUsed)}"</div>` : "";
    
    // Render ML quadrant tags if present
    let mlTagsHtml = "";
    if (docData.ml?.quadrants && Array.isArray(docData.ml.quadrants)) {
      mlTagsHtml = `<div class="ml-quadrants-tags" style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px;">` +
        docData.ml.quadrants.map(q => {
          const bg = q.color || "#007BFF";
          return `<span style="display: inline-block; font-size: 0.70rem; font-weight: 600; padding: 2px 6px; border-radius: 4px; background: ${bg}22; color: ${bg}; border: 1px solid ${bg}66;">${escapeHtml(q.label)}: ${escapeHtml(q.status || 'ok')}</span>`;
        }).join("") +
      `</div>`;
    }

    // Render client crop preview chips if present
    let clientChipsHtml = "";
    if (docData.clients && Array.isArray(docData.clients) && docData.clients.length > 0) {
      clientChipsHtml = `
        <div class="clients-container" style="display: flex; align-items: center; gap: 8px; margin-top: 8px;">
          <span style="font-size: 0.75rem; color: #32DC32; font-weight: 600;">👤 Cliente(s) en sillón:</span>
          <div style="display: flex; gap: 6px; flex-wrap: wrap;">
            ${docData.clients.map((c, cIdx) => `
              <div class="client-chip" style="display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; background: rgba(50, 220, 50, 0.12); border: 1px solid rgba(50, 220, 50, 0.35); border-radius: 6px;">
                <img id="thumb-client-${index}-${cIdx}" class="hidden" style="width: 28px; height: 28px; object-fit: cover; border-radius: 4px; border: 1px solid #32DC32; cursor: pointer;" alt="Cliente sentado" />
                <span style="font-size: 0.70rem; color: #32DC32; font-weight: 600;">Cliente #${cIdx + 1}</span>
              </div>
            `).join("")}
          </div>
        </div>
      `;
    }

    const storagePath = docData.annotatedStoragePath || docData.imageStoragePath || "";

    return `
      <tr data-id="${docData.id}" data-path="${storagePath}">
        <td>
          <div class="thumbnail-wrap" id="thumb-wrap-${index}">
            <div class="thumbnail-placeholder" id="thumb-load-${index}">
              <div class="spinner-small"></div>
            </div>
            <img id="thumb-img-${index}" class="hidden" alt="Miniatura" />
          </div>
        </td>
        <td>
          <div class="timestamp-cell">${dateStr}</div>
        </td>
        <td>
          <div class="analysis-cell">${analysisText}${mlTagsHtml}${clientChipsHtml}${promptUsed}</div>
        </td>
        <td>
          <button class="btn btn-secondary view-btn" style="padding: 6px 10px; font-size: 0.75rem;" data-index="${index}">
            Ver HD
          </button>
        </td>
      </tr>
    `;
  }).join("");

  photosTableBody.innerHTML = rowsHtml;

  // Resolve images in parallel using Firebase Storage Client SDK
  docs.forEach(async (docData, index) => {
    const imgEl = document.getElementById(`thumb-img-${index}`);
    const loadEl = document.getElementById(`thumb-load-${index}`);
    const wrapEl = document.getElementById(`thumb-wrap-${index}`);

    const displayPath = docData.annotatedStoragePath || docData.imageStoragePath;
    if (!imgEl || !displayPath) return;

    const url = await resolveStorageUrl(displayPath);
    if (url) {
      imgEl.src = url;
      imgEl.onload = () => {
        loadEl?.classList.add("hidden");
        imgEl.classList.remove("hidden");
      };
      
      const openModalHandler = () => {
        openModal(url, formatDateTime(docData.timestamp || docData.createdAt, docData.epoch), docData.analysis, docData.promptUsed, docData.clients || []);
      };

      wrapEl?.addEventListener("click", openModalHandler);
      
      const viewBtn = document.querySelector(`.view-btn[data-index="${index}"]`);
      viewBtn?.addEventListener("click", openModalHandler);
    } else {
      if (loadEl) loadEl.innerHTML = `<span style="font-size: 0.65rem; color: var(--danger)">Error</span>`;
    }

    // Resolve client crop thumbnails
    if (docData.clients && Array.isArray(docData.clients)) {
      docData.clients.forEach(async (c, cIdx) => {
        const clientImgEl = document.getElementById(`thumb-client-${index}-${cIdx}`);
        if (clientImgEl && c.storagePath) {
          const clientUrl = await resolveStorageUrl(c.storagePath);
          if (clientUrl) {
            clientImgEl.src = clientUrl;
            clientImgEl.classList.remove("hidden");
            clientImgEl.addEventListener("click", (e) => {
              e.stopPropagation();
              openModal(clientUrl, `${formatDateTime(docData.timestamp || docData.createdAt, docData.epoch)} • Cliente #${cIdx + 1}`, `Recorte de cliente sentado en sillón de barbero.`, null, []);
            });
          }
        }
      });
    }
  });
}

async function openModal(imgUrl, dateStr, analysis, promptUsed, clients = []) {
  modalImage.src = imgUrl;
  modalTimestamp.textContent = `📅 ${dateStr}`;
  modalAnalysis.innerHTML = `<strong>Detalles de Captura y ML:</strong><br>${escapeHtml(analysis)}` +
    (promptUsed ? `<br><br><small class="text-muted">Prompt utilizado: "${escapeHtml(promptUsed)}"</small>` : "");

  // Populate client crops in modal if available
  if (modalClientsContainer && modalClientsList) {
    if (clients && clients.length > 0) {
      modalClientsContainer.classList.remove("hidden");
      modalClientsList.innerHTML = `<div class="spinner-small"></div>`;
      
      const itemsHtml = await Promise.all(clients.map(async (c, i) => {
        const cUrl = c.storagePath ? await resolveStorageUrl(c.storagePath) : "";
        return `
          <div style="text-align: center; background: #0f172a; padding: 8px; border-radius: 8px; border: 1px solid var(--border);">
            <img src="${cUrl}" style="max-width: 140px; max-height: 140px; object-fit: cover; border-radius: 6px; border: 2px solid #32DC32;" alt="Cliente en corte" />
            <div style="margin-top: 4px; font-size: 0.72rem; color: #32DC32; font-weight: 600;">Cliente #${i + 1}</div>
          </div>
        `;
      }));
      modalClientsList.innerHTML = itemsHtml.join("");
    } else {
      modalClientsContainer.classList.add("hidden");
      modalClientsList.innerHTML = "";
    }
  }

  imageModal.classList.remove("hidden");
}

function closeModal() {
  imageModal.classList.add("hidden");
  modalImage.src = "";
}

closeModalBtn.addEventListener("click", closeModal);
imageModal.querySelector(".modal-overlay").addEventListener("click", closeModal);

/**
 * 3. Handle "Capturar Ahora" button via Firestore Realtime Command
 */
captureBtn.addEventListener("click", async () => {
  captureBtn.disabled = true;
  const originalHtml = captureBtn.innerHTML;
  captureBtn.innerHTML = `
    <div class="spinner-small"></div>
    <span>Capturando fotograma en la nube...</span>
  `;

  try {
    console.log(`[Capture] Enviando señal de captura a Firestore (camera_catcher/commands)...`);
    await setDoc(doc(db, "camera_catcher", "commands"), {
      action: "capture",
      requestedAt: Date.now()
    });
    console.log("[Capture] Comando enviado con éxito a la VM en Google Cloud.");
  } catch (err) {
    console.error("[Capture] Trigger error:", err);
    alert(`Error al solicitar captura: ${err.message}`);
  } finally {
    // Mantener estado activo por 10 segundos mientras la VM procesa
    setTimeout(() => {
      captureBtn.disabled = false;
      captureBtn.innerHTML = originalHtml;
    }, 10000);
  }
});

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Global hook to configure backend URL if needed
window.setBackendUrl = (url) => {
  BACKEND_URL = url;
  localStorage.setItem("CAMERA_CATCHER_API_URL", url);
  console.log("Backend URL updated to:", BACKEND_URL);
};

// Initialize
initPromptListener();
initPhotosListener();
