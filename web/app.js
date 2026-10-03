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

// Pagination State & Elements
let allDocs = [];
let currentPage = 1;
let pageSize = 10;

const paginationContainer = document.getElementById("paginationContainer");
const paginationRangeText = document.getElementById("paginationRangeText");
const pageSizeSelect = document.getElementById("pageSizeSelect");
const firstPageBtn = document.getElementById("firstPageBtn");
const prevPageBtn = document.getElementById("prevPageBtn");
const nextPageBtn = document.getElementById("nextPageBtn");
const lastPageBtn = document.getElementById("lastPageBtn");
const paginationPages = document.getElementById("paginationPages");

// Modal Elements
const imageModal = document.getElementById("imageModal");
const closeModalBtn = document.getElementById("closeModalBtn");
const modalDocId = document.getElementById("modalDocId");
const copyDocIdBtn = document.getElementById("copyDocIdBtn");
const copyFeedback = document.getElementById("copyFeedback");
const modalMetaDocId = document.getElementById("modalMetaDocId");
const modalMetaFirestorePath = document.getElementById("modalMetaFirestorePath");
const modalTimestamp = document.getElementById("modalTimestamp");
const modalAnalysis = document.getElementById("modalAnalysis");
const modalClientsContainer = document.getElementById("modalClientsContainer");
const modalClientsList = document.getElementById("modalClientsList");
const modalOriginalImage = document.getElementById("modalOriginalImage");
const modalOriginalLoading = document.getElementById("modalOriginalLoading");
const modalOriginalLink = document.getElementById("modalOriginalLink");
const modalAnnotatedImage = document.getElementById("modalAnnotatedImage");
const modalAnnotatedLoading = document.getElementById("modalAnnotatedLoading");
const modalAnnotatedLink = document.getElementById("modalAnnotatedLink");

let currentModalDocId = "";

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
      if (data?.workStartTime && data?.workEndTime) {
        const [sH, sM] = data.workStartTime.split(":").map(Number);
        const [eH, eM] = data.workEndTime.split(":").map(Number);
        const diffH = (eH + (eM || 0) / 60) - (sH + (sM || 0) / 60);
        if (diffH > 0 && diffH <= 24) currentActiveHours = diffH;
      }
      updateCostMetrics(allDocs.length);
    } else {
      promptInput.value = "Describe what do you see in the image";
      if (intervalInput) intervalInput.value = 15;
      // Auto initialize if missing
      setDoc(promptDocRef, { 
        default: "Describe what do you see in the image",
        intervalMinutes: 15
      }, { merge: true });
      updateCostMetrics(allDocs.length);
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
      updateCostMetrics(allDocs.length);
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

    allDocs = docs;
    updateCostMetrics(allDocs.length);

    if (docs.length === 0) {
      if (paginationContainer) paginationContainer.classList.add("hidden");
      photosTableBody.innerHTML = `
        <tr>
          <td colspan="4" class="text-center py-8 text-muted">
            No se han registrado capturas aún. Haz clic en "Capturar Ahora" para iniciar la primera.
          </td>
        </tr>
      `;
      return;
    }

    updatePaginationUI();
  }, (err) => {
    console.error("[Firestore] Error listening to photos:", err);
    if (paginationContainer) paginationContainer.classList.add("hidden");
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
 * Update pagination UI state and render the current page of rows
 */
function updatePaginationUI() {
  const total = allDocs.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  if (currentPage > totalPages) {
    currentPage = totalPages;
  }
  if (currentPage < 1) {
    currentPage = 1;
  }

  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, total);
  const pagedDocs = allDocs.slice(startIndex, endIndex);

  if (paginationContainer) {
    if (total === 0) {
      paginationContainer.classList.add("hidden");
    } else {
      paginationContainer.classList.remove("hidden");
    }
  }

  if (paginationRangeText) {
    paginationRangeText.textContent = total > 0 
      ? `Mostrando ${startIndex + 1} - ${endIndex} de ${total} capturas`
      : "Sin capturas";
  }

  if (paginationPages) {
    paginationPages.textContent = `Página ${currentPage} de ${totalPages}`;
  }

  if (firstPageBtn) firstPageBtn.disabled = currentPage <= 1;
  if (prevPageBtn) prevPageBtn.disabled = currentPage <= 1;
  if (nextPageBtn) nextPageBtn.disabled = currentPage >= totalPages;
  if (lastPageBtn) lastPageBtn.disabled = currentPage >= totalPages;

  renderTableRows(pagedDocs);
}

