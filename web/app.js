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

// Settings Modal Elements
const openSettingsBtn = document.getElementById("openSettingsBtn");
const settingsModal = document.getElementById("settingsModal");
const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const cancelSettingsBtn = document.getElementById("cancelSettingsBtn");
const settingsOverlayBg = document.getElementById("settingsOverlayBg");
const workStartTimeInput = document.getElementById("workStartTimeInput");
const workEndTimeInput = document.getElementById("workEndTimeInput");
const workingHoursStatusBadge = document.getElementById("workingHoursStatusBadge");

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
 * Calculate if current Lima time is within working hours and update status badge
 */
function updateWorkingHoursStatus(startStr = "11:00", endStr = "23:00") {
  if (!workingHoursStatusBadge) return;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Lima",
      hour: "numeric",
      minute: "numeric",
      hour12: false
    }).formatToParts(new Date());

    let hour = 0, minute = 0;
    for (const p of parts) {
      if (p.type === "hour") hour = parseInt(p.value, 10);
      if (p.type === "minute") minute = parseInt(p.value, 10);
    }
    const currentMins = hour * 60 + minute;

    const [sH, sM] = String(startStr || "11:00").split(":").map(Number);
    const [eH, eM] = String(endStr || "23:00").split(":").map(Number);
    const startMins = sH * 60 + (sM || 0);
    const endMins = eH * 60 + (eM || 0);

    let isOpen = false;
    if (startMins <= endMins) {
      isOpen = currentMins >= startMins && currentMins < endMins;
    } else {
      isOpen = currentMins >= startMins || currentMins < endMins;
    }

    if (isOpen) {
      workingHoursStatusBadge.className = "status-hours-badge";
      workingHoursStatusBadge.textContent = "🟢 Dentro de horario de atención (Abierto)";
    } else {
      workingHoursStatusBadge.className = "status-hours-badge closed";
      workingHoursStatusBadge.textContent = "🌙 Fuera de horario de atención (Cerrado)";
    }
  } catch (err) {
    console.warn("[WorkingHours] Error evaluando estado de horario:", err);
  }
}

/**
 * 1. Listen and update dynamic prompt, interval & working hours from camera_catcher/prompt
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
      if (workStartTimeInput) {
        workStartTimeInput.value = data?.workStartTime || data?.workStart || "11:00";
      }
      if (workEndTimeInput) {
        workEndTimeInput.value = data?.workEndTime || data?.workEnd || "23:00";
      }
      updateWorkingHoursStatus(workStartTimeInput?.value, workEndTimeInput?.value);

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
      if (workStartTimeInput) workStartTimeInput.value = "11:00";
      if (workEndTimeInput) workEndTimeInput.value = "23:00";
      updateWorkingHoursStatus("11:00", "23:00");
      // Auto initialize if missing
      setDoc(promptDocRef, { 
        default: "Describe what do you see in the image",
        intervalMinutes: 15,
        workStartTime: "11:00",
        workEndTime: "23:00",
        timezone: "America/Lima"
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

    const startTimeVal = workStartTimeInput?.value || "11:00";
    const endTimeVal = workEndTimeInput?.value || "23:00";

    savePromptBtn.disabled = true;
    savePromptBtn.innerText = "Guardando...";
    try {
      await setDoc(promptDocRef, { 
        default: newPrompt,
        intervalMinutes: validInterval,
        workStartTime: startTimeVal,
        workEndTime: endTimeVal,
        timezone: "America/Lima",
        updatedAt: new Date().toISOString()
      }, { merge: true });
      showStatus(`¡Configuración guardada! (Horario: ${startTimeVal} - ${endTimeVal}, Intervalo: ${validInterval} min)`, "success");
      updateWorkingHoursStatus(startTimeVal, endTimeVal);
      updateCostMetrics(allDocs.length);
    } catch (err) {
      console.error("[Firestore] Error saving config:", err);
      showStatus("Error al guardar: " + err.message, "error");
    } finally {
      savePromptBtn.disabled = false;
      savePromptBtn.innerText = "Guardar Configuración";
    }
  });
}

function initSettingsModal() {
  openSettingsBtn?.addEventListener("click", () => {
    settingsModal?.classList.remove("hidden");
    updateWorkingHoursStatus(workStartTimeInput?.value, workEndTimeInput?.value);
  });

  const closeSettings = () => {
    settingsModal?.classList.add("hidden");
  };

  closeSettingsBtn?.addEventListener("click", closeSettings);
  cancelSettingsBtn?.addEventListener("click", closeSettings);
  settingsOverlayBg?.addEventListener("click", closeSettings);

  workStartTimeInput?.addEventListener("change", () => {
    updateWorkingHoursStatus(workStartTimeInput?.value, workEndTimeInput?.value);
  });
  workEndTimeInput?.addEventListener("change", () => {
    updateWorkingHoursStatus(workStartTimeInput?.value, workEndTimeInput?.value);
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
  if (e.key === "Escape") {
    if (!imageModal.classList.contains("hidden")) closeModal();
    if (settingsModal && !settingsModal.classList.contains("hidden")) settingsModal.classList.add("hidden");
    const calibratorModal = document.getElementById("calibratorModal");
    if (calibratorModal && !calibratorModal.classList.contains("hidden")) calibratorModal.classList.add("hidden");
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

/* ========================================================
   CALIBRADOR VISUAL DE CUADRANTES (ZONAS ROI)
   ======================================================== */
