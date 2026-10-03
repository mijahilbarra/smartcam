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

    allDocs = docs;
    photoCountBadge.textContent = `${docs.length} ${docs.length === 1 ? 'captura' : 'capturas'}`;

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

// Initialize
initPromptListener();
initPaginationListeners();
initPhotosListener();