function initPaginationListeners() {
  firstPageBtn?.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage = 1;
      updatePaginationUI();
    }
  });

  prevPageBtn?.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      updatePaginationUI();
    }
  });

  nextPageBtn?.addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil(allDocs.length / pageSize));
    if (currentPage < totalPages) {
      currentPage++;
      updatePaginationUI();
    }
  });

  lastPageBtn?.addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil(allDocs.length / pageSize));
    if (currentPage < totalPages) {
      currentPage = totalPages;
      updatePaginationUI();
    }
  });

  pageSizeSelect?.addEventListener("change", (e) => {
    const val = parseInt(e.target.value, 10);
    if (!isNaN(val) && val > 0) {
      pageSize = val;
      currentPage = 1;
      updatePaginationUI();
    }
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

    const clients = (Array.isArray(docData.clients) && docData.clients.length > 0) ? docData.clients : [];

    // Thumbnail column: client fragment, or if no client, DO NOT place photo
    let thumbCellHtml = "";
    if (clients.length === 0) {
      thumbCellHtml = `
        <div class="no-client-wrap">
          <span class="no-client-badge" title="No se detectó cliente sentado en este fotograma">
            <span class="no-client-icon">🚫</span> Sin cliente
          </span>
        </div>
      `;
    } else if (clients.length === 1) {
      thumbCellHtml = `
        <div class="client-thumb-single-wrap" id="client-thumb-wrap-${index}-0" title="Ver detalle de captura">
          <div class="thumbnail-placeholder" id="client-thumb-load-${index}-0">
            <div class="spinner-small"></div>
          </div>
          <img id="client-thumb-img-${index}-0" class="hidden client-thumb-img" alt="Fragmento de cliente sentado" />
          <span class="client-thumb-label">👤 Cliente</span>
        </div>
      `;
    } else {
      // Multiple seated clients detected
      thumbCellHtml = `
        <div class="client-thumbs-multi-wrap" title="Ver detalle de captura">
          ${clients.map((c, cIdx) => `
            <div class="client-thumb-multi-item" id="client-thumb-wrap-${index}-${cIdx}" title="Cliente #${cIdx + 1}">
              <div class="thumbnail-placeholder" id="client-thumb-load-${index}-${cIdx}">
                <div class="spinner-small"></div>
              </div>
              <img id="client-thumb-img-${index}-${cIdx}" class="hidden client-thumb-img" alt="Cliente #${cIdx + 1}" />
              <span class="client-thumb-sublabel">#${cIdx + 1}</span>
            </div>
          `).join("")}
        </div>
      `;
    }

    // Render client crop preview chips in analysis cell if present
    let clientChipsHtml = "";
    if (clients.length > 0) {
      clientChipsHtml = `
        <div class="clients-container" style="display: flex; align-items: center; gap: 8px; margin-top: 8px;">
          <span style="font-size: 0.75rem; color: #32DC32; font-weight: 600;">👤 ${clients.length === 1 ? 'Cliente detectado' : `${clients.length} clientes detectados`}:</span>
          <div style="display: flex; gap: 6px; flex-wrap: wrap;">
            ${clients.map((c, cIdx) => `
              <div class="client-chip" style="display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; background: rgba(50, 220, 50, 0.12); border: 1px solid rgba(50, 220, 50, 0.35); border-radius: 6px;">
                <span style="font-size: 0.70rem; color: #32DC32; font-weight: 600;">Cliente #${cIdx + 1} (${escapeHtml(c.status || "en_corte")})</span>
              </div>
            `).join("")}
          </div>
        </div>
      `;
    }

    return `
      <tr data-id="${docData.id}">
        <td>
          ${thumbCellHtml}
        </td>
        <td>
          <div class="timestamp-cell">
            <div style="font-weight: 500;">${dateStr}</div>
            <div class="doc-id-row-tag" title="ID de documento en Firestore para ML">
              Doc ID: <code>${escapeHtml(docData.id)}</code>
            </div>
          </div>
        </td>
        <td>
          <div class="analysis-cell">${analysisText}${mlTagsHtml}${clientChipsHtml}${promptUsed}</div>
        </td>
        <td>
          <button class="btn btn-secondary view-btn" style="padding: 6px 12px; font-size: 0.75rem;" data-index="${index}">
            Ver Detalle
          </button>
        </td>
      </tr>
    `;
  }).join("");

  photosTableBody.innerHTML = rowsHtml;

  // Asynchronously resolve client crop thumbnails and attach modal triggers
  docs.forEach((docData, index) => {
    const clients = (Array.isArray(docData.clients) && docData.clients.length > 0) ? docData.clients : [];

    // Resolve client crop thumbnails if any
    clients.forEach(async (c, cIdx) => {
      const imgEl = document.getElementById(`client-thumb-img-${index}-${cIdx}`);
      const loadEl = document.getElementById(`client-thumb-load-${index}-${cIdx}`);
      const wrapEl = document.getElementById(`client-thumb-wrap-${index}-${cIdx}`);

      if (c.storagePath) {
        const clientUrl = await resolveStorageUrl(c.storagePath);
        if (clientUrl && imgEl) {
          imgEl.src = clientUrl;
          imgEl.onload = () => {
            loadEl?.classList.add("hidden");
            imgEl.classList.remove("hidden");
          };
          imgEl.onerror = () => {
            if (loadEl) loadEl.innerHTML = `<span style="font-size: 0.65rem; color: var(--danger)">Error</span>`;
          };
        }
      }

      wrapEl?.addEventListener("click", () => {
        openModal(docData);
      });
    });

    // Attach "Ver Detalle" button handler
    const viewBtn = document.querySelector(`.view-btn[data-index="${index}"]`);
    viewBtn?.addEventListener("click", () => {
      openModal(docData);
    });
  });
}