const openCalibratorBtn = document.getElementById("openCalibratorBtn");
const modalCalibrateWithPhotoBtn = document.getElementById("modalCalibrateWithPhotoBtn");
const calibratorModal = document.getElementById("calibratorModal");
const closeCalibratorBtn = document.getElementById("closeCalibratorBtn");
const calibratorOverlayBg = document.getElementById("calibratorOverlayBg");
const resetQuadrantsBtn = document.getElementById("resetQuadrantsBtn");
const addQuadrantBtn = document.getElementById("addQuadrantBtn");
const deleteSelectedQuadrantBtn = document.getElementById("deleteSelectedQuadrantBtn");
const saveQuadrantsBtn = document.getElementById("saveQuadrantsBtn");
const toolModeMove = document.getElementById("toolModeMove");
const toolModeDraw = document.getElementById("toolModeDraw");
const calibratorTipText = document.getElementById("calibratorTipText");
const calibratorStatusBadge = document.getElementById("calibratorStatusBadge");
const calibratorPhotoSelect = document.getElementById("calibratorPhotoSelect");
const calibratorLoading = document.getElementById("calibratorLoading");
const calibratorImg = document.getElementById("calibratorImg");
const calibratorOverlay = document.getElementById("calibratorOverlay");
const quadrantsList = document.getElementById("quadrantsList");
const quadrantCount = document.getElementById("quadrantCount");

let currentToolMode = "move"; // 'move' | 'draw'
let drawingContext = null;
let drawPreviewEl = null;

const DEFAULT_QUADRANTS = [
  {
    id: "puerta_entrada",
    name: "Entrada / Pasillo peatonal",
    boxNorm: [0.30, 0.40, 0.88, 0.60],
    type: "walking_zone",
    color: "#007BFF"
  },
  {
    id: "silla_barbero_puesto1",
    name: "Silla de barbero (Puesto 1)",
    boxNorm: [0.65, 0.80, 1.00, 1.00],
    type: "barber_chair",
    color: "#FFD700"
  },
  {
    id: "silla_barbero_puesto2",
    name: "Silla de barbero (Frente)",
    boxNorm: [0.80, 0.36, 1.00, 0.67],
    type: "barber_chair",
    color: "#FFD700"
  },
  {
    id: "silla_espera",
    name: "Silla de espera",
    boxNorm: [0.55, 0.73, 0.92, 0.90],
    type: "waiting_chair",
    color: "#D250DC"
  },
  {
    id: "zona_barbero",
    name: "Zona de trabajo de barbero",
    boxNorm: [0.45, 0.65, 0.95, 0.82],
    type: "barber_workstation",
    color: "#FF4500"
  }
];