/**
 * Open detail modal showing original photo and annotated photo side-by-side
 */
async function openModal(docData) {
  currentModalDocId = docData.id || "";
  if (modalDocId) modalDocId.textContent = currentModalDocId;
  if (modalMetaDocId) modalMetaDocId.textContent = currentModalDocId;
  if (modalMetaFirestorePath) modalMetaFirestorePath.textContent = `camera_catcher/photos/photos/${currentModalDocId}`;

  const dateStr = formatDateTime(docData.timestamp || docData.createdAt, docData.epoch);
  modalTimestamp.textContent = `📅 ${dateStr}`;
  modalAnalysis.innerHTML = `<strong>Resumen y Cuadrantes ML:</strong><br>${escapeHtml(docData.analysis || "Sin análisis")}` +
    (docData.promptUsed ? `<br><br><small class="text-muted">Prompt utilizado: "${escapeHtml(docData.promptUsed)}"</small>` : "");

  // Reset loading states for both panes
  modalOriginalImage.classList.add("hidden");
  modalOriginalImage.src = "";
  modalOriginalLoading.classList.remove("hidden");
  modalOriginalLoading.innerHTML = `<div class="spinner-small"></div> <span>Cargando original...</span>`;
  modalOriginalLink.href = "#";

  modalAnnotatedImage.classList.add("hidden");
  modalAnnotatedImage.src = "";
  modalAnnotatedLoading.classList.remove("hidden");
  modalAnnotatedLoading.innerHTML = `<div class="spinner-small"></div> <span>Cargando foto con marcos...</span>`;
  modalAnnotatedLink.href = "#";

  imageModal.classList.remove("hidden");

  // 1. Resolve and display Foto Original (Left side)
  const originalPath = docData.imageStoragePath || docData.annotatedStoragePath;
  if (originalPath) {
    resolveStorageUrl(originalPath).then((url) => {
      if (url) {
        modalOriginalImage.src = url;
        modalOriginalLink.href = url;
        modalOriginalImage.onload = () => {
          modalOriginalLoading.classList.add("hidden");
          modalOriginalImage.classList.remove("hidden");
        };
        modalOriginalImage.onerror = () => {
          modalOriginalLoading.innerHTML = `<span style="color: var(--danger)">Error al cargar</span>`;
        };
      } else {
        modalOriginalLoading.innerHTML = `<span style="color: var(--danger)">No disponible</span>`;
      }
    });
  } else {
    modalOriginalLoading.innerHTML = `<span style="color: var(--text-muted)">Sin imagen original</span>`;
  }

  // 2. Resolve and display Foto con Marcos (Right side)
  const annotatedPath = docData.annotatedStoragePath || docData.imageStoragePath;
  if (annotatedPath) {
    resolveStorageUrl(annotatedPath).then((url) => {
      if (url) {
        modalAnnotatedImage.src = url;
        modalAnnotatedLink.href = url;
        modalAnnotatedImage.onload = () => {
          modalAnnotatedLoading.classList.add("hidden");
          modalAnnotatedImage.classList.remove("hidden");
        };
        modalAnnotatedImage.onerror = () => {
          modalAnnotatedLoading.innerHTML = `<span style="color: var(--danger)">Error al cargar</span>`;
        };
      } else {
        modalAnnotatedLoading.innerHTML = `<span style="color: var(--danger)">No disponible</span>`;
      }
    });
  } else {
    modalAnnotatedLoading.innerHTML = `<span style="color: var(--text-muted)">Sin imagen con marcos</span>`;
  }

  // 3. Populate client crop cards if seated clients were detected
  if (modalClientsContainer && modalClientsList) {
    const clients = docData.clients || [];
    if (clients.length > 0) {
      modalClientsContainer.classList.remove("hidden");
      modalClientsList.innerHTML = `<div class="spinner-small"></div> <span>Cargando recortes...</span>`;
      
      const itemsHtml = await Promise.all(clients.map(async (c, i) => {
        const cUrl = c.storagePath ? await resolveStorageUrl(c.storagePath) : "";
        return `
          <div class="modal-client-card">
            <a href="${cUrl}" target="_blank" rel="noopener noreferrer" title="Abrir recorte en tamaño completo">
              <img src="${cUrl}" class="modal-client-crop-img" alt="Cliente #${i + 1}" />
            </a>
            <div class="modal-client-meta">
              <span class="client-name">Cliente #${i + 1}</span>
              <span class="client-status">${escapeHtml(c.status || "en_corte")}</span>
              ${c.confidence ? `<span class="client-conf">${Math.round(c.confidence * 100)}% conf</span>` : ""}
            </div>
          </div>
        `;
      }));
      modalClientsList.innerHTML = itemsHtml.join("");
    } else {
      modalClientsContainer.classList.add("hidden");
      modalClientsList.innerHTML = "";
    }
  }
}

function closeModal() {
  imageModal.classList.add("hidden");
  modalOriginalImage.src = "";
  modalAnnotatedImage.src = "";
}

closeModalBtn.addEventListener("click", closeModal);
imageModal.querySelector(".modal-overlay").addEventListener("click", closeModal);

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !imageModal.classList.contains("hidden")) {
    closeModal();
  }
});

// Copy Doc ID handler
copyDocIdBtn?.addEventListener("click", async () => {
  if (!currentModalDocId) return;
  try {
    await navigator.clipboard.writeText(currentModalDocId);
    if (copyFeedback) {
      copyFeedback.classList.remove("hidden");
      setTimeout(() => {
        copyFeedback.classList.add("hidden");
      }, 2000);
    }
  } catch (err) {
    console.warn("Clipboard write failed, fallback prompt:", err);
    prompt("ID del documento (copiar con Ctrl+C / Cmd+C):", currentModalDocId);
  }
});

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

/* ==========================================================================
   Google Cloud Cost & Quotas Monitor Controller
   ========================================================================== */

// Cost Monitor Elements
const costMonitorHeader = document.getElementById("costMonitorHeader");
const toggleCostBtn = document.getElementById("toggleCostBtn");
const costMonitorBody = document.getElementById("costMonitorBody");
const costTrafficBadge = document.getElementById("costTrafficBadge");
const costTrafficText = document.getElementById("costTrafficText");
const storageUsedText = document.getElementById("storageUsedText");
const storageProgressFill = document.getElementById("storageProgressFill");
const storageQuotaTag = document.getElementById("storageQuotaTag");
const kpiPhotosCount = document.getElementById("kpiPhotosCount");
const kpiDailyStorage = document.getElementById("kpiDailyStorage");
const kpiDaysToLimit = document.getElementById("kpiDaysToLimit");
const storageCostBadge = document.getElementById("storageCostBadge");
const firestoreWritesText = document.getElementById("firestoreWritesText");
const firestoreProgressFill = document.getElementById("firestoreProgressFill");
const firestoreQuotaPercent = document.getElementById("firestoreQuotaPercent");