let currentQuadrants = JSON.parse(JSON.stringify(DEFAULT_QUADRANTS));
let selectedQuadrantIndex = 0;
let dragContext = null;
let currentCalibratorDocId = null;

function showCalibratorStatus(msg, type = "info") {
  if (!calibratorStatusBadge) return;
  calibratorStatusBadge.className = `status-badge ${type}`;
  calibratorStatusBadge.textContent = msg;
  calibratorStatusBadge.classList.remove("hidden");
}

function hideCalibratorStatus() {
  if (calibratorStatusBadge) {
    calibratorStatusBadge.classList.add("hidden");
  }
}

/**
 * Real-time listener for camera_catcher/quadrants in Firestore
 */
function initQuadrantsListener() {
  const quadrantsDocRef = doc(db, "camera_catcher", "quadrants");
  onSnapshot(quadrantsDocRef, (snap) => {
    if (snap.exists()) {
      const data = snap.data();
      if (Array.isArray(data?.quadrants) && data.quadrants.length > 0) {
        currentQuadrants = JSON.parse(JSON.stringify(data.quadrants));
      } else if (data?.quadrants && typeof data.quadrants === "object") {
        currentQuadrants = Object.values(data.quadrants);
      }
      renderQuadrantsSidebar();
      renderBoxesOnStage();
    }
  }, (err) => {
    console.warn("[Calibrator] Error leyendo camera_catcher/quadrants:", err);
  });
}

/**
 * Populate reference photo selector dropdown
 */
function updateCalibratorPhotoSelectOptions(preselectDocId = null) {
  if (!calibratorPhotoSelect) return;
  calibratorPhotoSelect.innerHTML = "";

  const latestOpt = document.createElement("option");
  latestOpt.value = "latest";
  latestOpt.textContent = "⚡ Última captura disponible";
  calibratorPhotoSelect.appendChild(latestOpt);

  allDocs.forEach((docItem, idx) => {
    const opt = document.createElement("option");
    opt.value = docItem.id;
    const formatted = formatDateTime(docItem.timestamp, docItem.epoch);
    opt.textContent = `${idx + 1}. [${formatted}] - ${docItem.id}`;
    if (preselectDocId && docItem.id === preselectDocId) {
      opt.selected = true;
    }
    calibratorPhotoSelect.appendChild(opt);
  });

  if (preselectDocId && calibratorPhotoSelect.value !== preselectDocId) {
    // If not found yet, default to first option
    calibratorPhotoSelect.value = "latest";
  }
}

/**
 * Load reference photo into the calibrator stage
 */
async function loadCalibratorImage(targetDocId = null) {
  if (!calibratorImg || !calibratorLoading) return;
  calibratorLoading.classList.remove("hidden");
  calibratorImg.style.opacity = "0.3";

  let docToLoad = null;
  if (targetDocId && targetDocId !== "latest") {
    docToLoad = allDocs.find(d => d.id === targetDocId);
  }

  if (!docToLoad && allDocs.length > 0) {
    docToLoad = allDocs[0];
  }

  let photoUrl = "";
  if (docToLoad && docToLoad.imageStoragePath) {
    photoUrl = await resolveStorageUrl(docToLoad.imageStoragePath);
  }

  if (photoUrl) {
    calibratorImg.onload = () => {
      calibratorLoading.classList.add("hidden");
      calibratorImg.style.opacity = "1";
      renderBoxesOnStage();
    };
    calibratorImg.onerror = () => {
      calibratorLoading.innerHTML = `<span style="color: var(--danger)">Error cargando imagen</span>`;
    };
    calibratorImg.src = photoUrl;
  } else {
    calibratorLoading.innerHTML = `<span>No hay fotos capturadas aún para calibrar</span>`;
  }
}