// Gemini API Elements
const geminiReqsText = document.getElementById("geminiReqsText");
const geminiProgressFill = document.getElementById("geminiProgressFill");
const geminiQuotaPercent = document.getElementById("geminiQuotaPercent");
const geminiCostBadge = document.getElementById("geminiCostBadge");

// Simulator Elements
const simIntervalRange = document.getElementById("simIntervalRange");
const simIntervalDisplay = document.getElementById("simIntervalDisplay");
const simCapturesVal = document.getElementById("simCapturesVal");
const simStorageMonthVal = document.getElementById("simStorageMonthVal");
const simOpsVal = document.getElementById("simOpsVal");
const simFirestoreVal = document.getElementById("simFirestoreVal");
const simGeminiVal = document.getElementById("simGeminiVal");
const simAlertBox = document.getElementById("simAlertBox");
const simAlertIcon = document.getElementById("simAlertIcon");
const simAlertText = document.getElementById("simAlertText");
const syncSimWithIntervalBtn = document.getElementById("syncSimWithIntervalBtn");
const simPresetBtns = document.querySelectorAll(".sim-preset-btn");

// Free Tier Constants for Google Cloud & AI Studio
const FREE_TIER = {
  storageMB: 5120, // 5.0 GB in MB
  storageOpsA: 5000, // Class A ops/month
  storageOpsB: 50000, // Class B ops/month
  firestoreWritesPerDay: 20000, // Document writes/day
  firestoreReadsPerDay: 50000, // Document reads/day
  geminiReqsPerDay: 1500, // Google AI Studio Free Tier RPD
  geminiRPM: 15, // Google AI Studio Free Tier RPM
  computeHoursPerMonth: 744, // 1 e2-micro covered
  diskGB: 30, // pd-standard 30GB/month
  priceStoragePerGB: 0.026, // $0.026 per GB/month after 5GB
  priceOpsAPer10k: 0.05, // $0.05 per 10,000 Class A ops
  priceIPv4PerHour: 0.005, // ~$0.005/hr in-use public IPv4 ($3.65/mo)
  priceGeminiFlashPerCall: 0.00008, // ~$0.00008 / call in pay-as-you-go
  approxMBPerCapture: 2.1 // 1MB raw + 1MB annotated + 0.1MB crops
};

// Base storage in MB measured from bucket skip-bigotes.firebasestorage.app
const BASE_STORAGE_MB = 144.3;

// Active working hours per day (loaded from camera_catcher/prompt, default 11:00 to 23:00 = 12h)
let currentActiveHours = 12;

function initCostMonitor() {
  if (!costMonitorHeader || !costMonitorBody) return;

  // 1. Toggle collapse/expand
  const savedCollapsed = localStorage.getItem("cost_monitor_collapsed") === "true";
  if (savedCollapsed) {
    costMonitorBody.classList.add("hidden");
    if (toggleCostBtn) toggleCostBtn.textContent = "Expandir ▸";
  }

  costMonitorHeader.addEventListener("click", (e) => {
    // If clicked inside interactive buttons or inputs, ignore
    if (e.target.closest("button") || e.target.closest("input")) return;
    toggleCostSection();
  });

  toggleCostBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleCostSection();
  });

  function toggleCostSection() {
    const isHidden = costMonitorBody.classList.toggle("hidden");
    if (toggleCostBtn) {
      toggleCostBtn.textContent = isHidden ? "Expandir ▸" : "Contraer ▾";
    }
    localStorage.setItem("cost_monitor_collapsed", isHidden);
  }

  // 2. Simulator Range & Presets Listener
  simIntervalRange?.addEventListener("input", () => {
    const val = parseFloat(simIntervalRange.value);
    updateSimulator(val);
    highlightPreset(val);
  });

  simPresetBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = parseFloat(btn.dataset.val);
      if (simIntervalRange) simIntervalRange.value = val;
      updateSimulator(val);
      highlightPreset(val);
    });
  });

  syncSimWithIntervalBtn?.addEventListener("click", () => {
    const currentInterval = parseFloat(intervalInput?.value) || 15;
    if (simIntervalRange) simIntervalRange.value = currentInterval;
    updateSimulator(currentInterval);
    highlightPreset(currentInterval);
  });

  // Listen for manual changes in the intervalInput field
  intervalInput?.addEventListener("input", () => {
    updateCostMetrics(allDocs.length);
  });

  // Initial simulation calculation
  const initInterval = parseFloat(intervalInput?.value) || 15;
  if (simIntervalRange) simIntervalRange.value = initInterval;
  updateSimulator(initInterval);
  highlightPreset(initInterval);
  updateCostMetrics(allDocs.length);
}

function highlightPreset(currentVal) {
  simPresetBtns.forEach((btn) => {
    const val = parseFloat(btn.dataset.val);
    if (Math.abs(val - currentVal) < 0.05) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });
}

/**
 * Recalculate and update the live KPI cards and traffic lights
 */