function setToolMode(mode) {
  currentToolMode = mode;
  if (toolModeMove) toolModeMove.classList.toggle("active", mode === "move");
  if (toolModeDraw) toolModeDraw.classList.toggle("active", mode === "draw");
  if (calibratorOverlay) calibratorOverlay.classList.toggle("drawing-mode", mode === "draw");
  if (calibratorTipText) {
    calibratorTipText.innerHTML = mode === "draw"
      ? `✏️ <strong>Modo Dibujar activo:</strong> Haz clic y arrastra sobre la foto para crear la zona.`
      : `💡 <em>Arrastra cualquier caja para moverla o ajusta sus 4 esquinas.</em>`;
  }
}

function deleteQuadrant(idx) {
  if (currentQuadrants.length <= 1) {
    showCalibratorStatus("⚠️ Debe mantenerse al menos 1 zona definida.", "warn");
    setTimeout(() => hideCalibratorStatus(), 3000);
    return;
  }
  const removed = currentQuadrants.splice(idx, 1)[0];
  if (selectedQuadrantIndex >= currentQuadrants.length) {
    selectedQuadrantIndex = Math.max(0, currentQuadrants.length - 1);
  }
  renderQuadrantsSidebar();
  renderBoxesOnStage();
  showCalibratorStatus(`🗑️ Zona "${removed?.name || removed?.id}" eliminada. Pulsa "Guardar en Firebase" para persistir.`, "info");
  setTimeout(() => hideCalibratorStatus(), 4000);
}

/**
 * Render list of quadrants in the sidebar
 */
function renderQuadrantsSidebar() {
  if (!quadrantsList) return;
  if (quadrantCount) quadrantCount.textContent = currentQuadrants.length;
  quadrantsList.innerHTML = "";

  currentQuadrants.forEach((q, idx) => {
    const item = document.createElement("div");
    item.className = `q-item ${idx === selectedQuadrantIndex ? "active" : ""}`;
    item.dataset.index = idx;

    const [ymin, xmin, ymax, xmax] = q.boxNorm || [0, 0, 1, 1];

    item.innerHTML = `
      <div class="q-item-header">
        <div class="q-item-left">
          <input type="color" class="q-color-picker" value="${q.color || '#3b82f6'}" title="Cambiar color del cuadrante" />
          <input type="text" class="q-name-input" value="${q.name || q.id}" title="Editar nombre del cuadrante" />
        </div>
        <button class="q-delete-btn" title="Eliminar esta zona" style="font-size: 0.95rem; cursor: pointer; padding: 2px 6px;">🗑️</button>
      </div>
      <div class="q-coords-row">
        <span>Y: <strong class="q-coord-pill">${ymin.toFixed(2)} - ${ymax.toFixed(2)}</strong></span>
        <span>X: <strong class="q-coord-pill">${xmin.toFixed(2)} - ${xmax.toFixed(2)}</strong></span>
      </div>
    `;

    // Click item to select
    item.addEventListener("click", (e) => {
      if (e.target.classList.contains("q-name-input") || e.target.classList.contains("q-color-picker") || e.target.classList.contains("q-delete-btn")) {
        return;
      }
      selectedQuadrantIndex = idx;
      renderQuadrantsSidebar();
      renderBoxesOnStage();
    });

    // Name change
    const nameInput = item.querySelector(".q-name-input");
    nameInput.addEventListener("input", (e) => {
      q.name = e.target.value;
      updateBoxBadge(idx);
    });

    // Color change
    const colorPicker = item.querySelector(".q-color-picker");
    colorPicker.addEventListener("input", (e) => {
      q.color = e.target.value;
      updateBoxColor(idx);
    });

    // Delete
    const deleteBtn = item.querySelector(".q-delete-btn");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteQuadrant(idx);
      });
    }

    quadrantsList.appendChild(item);
  });
}

function updateBoxBadge(idx) {
  const box = calibratorOverlay?.querySelector(`.q-box[data-index="${idx}"]`);
  const badge = box?.querySelector(".q-box-badge");
  if (badge && currentQuadrants[idx]) {
    badge.textContent = currentQuadrants[idx].name || currentQuadrants[idx].id;
  }
}