function updateCostMetrics(photoCount = 0) {
  const currentInterval = parseFloat(intervalInput?.value) || 15;
  
  // Storage usage calculation
  // Each doc in Firestore represents ~2.1MB stored in bucket
  const estimatedBucketMB = Math.max(BASE_STORAGE_MB, photoCount * FREE_TIER.approxMBPerCapture);
  const percentStorage = Math.min(100, (estimatedBucketMB / FREE_TIER.storageMB) * 100);

  if (storageUsedText) {
    storageUsedText.innerHTML = `${estimatedBucketMB.toFixed(1)} MB <small>/ 5.0 GB</small>`;
  }
  if (storageProgressFill) {
    storageProgressFill.style.width = `${Math.max(2, percentStorage.toFixed(1))}%`;
    if (percentStorage > 80) {
      storageProgressFill.classList.add("warn");
    } else {
      storageProgressFill.classList.remove("warn");
    }
  }
  if (storageQuotaTag) {
    if (percentStorage > 80) {
      storageQuotaTag.className = "kpi-tag warn";
      storageQuotaTag.textContent = `${percentStorage.toFixed(0)}% Cuota`;
    } else {
      storageQuotaTag.className = "kpi-tag free";
      storageQuotaTag.textContent = "En Cuota ($0)";
    }
  }
  if (kpiPhotosCount) {
    kpiPhotosCount.textContent = `${photoCount} fotos`;
  }

  // Rate of growth based on current active interval and working hours
  const capturesPerDay = currentInterval > 0 ? (currentActiveHours * 60) / currentInterval : 0;
  const mbPerDay = capturesPerDay * FREE_TIER.approxMBPerCapture;

  if (kpiDailyStorage) {
    kpiDailyStorage.textContent = `+${mbPerDay.toFixed(0)} MB / día`;
    kpiDailyStorage.title = `Calculado a ritmo de ${Math.round(capturesPerDay)} fotos/día en ${currentActiveHours}h de atención laboral`;
  }

  if (kpiDaysToLimit) {
    const remainingMB = Math.max(0, FREE_TIER.storageMB - estimatedBucketMB);
    const daysRemaining = mbPerDay > 0 ? Math.floor(remainingMB / mbPerDay) : 999;
    kpiDaysToLimit.title = `Calculado a ritmo de ${Math.round(capturesPerDay)} capturas/día (${currentActiveHours}h laborales) antes de superar los 5 GB gratuitos`;
    if (daysRemaining > 365) {
      kpiDaysToLimit.textContent = "> 1 año";
      kpiDaysToLimit.className = "text-success";
    } else if (daysRemaining > 30) {
      kpiDaysToLimit.textContent = `~${daysRemaining} días`;
      kpiDaysToLimit.className = "text-success";
    } else {
      kpiDaysToLimit.textContent = `¡${daysRemaining} días!`;
      kpiDaysToLimit.className = "text-danger";
    }
  }

  // Firestore daily writes
  const dailyWrites = Math.round(capturesPerDay);
  const writePercent = ((dailyWrites / FREE_TIER.firestoreWritesPerDay) * 100).toFixed(1);
  if (firestoreWritesText) {
    firestoreWritesText.innerHTML = `${dailyWrites.toLocaleString()} <small>/ 20,000 día</small>`;
  }
  if (firestoreProgressFill) {
    firestoreProgressFill.style.width = `${Math.max(1, Math.min(100, writePercent))}%`;
  }
  if (firestoreQuotaPercent) {
    firestoreQuotaPercent.textContent = `${writePercent}%`;
  }

  // Gemini AI daily requests (Google AI Studio Free Tier: 1,500 req/day)
  const dailyGeminiReqs = Math.round(capturesPerDay);
  const geminiPercent = ((dailyGeminiReqs / FREE_TIER.geminiReqsPerDay) * 100).toFixed(1);
  if (geminiReqsText) {
    geminiReqsText.innerHTML = `${dailyGeminiReqs.toLocaleString()} <small>/ 1,500 día</small>`;
  }
  if (geminiProgressFill) {
    geminiProgressFill.style.width = `${Math.max(1, Math.min(100, geminiPercent))}%`;
  }
  if (geminiQuotaPercent) {
    geminiQuotaPercent.textContent = `${geminiPercent}%`;
  }
  if (geminiCostBadge) {
    geminiCostBadge.textContent = "Costo API Key: $0.00/m";
  }

  // General Traffic Light Badge
  if (costTrafficBadge && costTrafficText) {
    if (currentInterval >= 10) {
      costTrafficBadge.className = "cost-badge cost-badge-safe";
      costTrafficText.textContent = "🟢 Seguro: $0.00 / mes (Always Free)";
    } else if (currentInterval >= 2) {
      costTrafficBadge.className = "cost-badge cost-badge-warn";
      costTrafficText.textContent = "🟡 Moderado: ~$0.10 - $0.50 / mes (Storage ops)";
    } else {
      costTrafficBadge.className = "cost-badge cost-badge-danger";
      costTrafficText.textContent = "🔴 Intensivo: Puede exceder 5 GB Storage";
    }
  }
}

/**
 * Dynamic Simulator calculations
 */