function updateBoxColor(idx) {
  const box = calibratorOverlay?.querySelector(`.q-box[data-index="${idx}"]`);
  const badge = box?.querySelector(".q-box-badge");
  const q = currentQuadrants[idx];
  if (box && q) {
    box.style.borderColor = q.color;
    box.style.backgroundColor = hexToRgba(q.color, 0.20);
    if (badge) badge.style.backgroundColor = q.color;
  }
}

function hexToRgba(hex, alpha = 0.2) {
  if (!hex || !hex.startsWith("#")) return `rgba(59, 130, 246, ${alpha})`;
  let c = hex.substring(1);
  if (c.length === 3) c = c.split("").map(ch => ch + ch).join("");
  const num = parseInt(c, 16);
  return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
}

/**
 * Render interactive boxes and handles on the stage overlay
 */
function renderBoxesOnStage() {
  if (!calibratorOverlay || !calibratorImg || !calibratorImg.clientWidth) return;
  calibratorOverlay.innerHTML = "";

  const stageW = calibratorImg.clientWidth;
  const stageH = calibratorImg.clientHeight;

  // Drawing mode mousedown listener on overlay
  calibratorOverlay.onmousedown = (e) => {
    if (currentToolMode === "draw" || e.target === calibratorOverlay) {
      e.preventDefault();
      const rect = calibratorImg.getBoundingClientRect();
      const startX = e.clientX - rect.left;
      const startY = e.clientY - rect.top;

      drawingContext = {
        startX,
        startY,
        rect
      };

      if (!drawPreviewEl) {
        drawPreviewEl = document.createElement("div");
        drawPreviewEl.className = "q-draw-preview";
      }
      drawPreviewEl.style.left = `${startX}px`;
      drawPreviewEl.style.top = `${startY}px`;
      drawPreviewEl.style.width = "0px";
      drawPreviewEl.style.height = "0px";
      calibratorOverlay.appendChild(drawPreviewEl);
    }
  };

  currentQuadrants.forEach((q, idx) => {
    const [ymin, xmin, ymax, xmax] = q.boxNorm || [0, 0, 1, 1];
    const left = xmin * stageW;
    const top = ymin * stageH;
    const width = Math.max(20, (xmax - xmin) * stageW);
    const height = Math.max(20, (ymax - ymin) * stageH);

    const box = document.createElement("div");
    box.className = `q-box ${idx === selectedQuadrantIndex ? "active" : ""}`;
    box.dataset.index = idx;
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
    box.style.borderColor = q.color || "#00ff00";
    box.style.backgroundColor = hexToRgba(q.color || "#00ff00", 0.20);

    const badge = document.createElement("div");
    badge.className = "q-box-badge";
    badge.style.backgroundColor = q.color || "#00ff00";
    badge.textContent = q.name || q.id;
    box.appendChild(badge);

    // Resize Handles: NW, NE, SW, SE
    ["nw", "ne", "sw", "se"].forEach(pos => {
      const handle = document.createElement("div");
      handle.className = `q-handle q-handle-${pos}`;
      handle.dataset.handle = pos;
      box.appendChild(handle);
    });

    // Handle mousedown on box or resize handles
    box.addEventListener("mousedown", (e) => {
      if (currentToolMode === "draw") {
        return; // In draw mode, let the overlay trigger new rectangle drawing
      }
      e.stopPropagation();
      e.preventDefault();
      selectedQuadrantIndex = idx;
      renderQuadrantsSidebar();

      // Refresh active class on boxes
      calibratorOverlay.querySelectorAll(".q-box").forEach((b, bIdx) => {
        b.classList.toggle("active", bIdx === idx);
      });

      const handlePos = e.target.dataset.handle;
      const mode = handlePos || "move";

      dragContext = {
        mode,
        index: idx,
        startX: e.clientX,
        startY: e.clientY,
        stageW: calibratorImg.clientWidth,
        stageH: calibratorImg.clientHeight,
        origBox: [...q.boxNorm]
      };
    });

    calibratorOverlay.appendChild(box);
  });
}

function updateBoxPositionsDOM() {
  if (!calibratorOverlay || !calibratorImg) return;
  const stageW = calibratorImg.clientWidth;
  const stageH = calibratorImg.clientHeight;

  currentQuadrants.forEach((q, idx) => {
    const box = calibratorOverlay.querySelector(`.q-box[data-index="${idx}"]`);
    if (!box) return;
    const [ymin, xmin, ymax, xmax] = q.boxNorm;
    box.style.left = `${xmin * stageW}px`;
    box.style.top = `${ymin * stageH}px`;
    box.style.width = `${Math.max(15, (xmax - xmin) * stageW)}px`;
    box.style.height = `${Math.max(15, (ymax - ymin) * stageH)}px`;
  });
}

function updateSidebarCoordDisplay(idx) {
  const item = quadrantsList?.querySelector(`.q-item[data-index="${idx}"]`);
  if (!item || !currentQuadrants[idx]) return;
  const [ymin, xmin, ymax, xmax] = currentQuadrants[idx].boxNorm;
  const pills = item.querySelectorAll(".q-coord-pill");
  if (pills && pills.length >= 2) {
    pills[0].textContent = `${ymin.toFixed(2)} - ${ymax.toFixed(2)}`;
    pills[1].textContent = `${xmin.toFixed(2)} - ${xmax.toFixed(2)}`;
  }
}

/**
 * Setup Window Drag & Draw Listeners
 */
window.addEventListener("mousemove", (e) => {
  // 1. Drawing preview
  if (drawingContext) {
    const curX = Math.max(0, Math.min(drawingContext.rect.width, e.clientX - drawingContext.rect.left));
    const curY = Math.max(0, Math.min(drawingContext.rect.height, e.clientY - drawingContext.rect.top));

    const left = Math.min(drawingContext.startX, curX);
    const top = Math.min(drawingContext.startY, curY);
    const width = Math.abs(curX - drawingContext.startX);
    const height = Math.abs(curY - drawingContext.startY);

    if (drawPreviewEl) {
      drawPreviewEl.style.left = `${left}px`;
      drawPreviewEl.style.top = `${top}px`;
      drawPreviewEl.style.width = `${width}px`;
      drawPreviewEl.style.height = `${height}px`;
    }
    return;
  }

  // 2. Dragging/resizing existing boxes
  if (!dragContext) return;
  const dxNorm = (e.clientX - dragContext.startX) / dragContext.stageW;
  const dyNorm = (e.clientY - dragContext.startY) / dragContext.stageH;
  const [origYmin, origXmin, origYmax, origXmax] = dragContext.origBox;
  const q = currentQuadrants[dragContext.index];
  if (!q) return;

  const clamp = (v, min = 0, max = 1) => Math.max(min, Math.min(max, v));
  const minSize = 0.03;

  if (dragContext.mode === "move") {
    const w = origXmax - origXmin;
    const h = origYmax - origYmin;
    let newXmin = clamp(origXmin + dxNorm, 0, 1 - w);
    let newYmin = clamp(origYmin + dyNorm, 0, 1 - h);
    q.boxNorm = [
      Number(newYmin.toFixed(3)),
      Number(newXmin.toFixed(3)),
      Number((newYmin + h).toFixed(3)),
      Number((newXmin + w).toFixed(3))
    ];
  } else if (dragContext.mode === "nw") {
    let newYmin = clamp(origYmin + dyNorm, 0, origYmax - minSize);
    let newXmin = clamp(origXmin + dxNorm, 0, origXmax - minSize);
    q.boxNorm[0] = Number(newYmin.toFixed(3));
    q.boxNorm[1] = Number(newXmin.toFixed(3));
  } else if (dragContext.mode === "ne") {
    let newYmin = clamp(origYmin + dyNorm, 0, origYmax - minSize);
    let newXmax = clamp(origXmax + dxNorm, origXmin + minSize, 1);
    q.boxNorm[0] = Number(newYmin.toFixed(3));
    q.boxNorm[3] = Number(newXmax.toFixed(3));
  } else if (dragContext.mode === "sw") {
    let newYmax = clamp(origYmax + dyNorm, origYmin + minSize, 1);
    let newXmin = clamp(origXmin + dxNorm, 0, origXmax - minSize);
    q.boxNorm[2] = Number(newYmax.toFixed(3));
    q.boxNorm[1] = Number(newXmin.toFixed(3));
  } else if (dragContext.mode === "se") {
    let newYmax = clamp(origYmax + dyNorm, origYmin + minSize, 1);
    let newXmax = clamp(origXmax + dxNorm, origXmin + minSize, 1);
    q.boxNorm[2] = Number(newYmax.toFixed(3));
    q.boxNorm[3] = Number(newXmax.toFixed(3));
  }

  updateBoxPositionsDOM();
  updateSidebarCoordDisplay(dragContext.index);
});