function updateSimulator(intervalMinutes) {
  if (intervalMinutes <= 0) return;

  if (simIntervalDisplay) {
    if (intervalMinutes < 1) {
      simIntervalDisplay.textContent = `${Math.round(intervalMinutes * 60)} segundos`;
    } else {
      simIntervalDisplay.textContent = `${intervalMinutes} minuto${intervalMinutes === 1 ? '' : 's'}`;
    }
  }

  const capturesPerDay = (24 * 60) / intervalMinutes;
  const capturesPerMonth = capturesPerDay * 30;

  // 2 files per capture in storage (raw + annotated) + optional crop
  const opsStorageMonth = capturesPerMonth * 2;
  const storageMonthMB = capturesPerMonth * FREE_TIER.approxMBPerCapture;
  const storageMonthGB = storageMonthMB / 1024;

  if (simCapturesVal) {
    simCapturesVal.textContent = `${Math.round(capturesPerDay).toLocaleString()} / día • ${Math.round(capturesPerMonth).toLocaleString()} / mes`;
  }

  if (simStorageMonthVal) {
    simStorageMonthVal.textContent = `~${storageMonthGB.toFixed(1)} GB / mes`;
  }

  if (simOpsVal) {
    const opsQuotaPercent = ((opsStorageMonth / FREE_TIER.storageOpsA) * 100).toFixed(0);
    simOpsVal.textContent = `~${Math.round(opsStorageMonth).toLocaleString()} (${opsQuotaPercent}% de 5k/mes)`;
  }

  if (simFirestoreVal) {
    const fsPercent = ((capturesPerDay / FREE_TIER.firestoreWritesPerDay) * 100).toFixed(1);
    simFirestoreVal.textContent = `${Math.round(capturesPerDay).toLocaleString()} / 20k día (${fsPercent}%)`;
  }

  if (simGeminiVal) {
    const paygCost = (capturesPerMonth * FREE_TIER.priceGeminiFlashPerCall).toFixed(2);
    if (capturesPerDay <= FREE_TIER.geminiReqsPerDay) {
      simGeminiVal.innerHTML = `${Math.round(capturesPerDay).toLocaleString()} / día <span style="font-size: 0.72rem; color: #34d399;">(Free $0)</span>`;
    } else {
      simGeminiVal.innerHTML = `${Math.round(capturesPerDay).toLocaleString()} / día <span style="font-size: 0.72rem; color: #fbbf24;">(~$${paygCost}/m)</span>`;
    }
  }

  // Cost and alert evaluation
  if (simAlertBox && simAlertText && simAlertIcon) {
    if (intervalMinutes >= 10) {
      simAlertBox.className = "sim-alert sim-alert-info";
      simAlertIcon.textContent = "💡";
      simAlertText.innerHTML = `
        <strong>Excelente para producción (Costo: $0.00/mes):</strong> Con ${intervalMinutes} min, generas ~${storageMonthGB.toFixed(1)} GB/mes. 
        Mantienes todas las escrituras y lecturas 100% dentro de la capa gratuita perpetua de Google Cloud.
      `;
    } else if (intervalMinutes >= 2) {
      const excessOps = Math.max(0, opsStorageMonth - FREE_TIER.storageOpsA);
      const costOps = (excessOps / 10000) * FREE_TIER.priceOpsAPer10k;
      simAlertBox.className = "sim-alert sim-alert-warn";
      simAlertIcon.textContent = "⚠️";
      simAlertText.innerHTML = `
        <strong>Consumo moderado:</strong> Las operaciones de subida a Storage (~${Math.round(opsStorageMonth).toLocaleString()}) superarán la cuota gratuita de 5,000/mes.
        El costo adicional por operaciones será mínimo (<strong>~$${costOps.toFixed(2)}/mes</strong>), pero vigila el espacio acumulado (~${storageMonthGB.toFixed(1)} GB/mes).
      `;
    } else {
      const excessOps = Math.max(0, opsStorageMonth - FREE_TIER.storageOpsA);
      const costOps = (excessOps / 10000) * FREE_TIER.priceOpsAPer10k;
      const excessGB = Math.max(0, storageMonthGB - 5.0);
      const costGB = excessGB * FREE_TIER.priceStoragePerGB;
      const totalEstimated = costOps + costGB;

      simAlertBox.className = "sim-alert sim-alert-danger";
      simAlertIcon.textContent = "🚨";
      simAlertText.innerHTML = `
        <strong>Intervalo de alta frecuencia:</strong> Generarás <strong>~${storageMonthGB.toFixed(0)} GB de fotos al mes</strong>.
        Excederá los 5.0 GB gratuitos de Cloud Storage rápidamente. Costo extra estimado si corre 24/7 sin rotación: <strong>~$${totalEstimated.toFixed(2)} / mes</strong>.
        Se recomienda solo para pruebas o con política de depuración automática.
      `;
    }
  }
}

// Initialize
initPromptListener();
initPaginationListeners();
initPhotosListener();
initCostMonitor();