window.addEventListener("mouseup", (e) => {
  // 1. Commit drawn box
  if (drawingContext) {
    const stageW = drawingContext.rect.width;
    const stageH = drawingContext.rect.height;
    const curX = Math.max(0, Math.min(stageW, e.clientX - drawingContext.rect.left));
    const curY = Math.max(0, Math.min(stageH, e.clientY - drawingContext.rect.top));

    const left = Math.min(drawingContext.startX, curX);
    const top = Math.min(drawingContext.startY, curY);
    const width = Math.abs(curX - drawingContext.startX);
    const height = Math.abs(curY - drawingContext.startY);

    if (drawPreviewEl && drawPreviewEl.parentNode) {
      drawPreviewEl.parentNode.removeChild(drawPreviewEl);
    }

    if (width > 20 && height > 20 && stageW > 0 && stageH > 0) {
      const ymin = Number((top / stageH).toFixed(3));
      const xmin = Number((left / stageW).toFixed(3));
      const ymax = Number(((top + height) / stageH).toFixed(3));
      const xmax = Number(((left + width) / stageW).toFixed(3));

      const newId = `zona_personalizada_${Date.now().toString().slice(-4)}`;
      const colors = ["#06b6d4", "#ec4899", "#8b5cf6", "#10b981", "#f97316", "#eab308"];
      const randColor = colors[currentQuadrants.length % colors.length];

      currentQuadrants.push({
        id: newId,
        name: `Zona ${currentQuadrants.length + 1}`,
        type: "custom_zone",
        color: randColor,
        boxNorm: [ymin, xmin, ymax, xmax]
      });

      selectedQuadrantIndex = currentQuadrants.length - 1;
      setToolMode("move");
      renderQuadrantsSidebar();
      renderBoxesOnStage();
      showCalibratorStatus("✅ ¡Nueva zona trazada! Puedes renombrarla o ajustar sus límites.", "success");
      setTimeout(() => hideCalibratorStatus(), 4000);
    }
    drawingContext = null;
    return;
  }

  // 2. Clear box drag context
  if (dragContext) {
    dragContext = null;
  }
});

/**
 * Handle Window Resize to keep boxes aligned with image
 */
window.addEventListener("resize", () => {
  if (calibratorModal && !calibratorModal.classList.contains("hidden")) {
    renderBoxesOnStage();
  }
});

/**
 * Open Calibrator Modal
 */
function openCalibrator(targetDocId = null) {
  if (!calibratorModal) return;
  hideCalibratorStatus();
  updateCalibratorPhotoSelectOptions(targetDocId);
  currentCalibratorDocId = targetDocId;

  calibratorModal.classList.remove("hidden");
  document.body.style.overflow = "hidden";

  loadCalibratorImage(targetDocId);
}

function closeCalibrator() {
  if (!calibratorModal) return;
  calibratorModal.classList.add("hidden");
  document.body.style.overflow = "";
}

/**
 * Initialize Calibrator UI and Event Listeners
 */
function initCalibratorUI() {
  if (openCalibratorBtn) {
    openCalibratorBtn.addEventListener("click", () => {
      openCalibrator();
    });
  }

  if (modalCalibrateWithPhotoBtn) {
    modalCalibrateWithPhotoBtn.addEventListener("click", () => {
      const activeDocId = currentModalDocId || (allDocs.length > 0 ? allDocs[0].id : null);
      if (imageModal) imageModal.classList.add("hidden");
      openCalibrator(activeDocId);
    });
  }

  if (closeCalibratorBtn) {
    closeCalibratorBtn.addEventListener("click", closeCalibrator);
  }

  if (calibratorOverlayBg) {
    calibratorOverlayBg.addEventListener("click", closeCalibrator);
  }

  if (calibratorPhotoSelect) {
    calibratorPhotoSelect.addEventListener("change", (e) => {
      loadCalibratorImage(e.target.value);
    });
  }

  if (toolModeMove) {
    toolModeMove.addEventListener("click", () => setToolMode("move"));
  }

  if (toolModeDraw) {
    toolModeDraw.addEventListener("click", () => setToolMode("draw"));
  }

  if (deleteSelectedQuadrantBtn) {
    deleteSelectedQuadrantBtn.addEventListener("click", () => {
      deleteQuadrant(selectedQuadrantIndex);
    });
  }

  if (resetQuadrantsBtn) {
    resetQuadrantsBtn.addEventListener("click", () => {
      if (confirm("¿Estás seguro de restablecer todos los cuadrantes a los valores por defecto?")) {
        currentQuadrants = JSON.parse(JSON.stringify(DEFAULT_QUADRANTS));
        selectedQuadrantIndex = 0;
        setToolMode("move");
        renderQuadrantsSidebar();
        renderBoxesOnStage();
        showCalibratorStatus("Valores restablecidos a defaults (pulsa Guardar para persistir en Firebase).", "info");
      }
    });
  }

  if (addQuadrantBtn) {
    addQuadrantBtn.addEventListener("click", () => {
      const newId = `zona_personalizada_${Date.now().toString().slice(-4)}`;
      const colors = ["#06b6d4", "#ec4899", "#8b5cf6", "#10b981", "#f97316", "#eab308"];
      const randColor = colors[currentQuadrants.length % colors.length];

      const newQ = {
        id: newId,
        name: `Nueva Zona ${currentQuadrants.length + 1}`,
        type: "custom_zone",
        color: randColor,
        boxNorm: [0.35, 0.35, 0.65, 0.65]
      };

      currentQuadrants.push(newQ);
      selectedQuadrantIndex = currentQuadrants.length - 1;
      setToolMode("move");
      renderQuadrantsSidebar();
      renderBoxesOnStage();
      showCalibratorStatus("➕ Nueva zona creada en el centro. Arrástrala a su posición o ajusta sus límites.", "info");
    });
  }

  if (saveQuadrantsBtn) {
    saveQuadrantsBtn.addEventListener("click", async () => {
      saveQuadrantsBtn.disabled = true;
      saveQuadrantsBtn.innerHTML = `<span>⏳ Guardando...</span>`;
      showCalibratorStatus("Guardando cuadrantes en Firestore: camera_catcher/quadrants...", "info");

      try {
        const quadrantsDocRef = doc(db, "camera_catcher", "quadrants");
        await setDoc(quadrantsDocRef, {
          updatedAt: new Date().toISOString(),
          updatedBy: "web-dashboard",
          quadrants: currentQuadrants
        });

        showCalibratorStatus("✅ ¡Cuadrantes guardados y sincronizados con el backend en tiempo real!", "success");
        setTimeout(() => hideCalibratorStatus(), 5000);
      } catch (err) {
        console.error("[Calibrator] Error guardando cuadrantes:", err);
        showCalibratorStatus(`❌ Error al guardar en Firebase: ${err.message}`, "error");
      } finally {
        saveQuadrantsBtn.disabled = false;
        saveQuadrantsBtn.innerHTML = `<span>💾 Guardar en Firebase</span>`;
      }
    });
  }
}

// Initialize
initSettingsModal();
initPromptListener();
initPaginationListeners();
initPhotosListener();
initCostMonitor();
initQuadrantsListener();
initCalibratorUI();


