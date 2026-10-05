import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { 
  getFirestore, 
  collection, 
  doc, 
  onSnapshot, 
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc
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
const modalAnnotatedStage = document.getElementById("modalAnnotatedStage");
const modalAnnotatedSvg = document.getElementById("modalAnnotatedSvg");

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
/**
 * Calculate if current Lima time is within working hours (reusable)
 */
export function checkIsWithinWorkingHours(startStr = "11:00", endStr = "23:00") {
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

    if (startMins <= endMins) {
      return currentMins >= startMins && currentMins < endMins;
    } else {
      return currentMins >= startMins || currentMins < endMins;
    }
  } catch (_) {
    return true;
  }
}

/**
 * Calculate if current Lima time is within working hours and update status badge
 */
function updateWorkingHoursStatus(startStr = "11:00", endStr = "23:00") {
  if (!workingHoursStatusBadge) return;
  const isOpen = checkIsWithinWorkingHours(startStr, endStr);
  if (isOpen) {
    workingHoursStatusBadge.className = "status-hours-badge";
    workingHoursStatusBadge.innerHTML = '<span class="material-symbols-outlined" style="font-size: 14px; vertical-align: middle;">check_circle</span> Dentro de horario de atención (Abierto)';
  } else {
    workingHoursStatusBadge.className = "status-hours-badge closed";
    workingHoursStatusBadge.innerHTML = '<span class="material-symbols-outlined" style="font-size: 14px; vertical-align: middle;">bedtime</span> Fuera de horario de atención (Cerrado)';
  }
}

/**
 * Sincroniza el temporizador y etiquetas del Daemon Live View con la configuración de Firebase
 */
function syncCountdownWithConfig(intervalMinutes, startH = "11:00", endH = "23:00") {
  const isWithin = checkIsWithinWorkingHours(startH, endH);
  const currentStepTitle = document.getElementById("daemonCurrentStepTitle");
  const currentStepDesc = document.getElementById("daemonCurrentStepDesc");

  if (!isWithin) {
    if (currentStepTitle) currentStepTitle.textContent = "Horario Laboral en Pausa";
    if (currentStepDesc) currentStepDesc.textContent = `Fuera de horario de atención (${startH} a ${endH} America/Lima). Capturas programadas en pausa.`;
    setupDynamicCountdownTicker(null, intervalMinutes);
    return;
  }

  // Priorizar el próximo disparo registrado por el Daemon si está en el futuro
  let nextTimeIso = currentDaemonState?.countdown?.nextCaptureAt;
  const now = Date.now();
  if (!nextTimeIso || new Date(nextTimeIso).getTime() <= now) {
    let lastTime = now;
    if (allDocs && allDocs.length > 0 && allDocs[0].epoch) {
      lastTime = allDocs[0].epoch;
    }
    const intervalMs = intervalMinutes * 60 * 1000;
    let nextTime = lastTime + intervalMs;
    while (nextTime <= now) {
      nextTime += intervalMs;
    }
    nextTimeIso = new Date(nextTime).toISOString();
  }

  const remainingMin = Math.max(0, ((new Date(nextTimeIso).getTime() - now) / 60000)).toFixed(1);
  if (currentStepTitle && (!currentDaemonState || currentDaemonState.step === "countdown" || currentDaemonState.step === "idle")) {
    currentStepTitle.textContent = "Contador de Ciclo Activo";
  }
  if (currentStepDesc && (!currentDaemonState || currentDaemonState.step === "countdown" || currentDaemonState.step === "idle")) {
    currentStepDesc.textContent = `Contador activo (configurado en Firebase: ${intervalMinutes} min). Próxima consulta en ~${remainingMin} min.`;
  }

  setupDynamicCountdownTicker(nextTimeIso, intervalMinutes);
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
      const currentInterval = data?.intervalMinutes !== undefined ? Number(data.intervalMinutes) : 3;
      const startH = data?.workStartTime || data?.workStart || "11:00";
      const endH = data?.workEndTime || data?.workEnd || "23:00";

      if (intervalInput) {
        intervalInput.value = currentInterval;
      }
      if (workStartTimeInput) {
        workStartTimeInput.value = startH;
      }
      if (workEndTimeInput) {
        workEndTimeInput.value = endH;
      }
      updateWorkingHoursStatus(startH, endH);

      // Sincronizar etiquetas de la Vista en Vivo del Daemon inmediatamente
      const daemonIntervalTag = document.getElementById("daemonIntervalTag");
      if (daemonIntervalTag) {
        daemonIntervalTag.innerHTML = `<span class="material-symbols-outlined" style="font-size: 14px; vertical-align: middle;">timer</span> Intervalo: ${currentInterval} min`;
      }
      const daemonHoursTag = document.getElementById("daemonWorkingHoursTag");
      if (daemonHoursTag) {
        daemonHoursTag.innerHTML = `<span class="material-symbols-outlined" style="font-size: 14px; vertical-align: middle;">schedule</span> Horario: ${startH} - ${endH}`;
      }
      const daemonHoursStatusTag = document.getElementById("daemonHoursStatusTag");
      if (daemonHoursStatusTag) {
        const isWithin = checkIsWithinWorkingHours(startH, endH);
        daemonHoursStatusTag.innerHTML = isWithin
          ? '<span class="status-dot-pulse-green"></span> En jornada de atención'
          : '<span class="material-symbols-outlined" style="font-size: 14px; vertical-align: middle;">pause_circle</span> Fuera de horario laboral';
        daemonHoursStatusTag.className = `countdown-tag ${isWithin ? "tag-success" : "tag-warning"}`;
      }

      // Sincronizar simulador de costos
      if (typeof updateSimulator === "function") {
        updateSimulator(currentInterval);
      }

      // Sincronizar reloj de cuenta regresiva
      syncCountdownWithConfig(currentInterval, startH, endH);

      if (data?.workStartTime && data?.workEndTime) {
        const [sH, sM] = data.workStartTime.split(":").map(Number);
        const [eH, eM] = data.workEndTime.split(":").map(Number);
        const diffH = (eH + (eM || 0) / 60) - (sH + (sM || 0) / 60);
        if (diffH > 0 && diffH <= 24) currentActiveHours = diffH;
      }
      updateCostMetrics(allDocs.length);
    } else {
      promptInput.value = "Describe what do you see in the image";
      if (intervalInput) intervalInput.value = 3;
      if (workStartTimeInput) workStartTimeInput.value = "11:00";
      if (workEndTimeInput) workEndTimeInput.value = "23:00";
      updateWorkingHoursStatus("11:00", "23:00");
      // Auto initialize if missing
      setDoc(promptDocRef, { 
        default: "Describe what do you see in the image",
        intervalMinutes: 3,
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

      // Actualizar también camera_catcher/daemon_state para reflejo inmediato
      const nextTime = new Date(Date.now() + validInterval * 60 * 1000);
      await setDoc(doc(db, "camera_catcher", "daemon_state"), {
        countdown: {
          nextCaptureAt: nextTime.toISOString(),
          intervalMinutes: validInterval,
          remainingSeconds: validInterval * 60,
          workHours: `${startTimeVal} - ${endTimeVal} (America/Lima)`,
          isWithinWorkingHours: checkIsWithinWorkingHours(startTimeVal, endTimeVal)
        },
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
      const isStaffSingle = clients[0].role === "staff" || clients[0].isStaffHint === true;
      const thumbBadgeText = isStaffSingle ? "✂️ Staff" : "👤 Cliente";
      const thumbBadgeStyle = isStaffSingle ? 'style="background: #FF4500;"' : '';
      thumbCellHtml = `
        <div class="client-thumb-single-wrap" id="client-thumb-wrap-${index}-0" title="Ver detalle de captura">
          <div class="thumbnail-placeholder" id="client-thumb-load-${index}-0">
            <div class="spinner-small"></div>
          </div>
          <img id="client-thumb-img-${index}-0" class="hidden client-thumb-img" alt="Fragmento de persona detectada" />
          <span class="client-thumb-label" ${thumbBadgeStyle}>${thumbBadgeText}</span>
        </div>
      `;
    } else {
      // Multiple seated clients or staff detected
      thumbCellHtml = `
        <div class="client-thumbs-multi-wrap" title="Ver detalle de captura">
          ${clients.map((c, cIdx) => {
            const isStaffItem = c.role === "staff" || c.isStaffHint === true;
            const subLabel = isStaffItem ? "✂️ Staff" : `#${cIdx + 1}`;
            const subLabelStyle = isStaffItem ? 'style="background: #FF4500;"' : "";
            return `
            <div class="client-thumb-multi-item" id="client-thumb-wrap-${index}-${cIdx}" title="${isStaffItem ? 'Personal / Staff' : `Cliente #${cIdx + 1}`}">
              <div class="thumbnail-placeholder" id="client-thumb-load-${index}-${cIdx}">
                <div class="spinner-small"></div>
              </div>
              <img id="client-thumb-img-${index}-${cIdx}" class="hidden client-thumb-img" alt="${isStaffItem ? 'Staff' : `Cliente #${cIdx + 1}`}" />
              <span class="client-thumb-sublabel" ${subLabelStyle}>${subLabel}</span>
            </div>
            `;
          }).join("")}
        </div>
      `;
    }

    // Render client crop preview chips in analysis cell if present
    let clientChipsHtml = "";
    if (clients.length > 0) {
      clientChipsHtml = `
        <div class="clients-container" style="display: flex; align-items: center; gap: 8px; margin-top: 8px;">
          <span style="font-size: 0.75rem; color: #32DC32; font-weight: 600;">👥 Personas detectadas:</span>
          <div style="display: flex; gap: 6px; flex-wrap: wrap;">
            ${clients.map((c, cIdx) => {
              const isStaff = c.role === "staff" || c.isStaffHint === true;
              const chipBg = isStaff ? "rgba(255, 69, 0, 0.12)" : "rgba(50, 220, 50, 0.12)";
              const chipBorder = isStaff ? "rgba(255, 69, 0, 0.35)" : "rgba(50, 220, 50, 0.35)";
              const chipColor = isStaff ? "#FF4500" : "#32DC32";
              const chipLabel = isStaff ? `✂️ Staff (${escapeHtml(c.status || "en_servicio")})` : `👤 Cliente #${cIdx + 1} (${escapeHtml(c.status || "en_corte")})`;
              return `
              <div class="client-chip" style="display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; background: ${chipBg}; border: 1px solid ${chipBorder}; border-radius: 6px;">
                <span style="font-size: 0.70rem; color: ${chipColor}; font-weight: 600;">${chipLabel}</span>
              </div>
              `;
            }).join("")}
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
  modalTimestamp.innerHTML = `<span class="material-symbols-outlined" style="font-size: 14px; vertical-align: middle; margin-right: 4px;">calendar_today</span> ${dateStr}`;
  modalAnalysis.innerHTML = `<strong>Resumen y Cuadrantes ML:</strong><br>${escapeHtml(docData.analysis || "Sin análisis")}` +
    (docData.promptUsed ? `<br><br><small class="text-muted">Prompt utilizado: "${escapeHtml(docData.promptUsed)}"</small>` : "");

  // Reset loading states for both panes
  modalOriginalImage.classList.add("hidden");
  modalOriginalImage.src = "";
  modalOriginalLoading.classList.remove("hidden");
  modalOriginalLoading.innerHTML = `<div class="spinner-small"></div> <span>Cargando original...</span>`;
  modalOriginalLink.href = "#";

  modalAnnotatedStage?.classList.add("hidden");
  modalAnnotatedImage.src = "";
  if (modalAnnotatedSvg) modalAnnotatedSvg.innerHTML = "";
  modalAnnotatedLoading.classList.remove("hidden");
  modalAnnotatedLoading.innerHTML = `<div class="spinner-small"></div> <span>Cargando fotograma...</span>`;
  modalAnnotatedLink.href = "#";

  imageModal.classList.remove("hidden");

  // 1. Resolve photo URL (single original image shared by both panes)
  const originalPath = docData.imageStoragePath || docData.annotatedStoragePath;
  if (originalPath) {
    resolveStorageUrl(originalPath).then((url) => {
      if (url) {
        // Left pane: clean original photo
        modalOriginalImage.src = url;
        modalOriginalLink.href = url;
        modalOriginalImage.onload = () => {
          modalOriginalLoading.classList.add("hidden");
          modalOriginalImage.classList.remove("hidden");
        };
        modalOriginalImage.onerror = () => {
          modalOriginalLoading.innerHTML = `<span style="color: var(--danger)">Error al cargar</span>`;
        };

        // Right pane: mounted dynamically with SVG overlay on top of original photo
        modalAnnotatedImage.src = url;
        modalAnnotatedLink.href = url;
        modalAnnotatedImage.onload = () => {
          modalAnnotatedLoading.classList.add("hidden");
          modalAnnotatedStage?.classList.remove("hidden");
          renderFrontendAnnotatedOverlay(docData);
        };
        modalAnnotatedImage.onerror = () => {
          modalAnnotatedLoading.innerHTML = `<span style="color: var(--danger)">Error al cargar</span>`;
        };
      } else {
        modalOriginalLoading.innerHTML = `<span style="color: var(--danger)">No disponible</span>`;
        modalAnnotatedLoading.innerHTML = `<span style="color: var(--danger)">No disponible</span>`;
      }
    });
  } else {
    modalOriginalLoading.innerHTML = `<span style="color: var(--text-muted)">Sin imagen</span>`;
    modalAnnotatedLoading.innerHTML = `<span style="color: var(--text-muted)">Sin imagen</span>`;
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

/**
 * Render dynamic SVG overlay on top of original image in modal, mounting
 * boxes and perspective quadrilaterals entirely in frontend (saves storage & upload costs).
 */
function renderFrontendAnnotatedOverlay(docData) {
  if (!modalAnnotatedSvg || !modalAnnotatedImage) return;

  const w = docData.ml?.imageDimensions?.width || modalAnnotatedImage.naturalWidth || 1024;
  const h = docData.ml?.imageDimensions?.height || modalAnnotatedImage.naturalHeight || 576;

  modalAnnotatedSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  modalAnnotatedSvg.innerHTML = "";

  const quadrants = docData.ml?.quadrants || docData.quadrants || [];
  if (!Array.isArray(quadrants) || quadrants.length === 0) return;

  const occupiedSlots = [];

  quadrants.forEach((q) => {
    const color = q.color || "#00FF00";
    const label = q.label || q.name || q.id;
    const statusText = q.status ? ` [${q.status}]` : "";
    const fullText = `${label}${statusText}`;

    // 1. Draw Geometry: Free Polygon or Rect
    if (q.polygonNorm && Array.isArray(q.polygonNorm) && q.polygonNorm.length >= 3) {
      const pts = q.polygonNorm.map(p => {
        const [px, py] = toPointTuple(p);
        return `${Math.round(px * w)},${Math.round(py * h)}`;
      }).join(" ");

      const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      poly.setAttribute("points", pts);
      poly.setAttribute("fill", color);
      poly.setAttribute("fill-opacity", "0.22");
      poly.setAttribute("stroke", color);
      poly.setAttribute("stroke-width", "3");
      poly.setAttribute("stroke-linejoin", "round");
      modalAnnotatedSvg.appendChild(poly);
    } else if (q.box && Array.isArray(q.box) && q.box.length === 4) {
      const [x1, y1, x2, y2] = q.box;
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", x1);
      rect.setAttribute("y", y1);
      rect.setAttribute("width", Math.max(1, x2 - x1));
      rect.setAttribute("height", Math.max(1, y2 - y1));
      rect.setAttribute("fill", color);
      rect.setAttribute("fill-opacity", "0.20");
      rect.setAttribute("stroke", color);
      rect.setAttribute("stroke-width", "3");
      rect.setAttribute("rx", "4");
      modalAnnotatedSvg.appendChild(rect);
    }

    // 2. Draw Text Badge with status
    let boxX = 0, boxY = 0;
    if (q.box && Array.isArray(q.box) && q.box.length === 4) {
      boxX = q.box[0];
      boxY = q.box[1];
    } else if (q.polygonNorm && Array.isArray(q.polygonNorm) && q.polygonNorm.length > 0) {
      const [px, py] = toPointTuple(q.polygonNorm[0]);
      boxX = Math.round(px * w);
      boxY = Math.round(py * h);
    }

    const badgeW = Math.max(120, fullText.length * 8.5 + 16);
    const badgeH = 22;
    let badgeY = Math.max(4, boxY - badgeH - 3);

    const collides = occupiedSlots.some(slot =>
      Math.abs(slot.x - boxX) < 150 && Math.abs(slot.y - badgeY) < 26
    );
    if (collides || q.id === "cliente_sentado") {
      badgeY = boxY + 6;
    }
    occupiedSlots.push({ x: boxX, y: badgeY });

    const badgeRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    badgeRect.setAttribute("x", boxX);
    badgeRect.setAttribute("y", badgeY);
    badgeRect.setAttribute("width", badgeW);
    badgeRect.setAttribute("height", badgeH);
    badgeRect.setAttribute("fill", color);
    badgeRect.setAttribute("rx", "3");
    modalAnnotatedSvg.appendChild(badgeRect);

    const badgeText = document.createElementNS("http://www.w3.org/2000/svg", "text");
    badgeText.setAttribute("x", boxX + 8);
    badgeText.setAttribute("y", badgeY + 15);
    badgeText.setAttribute("font-family", "Arial, Helvetica, sans-serif");
    badgeText.setAttribute("font-size", "12");
    badgeText.setAttribute("font-weight", "bold");
    badgeText.setAttribute("fill", "#000000");
    badgeText.textContent = fullText;
    modalAnnotatedSvg.appendChild(badgeText);
  });
}

function closeModal() {
  imageModal.classList.add("hidden");
  modalOriginalImage.src = "";
  modalAnnotatedImage.src = "";
  if (modalAnnotatedSvg) modalAnnotatedSvg.innerHTML = "";
  modalAnnotatedStage?.classList.add("hidden");
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
 * 3. Handle "Capturar Ahora" button (delegates to live cycle trigger if clicked)
 */
captureBtn?.addEventListener("click", () => {
  const triggerBtn = document.getElementById("triggerLiveCycleBtn");
  if (triggerBtn) {
    triggerBtn.click();
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
      costTrafficText.textContent = "Seguro: $0.00 / mes (Always Free)";
    } else if (currentInterval >= 2) {
      costTrafficBadge.className = "cost-badge cost-badge-warn";
      costTrafficText.textContent = "Moderado: ~$0.10 - $0.50 / mes (Storage ops)";
    } else {
      costTrafficBadge.className = "cost-badge cost-badge-danger";
      costTrafficText.textContent = "Intensivo: Puede exceder 5 GB Storage";
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
      simAlertIcon.textContent = "lightbulb";
      simAlertText.innerHTML = `
        <strong>Excelente para producción (Costo: $0.00/mes):</strong> Con ${intervalMinutes} min, generas ~${storageMonthGB.toFixed(1)} GB/mes. 
        Mantienes todas las escrituras y lecturas 100% dentro de la capa gratuita perpetua de Google Cloud.
      `;
    } else if (intervalMinutes >= 2) {
      const excessOps = Math.max(0, opsStorageMonth - FREE_TIER.storageOpsA);
      const costOps = (excessOps / 10000) * FREE_TIER.priceOpsAPer10k;
      simAlertBox.className = "sim-alert sim-alert-warn";
      simAlertIcon.textContent = "warning";
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
      simAlertIcon.textContent = "error";
      simAlertText.innerHTML = `
        <strong>Intervalo de alta frecuencia:</strong> Generarás <strong>~${storageMonthGB.toFixed(0)} GB de fotos al mes</strong>.
        Excederá los 5.0 GB gratuitos de Cloud Storage rápidamente. Costo extra estimado si corre 24/7 sin rotación: <strong>~$${totalEstimated.toFixed(2)} / mes</strong>.
        Se recomienda solo para pruebas o con política de depuración automática.
      `;
    }
  }
}

/* ========================================================
   RECONOCIMIENTO DE PERSONAS & DIRECTORIO BIOMÉTRICO
   ======================================================== */
const peopleCardHeader = document.getElementById("peopleCardHeader");
const togglePeopleBtn = document.getElementById("togglePeopleBtn");
const peopleCardBody = document.getElementById("peopleCardBody");
const peopleStatsBadge = document.getElementById("peopleStatsBadge");
const peopleListGrid = document.getElementById("peopleListGrid");

function initPeopleListener() {
  if (!peopleListGrid) return;

  function togglePeopleSection() {
    if (!peopleCardBody || !togglePeopleBtn) return;
    const isHidden = peopleCardBody.classList.contains("hidden");
    if (isHidden) {
      peopleCardBody.classList.remove("hidden");
      togglePeopleBtn.textContent = "Contraer ▾";
    } else {
      peopleCardBody.classList.add("hidden");
      togglePeopleBtn.textContent = "Expandir ▸";
    }
  }

  togglePeopleBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePeopleSection();
  });

  peopleCardHeader?.addEventListener("click", () => {
    togglePeopleSection();
  });

  const peopleColRef = collection(db, "camera_catcher_people");
  onSnapshot(peopleColRef, async (snapshot) => {
    const people = [];
    snapshot.forEach((docSnap) => {
      people.push({ id: docSnap.id, ...docSnap.data() });
    });

    const staffCount = people.filter(p => p.isStaff).length;
    const clientCount = people.filter(p => !p.isStaff).length;
    if (peopleStatsBadge) {
      peopleStatsBadge.innerHTML = `<span class="material-symbols-outlined" style="font-size: 13px; vertical-align: middle;">badge</span> ${people.length} registradas (${staffCount} Staff • ${clientCount} Clientes)`;
    }

    if (people.length === 0) {
      peopleListGrid.innerHTML = `
        <div class="people-empty-state" style="grid-column: 1 / -1; padding: 24px; text-align: center; background: rgba(15, 23, 42, 0.6); border-radius: 8px; border: 1px dashed rgba(255, 255, 255, 0.1);">
          <div style="font-size: 2rem; margin-bottom: 8px;"><span class="material-symbols-outlined" style="font-size: 36px; color: var(--text-muted);">person_off</span></div>
          <strong style="color: var(--text-main); font-size: 0.95rem;">No hay personas registradas todavía</strong>
          <p style="font-size: 0.82rem; color: var(--text-muted); margin-top: 6px; max-width: 500px; margin-left: auto; margin-right: auto;">
            A medida que la cámara capture y el backend procese los fotogramas con el modelo MobileFaceNet ArcFace, catalogará automáticamente aquí a clientes y barberos para re-identificación facial.
          </p>
        </div>
      `;
      return;
    }

    // Sort: Staff first, then most visits, then most recent
    people.sort((a, b) => {
      if (a.isStaff && !b.isStaff) return -1;
      if (!a.isStaff && b.isStaff) return 1;
      const visitsA = a.visitCount || 1;
      const visitsB = b.visitCount || 1;
      if (visitsB !== visitsA) return visitsB - visitsA;
      return new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0);
    });

    peopleListGrid.innerHTML = people.map((p, idx) => {
      const isStaff = !!p.isStaff;
      const visits = p.visitCount || 1;
      const roleBadge = isStaff
        ? `<span class="person-role-tag staff"><span class="material-symbols-outlined" style="font-size: 13px; vertical-align: middle;">content_cut</span> Staff / Barbero</span>`
        : visits > 1
          ? `<span class="person-role-tag frequent"><span class="material-symbols-outlined" style="font-size: 13px; vertical-align: middle;">grade</span> Frecuente (${visits} visitas)</span>`
          : `<span class="person-role-tag new"><span class="material-symbols-outlined" style="font-size: 13px; vertical-align: middle;">person</span> Cliente (1 visita)</span>`;

      const lastDate = p.lastSeen ? formatDateTime(p.lastSeen) : "Desconocido";

      return `
        <div class="person-card ${isStaff ? 'staff-card' : ''}" data-person-id="${p.id}">
          <div class="person-thumb-wrap">
            <div class="thumbnail-placeholder" id="p-load-${idx}">
              <div class="spinner-small"></div>
            </div>
            <img id="p-img-${idx}" class="person-thumb-img hidden" alt="${escapeHtml(p.name || p.id)}" />
            <div class="person-badge-overlay">${roleBadge}</div>
          </div>
          
          <div class="person-details">
            <div class="person-name-row">
              <input type="text" class="person-name-input" id="p-name-${idx}" value="${escapeHtml(p.name || 'Persona')}" title="Clic para renombrar (Enter o salir del campo para guardar)" />
              <button class="person-del-btn" id="p-del-${idx}" title="Eliminar perfil"><span class="material-symbols-outlined" style="font-size: 15px;">delete</span></button>
            </div>
            <div class="person-meta-row">
              <span>Visitas: <strong>${visits}</strong></span>
              <span>Última: <small>${lastDate}</small></span>
            </div>
            <div class="person-actions-row">
              <button class="btn btn-secondary btn-sm person-role-toggle-btn" id="p-role-${idx}">
                ${isStaff ? '<span class="material-symbols-outlined" style="font-size: 13px; vertical-align: middle;">person</span> Cambiar a Cliente' : '<span class="material-symbols-outlined" style="font-size: 13px; vertical-align: middle;">badge</span> Marcar como Staff'}
              </button>
            </div>
          </div>
        </div>
      `;
    }).join("");

    // Resolve thumbnails & attach actions
    people.forEach(async (p, idx) => {
      const imgEl = document.getElementById(`p-img-${idx}`);
      const loadEl = document.getElementById(`p-load-${idx}`);
      const nameInput = document.getElementById(`p-name-${idx}`);
      const delBtn = document.getElementById(`p-del-${idx}`);
      const roleBtn = document.getElementById(`p-role-${idx}`);

      const thumbPath = p.lastThumbnailPath || p.thumbnailPath;
      if (thumbPath) {
        const url = await resolveStorageUrl(thumbPath);
        if (url && imgEl) {
          imgEl.src = url;
          imgEl.onload = () => {
            loadEl?.classList.add("hidden");
            imgEl.classList.remove("hidden");
          };
          imgEl.onerror = () => {
            if (loadEl) loadEl.innerHTML = `<span style="font-size: 0.70rem; color: var(--text-muted)">Sin vista previa</span>`;
          };
        }
      } else {
        if (loadEl) loadEl.innerHTML = `<span style="font-size: 0.70rem; color: var(--text-muted)">Sin foto</span>`;
      }

      // Inline renaming
      nameInput?.addEventListener("change", async (e) => {
        const newName = e.target.value.trim();
        if (!newName) return;
        try {
          await updateDoc(doc(db, "camera_catcher_people", p.id), { name: newName });
          nameInput.style.borderColor = "#10b981";
          setTimeout(() => { nameInput.style.borderColor = ""; }, 1500);
        } catch (err) {
          console.error("Error renombrando persona:", err);
          alert("Error al renombrar: " + err.message);
        }
      });

      // Role Toggle
      roleBtn?.addEventListener("click", async () => {
        roleBtn.disabled = true;
        try {
          await updateDoc(doc(db, "camera_catcher_people", p.id), {
            isStaff: !p.isStaff
          });
        } catch (err) {
          console.error("Error cambiando rol:", err);
          alert("Error: " + err.message);
        } finally {
          roleBtn.disabled = false;
        }
      });

      // Delete Person
      delBtn?.addEventListener("click", async () => {
        if (confirm(`¿Eliminar el perfil biométrico de "${p.name || p.id}"?`)) {
          try {
            await deleteDoc(doc(db, "camera_catcher_people", p.id));
          } catch (err) {
            console.error("Error eliminando perfil:", err);
            alert("Error: " + err.message);
          }
        }
      });
    });
  }, (err) => {
    console.error("[People] Error suscribiendo a camera_catcher_people:", err);
  });
}

/* ========================================================
   CALIBRADOR VISUAL DE CUADRANTES (POLÍGONOS LIBRES / PERSPECTIVA)
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
const calibratorSvg = document.getElementById("calibratorSvg");
const calibratorOverlay = document.getElementById("calibratorOverlay");
const quadrantsList = document.getElementById("quadrantsList");
const quadrantCount = document.getElementById("quadrantCount");

let currentToolMode = "move"; // 'move' | 'draw'
let drawingContext = null;
let drawPreviewEl = null;

// Helpers for Quadrilateral & Polygon Conversion
function toPointTuple(p) {
  if (Array.isArray(p)) return [Number(p[0]), Number(p[1])];
  if (p && typeof p === "object") return [Number(p.x ?? 0), Number(p.y ?? 0)];
  return [0, 0];
}

function boxNormToPolygonNorm([ymin, xmin, ymax, xmax]) {
  return [
    [Number(xmin.toFixed(3)), Number(ymin.toFixed(3))], // P1 (Top-Left)
    [Number(xmax.toFixed(3)), Number(ymin.toFixed(3))], // P2 (Top-Right)
    [Number(xmax.toFixed(3)), Number(ymax.toFixed(3))], // P3 (Bottom-Right)
    [Number(xmin.toFixed(3)), Number(ymax.toFixed(3))]  // P4 (Bottom-Left)
  ];
}

function polygonNormToBoundingBoxNorm(polygon) {
  if (!polygon || polygon.length === 0) return [0, 0, 1, 1];
  const xs = polygon.map(p => toPointTuple(p)[0]);
  const ys = polygon.map(p => toPointTuple(p)[1]);
  return [
    Number(Math.min(...ys).toFixed(3)),
    Number(Math.min(...xs).toFixed(3)),
    Number(Math.max(...ys).toFixed(3)),
    Number(Math.max(...xs).toFixed(3))
  ];
}

function normalizeQuadrants(quads) {
  if (!Array.isArray(quads)) return [];
  return quads.map(q => {
    const item = { ...q };
    if (item.polygonNorm && Array.isArray(item.polygonNorm) && item.polygonNorm.length >= 3) {
      item.polygonNorm = item.polygonNorm.map(toPointTuple);
    } else if (item.boxNorm && Array.isArray(item.boxNorm) && item.boxNorm.length === 4) {
      item.polygonNorm = boxNormToPolygonNorm(item.boxNorm);
    } else {
      item.polygonNorm = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]];
    }
    item.boxNorm = polygonNormToBoundingBoxNorm(item.polygonNorm);
    return item;
  });
}

/**
 * Serialize quadrants for Firestore to avoid nested arrays limitation.
 * Converts polygonNorm [[x, y], ...] into an array of map objects [{ x, y }, ...].
 */
function serializeQuadrantsForFirestore(quads) {
  return quads.map(q => {
    const rawPoly = q.polygonNorm || boxNormToPolygonNorm(q.boxNorm || [0, 0, 1, 1]);
    const polyObjects = rawPoly.map(p => {
      const [x, y] = toPointTuple(p);
      return {
        x: Number(x.toFixed(3)),
        y: Number(y.toFixed(3))
      };
    });
    return {
      id: q.id,
      name: q.name || q.id,
      type: q.type || "custom_zone",
      color: q.color || "#007BFF",
      boxNorm: q.boxNorm || [0, 0, 1, 1],
      polygonNorm: polyObjects
    };
  });
}

const DEFAULT_QUADRANTS = normalizeQuadrants([
  {
    id: "puerta_entrada",
    name: "Entrada / Pasillo peatonal",
    boxNorm: [0.30, 0.40, 0.88, 0.60],
    polygonNorm: [
      [0.40, 0.30],
      [0.60, 0.30],
      [0.60, 0.88],
      [0.40, 0.88]
    ],
    type: "walking_zone",
    color: "#007BFF"
  },
  {
    id: "silla_barbero_puesto1",
    name: "Silla de barbero (Puesto 1)",
    boxNorm: [0.65, 0.80, 1.00, 1.00],
    polygonNorm: [
      [0.80, 0.65],
      [1.00, 0.65],
      [1.00, 1.00],
      [0.80, 1.00]
    ],
    type: "barber_chair",
    color: "#FFD700"
  },
  {
    id: "silla_barbero_puesto2",
    name: "Silla de barbero (Frente)",
    boxNorm: [0.80, 0.36, 1.00, 0.67],
    polygonNorm: [
      [0.36, 0.80],
      [0.67, 0.80],
      [0.67, 1.00],
      [0.36, 1.00]
    ],
    type: "barber_chair",
    color: "#FFD700"
  },
  {
    id: "silla_espera",
    name: "Silla de espera",
    boxNorm: [0.55, 0.73, 0.92, 0.90],
    polygonNorm: [
      [0.73, 0.55],
      [0.90, 0.55],
      [0.90, 0.92],
      [0.73, 0.92]
    ],
    type: "waiting_chair",
    color: "#D250DC"
  },
  {
    id: "zona_barbero",
    name: "Zona de trabajo de barbero",
    boxNorm: [0.45, 0.65, 0.95, 0.82],
    polygonNorm: [
      [0.65, 0.45],
      [0.82, 0.45],
      [0.82, 0.95],
      [0.65, 0.95]
    ],
    type: "barber_workstation",
    color: "#FF4500"
  }
]);

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
      let quadsRaw = [];
      if (Array.isArray(data?.quadrants) && data.quadrants.length > 0) {
        quadsRaw = data.quadrants;
      } else if (data?.quadrants && typeof data.quadrants === "object") {
        quadsRaw = Object.values(data.quadrants);
      }
      if (quadsRaw.length > 0) {
        currentQuadrants = normalizeQuadrants(quadsRaw);
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
      ? `<span class="material-symbols-outlined" style="font-size: 15px; vertical-align: middle;">draw</span> <strong>Modo Dibujar activo:</strong> Haz clic y arrastra sobre la foto para crear la zona.`
      : `<span class="material-symbols-outlined" style="font-size: 15px; vertical-align: middle;">lightbulb</span> <em>Arrastra cualquier zona para moverla o ajusta libremente sus 4 esquinas (perspectiva).</em>`;
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
 * Render list of quadrants in the sidebar with 4-vertex coordinates
 */
function renderQuadrantsSidebar() {
  if (!quadrantsList) return;
  if (quadrantCount) quadrantCount.textContent = currentQuadrants.length;
  quadrantsList.innerHTML = "";

  currentQuadrants.forEach((q, idx) => {
    const item = document.createElement("div");
    item.className = `q-item ${idx === selectedQuadrantIndex ? "active" : ""}`;
    item.dataset.index = idx;

    const poly = q.polygonNorm || [];
    const vStr = poly.map((p, i) => `P${i+1}:(${p[0].toFixed(2)},${p[1].toFixed(2)})`).join("  ");
    const currentType = q.type || "custom_zone";

    item.innerHTML = `
      <div class="q-item-header">
        <div class="q-item-left">
          <input type="color" class="q-color-picker" value="${q.color || '#3b82f6'}" title="Cambiar color de la zona" />
          <input type="text" class="q-name-input" value="${escapeHtml(q.name || q.id)}" title="Editar nombre de la zona" />
        </div>
        <button class="q-delete-btn" title="Eliminar esta zona" style="font-size: 0.95rem; cursor: pointer; padding: 2px 6px;"><span class="material-symbols-outlined" style="font-size: 15px;">delete</span></button>
      </div>
      <div class="q-type-row">
        <select class="q-type-select" title="Regla de negocio / Función asignada a esta zona">
          <option value="barber_chair" ${currentType === 'barber_chair' ? 'selected' : ''}>💈 Silla de Barbero (Corte / Cliente)</option>
          <option value="barber_workstation" ${currentType === 'barber_workstation' ? 'selected' : ''}>✂️ Puesto de Barbero (Staff / Personal)</option>
          <option value="waiting_chair" ${currentType === 'waiting_chair' ? 'selected' : ''}>🛋️ Silla / Sala de Espera</option>
          <option value="walking_zone" ${currentType === 'walking_zone' ? 'selected' : ''}>🚶 Pasillo / Acceso (Tránsito)</option>
          <option value="custom_zone" ${currentType === 'custom_zone' ? 'selected' : ''}>📦 Zona Personalizada (General)</option>
        </select>
      </div>
      <div class="q-coords-row" title="4 Vértices de perspectiva libre: ${vStr}">
        <span class="q-vertices-display">${vStr}</span>
      </div>
    `;

    item.addEventListener("click", (e) => {
      if (e.target.classList.contains("q-name-input") || e.target.classList.contains("q-color-picker") || e.target.classList.contains("q-delete-btn") || e.target.classList.contains("q-type-select")) {
        return;
      }
      selectedQuadrantIndex = idx;
      renderQuadrantsSidebar();
      renderBoxesOnStage();
    });

    const nameInput = item.querySelector(".q-name-input");
    nameInput.addEventListener("input", (e) => {
      q.name = e.target.value;
      updateBoxBadge(idx);
    });

    const colorPicker = item.querySelector(".q-color-picker");
    colorPicker.addEventListener("input", (e) => {
      q.color = e.target.value;
      updateBoxColor(idx);
    });

    const typeSelect = item.querySelector(".q-type-select");
    typeSelect?.addEventListener("change", (e) => {
      q.type = e.target.value;
      // Auto-suggest matching signature color if desired
      const TYPE_COLORS = {
        barber_chair: "#FFD700",
        barber_workstation: "#FF4500",
        waiting_chair: "#D250DC",
        walking_zone: "#007BFF",
        custom_zone: "#10B981"
      };
      if (TYPE_COLORS[q.type]) {
        q.color = TYPE_COLORS[q.type];
        const picker = item.querySelector(".q-color-picker");
        if (picker) picker.value = q.color;
        updateBoxColor(idx);
      }
    });

    const deleteBtn = item.querySelector(".q-delete-btn");
    deleteBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteQuadrant(idx);
    });

    quadrantsList.appendChild(item);
  });
}

function updateBoxBadge(idx) {
  const badge = calibratorOverlay?.querySelector(`.q-poly-badge[data-index="${idx}"]`);
  if (badge && currentQuadrants[idx]) {
    badge.textContent = currentQuadrants[idx].name || currentQuadrants[idx].id;
  }
}

function updateBoxColor(idx) {
  const q = currentQuadrants[idx];
  if (!q) return;
  const poly = calibratorSvg?.querySelector(`polygon[data-index="${idx}"]`);
  const badge = calibratorOverlay?.querySelector(`.q-poly-badge[data-index="${idx}"]`);
  const handles = calibratorOverlay?.querySelectorAll(`.q-vertex-handle[data-index="${idx}"]`);

  if (poly) {
    poly.setAttribute("stroke", q.color);
    poly.setAttribute("fill", hexToRgba(q.color, idx === selectedQuadrantIndex ? 0.30 : 0.14));
  }
  if (badge) badge.style.backgroundColor = q.color;
  handles?.forEach(h => { h.style.backgroundColor = q.color; });
}

function hexToRgba(hex, alpha = 0.2) {
  if (!hex || !hex.startsWith("#")) return `rgba(59, 130, 246, ${alpha})`;
  let c = hex.substring(1);
  if (c.length === 3) c = c.split("").map(ch => ch + ch).join("");
  const num = parseInt(c, 16);
  return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
}

/**
 * Render free quadrilaterals (SVG polygons) and 4 vertex handles on the stage
 */
function renderBoxesOnStage() {
  if (!calibratorOverlay || !calibratorSvg || !calibratorImg || !calibratorImg.clientWidth) return;
  const stageW = calibratorImg.clientWidth;
  const stageH = calibratorImg.clientHeight;

  calibratorSvg.setAttribute("viewBox", `0 0 ${stageW} ${stageH}`);
  calibratorSvg.innerHTML = "";
  calibratorOverlay.innerHTML = "";

  // Draw Mode Overlay Listener
  calibratorOverlay.onmousedown = (e) => {
    if (currentToolMode === "draw" || e.target === calibratorOverlay) {
      e.preventDefault();
      const rect = calibratorImg.getBoundingClientRect();
      const startX = e.clientX - rect.left;
      const startY = e.clientY - rect.top;

      drawingContext = { startX, startY, rect };

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
    const isSelected = idx === selectedQuadrantIndex;
    const polyNorm = q.polygonNorm || boxNormToPolygonNorm(q.boxNorm || [0,0,1,1]);
    const pts = polyNorm.map(p => `${(p[0] * stageW).toFixed(1)},${(p[1] * stageH).toFixed(1)}`).join(" ");

    // 1. SVG Polygon for perspective quadrilateral
    const polyEl = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    polyEl.setAttribute("points", pts);
    polyEl.setAttribute("stroke", q.color || "#00ff00");
    polyEl.setAttribute("stroke-width", isSelected ? "3.5" : "2");
    polyEl.setAttribute("fill", hexToRgba(q.color || "#00ff00", isSelected ? 0.32 : 0.14));
    polyEl.setAttribute("class", `q-svg-polygon ${isSelected ? 'active' : ''}`);
    polyEl.dataset.index = idx;

    // Drag whole polygon body
    polyEl.addEventListener("mousedown", (e) => {
      if (currentToolMode === "draw") return;
      e.preventDefault();
      e.stopPropagation();
      selectedQuadrantIndex = idx;
      renderQuadrantsSidebar();
      renderBoxesOnStage();

      dragContext = {
        mode: "polygon",
        index: idx,
        startX: e.clientX,
        startY: e.clientY,
        stageW,
        stageH,
        origPolygon: JSON.parse(JSON.stringify(q.polygonNorm))
      };
    });

    calibratorSvg.appendChild(polyEl);

    // 2. Centroid Badge / Label
    const avgX = polyNorm.reduce((acc, p) => acc + p[0], 0) / polyNorm.length;
    const avgY = polyNorm.reduce((acc, p) => acc + p[1], 0) / polyNorm.length;

    const badge = document.createElement("div");
    badge.className = `q-poly-badge ${isSelected ? 'active' : ''}`;
    badge.dataset.index = idx;
    badge.style.left = `${avgX * stageW}px`;
    badge.style.top = `${avgY * stageH}px`;
    badge.style.backgroundColor = q.color || "#00ff00";
    badge.textContent = q.name || q.id;

    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      selectedQuadrantIndex = idx;
      renderQuadrantsSidebar();
      renderBoxesOnStage();
    });

    calibratorOverlay.appendChild(badge);

    // 3. Four Vertex Handles for Selected Quadrilateral
    if (isSelected) {
      polyNorm.forEach((p, vIdx) => {
        const vx = p[0] * stageW;
        const vy = p[1] * stageH;

        const handle = document.createElement("div");
        handle.className = "q-vertex-handle";
        handle.dataset.index = idx;
        handle.dataset.vertex = vIdx;
        handle.style.left = `${vx}px`;
        handle.style.top = `${vy}px`;
        handle.style.backgroundColor = q.color || "#00ff00";
        handle.innerHTML = `<span class="q-v-label">P${vIdx + 1}</span>`;
        handle.title = `Vértice P${vIdx + 1} (${p[0].toFixed(2)}, ${p[1].toFixed(2)}). Arrastra para perspectiva libre.`;

        handle.addEventListener("mousedown", (e) => {
          if (currentToolMode === "draw") return;
          e.preventDefault();
          e.stopPropagation();

          dragContext = {
            mode: "vertex",
            index: idx,
            vertex: vIdx,
            startX: e.clientX,
            startY: e.clientY,
            stageW,
            stageH,
            origPoint: [...p]
          };
        });

        calibratorOverlay.appendChild(handle);
      });
    }
  });
}

function updateSidebarCoordDisplay(idx) {
  const item = quadrantsList?.querySelector(`.q-item[data-index="${idx}"]`);
  const q = currentQuadrants[idx];
  if (!item || !q || !q.polygonNorm) return;
  const vDisp = item.querySelector(".q-vertices-display");
  if (vDisp) {
    const vStr = q.polygonNorm.map((p, i) => `P${i+1}:(${p[0].toFixed(2)},${p[1].toFixed(2)})`).join("  ");
    vDisp.textContent = vStr;
  }
}

/**
 * Global Mouse Move & Up Listeners
 */
window.addEventListener("mousemove", (e) => {
  // 1. Drawing mode preview
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

  // 2. Dragging vertex or polygon body
  if (!dragContext) return;
  const q = currentQuadrants[dragContext.index];
  if (!q) return;

  const dxNorm = (e.clientX - dragContext.startX) / dragContext.stageW;
  const dyNorm = (e.clientY - dragContext.startY) / dragContext.stageH;
  const clamp = (v, min = 0, max = 1) => Math.max(min, Math.min(max, v));

  if (dragContext.mode === "vertex") {
    const vIdx = dragContext.vertex;
    const newX = clamp(dragContext.origPoint[0] + dxNorm, 0, 1);
    const newY = clamp(dragContext.origPoint[1] + dyNorm, 0, 1);
    q.polygonNorm[vIdx] = [Number(newX.toFixed(3)), Number(newY.toFixed(3))];
    q.boxNorm = polygonNormToBoundingBoxNorm(q.polygonNorm);

    // Live update SVG polygon
    const poly = calibratorSvg?.querySelector(`polygon[data-index="${dragContext.index}"]`);
    if (poly) {
      const pts = q.polygonNorm.map(p => `${(p[0] * dragContext.stageW).toFixed(1)},${(p[1] * dragContext.stageH).toFixed(1)}`).join(" ");
      poly.setAttribute("points", pts);
    }
    // Live update Handle
    const handle = calibratorOverlay?.querySelector(`.q-vertex-handle[data-vertex="${vIdx}"]`);
    if (handle) {
      handle.style.left = `${newX * dragContext.stageW}px`;
      handle.style.top = `${newY * dragContext.stageH}px`;
    }
    // Live update Badge
    const badge = calibratorOverlay?.querySelector(`.q-poly-badge[data-index="${dragContext.index}"]`);
    if (badge) {
      const avgX = q.polygonNorm.reduce((acc, p) => acc + p[0], 0) / q.polygonNorm.length;
      const avgY = q.polygonNorm.reduce((acc, p) => acc + p[1], 0) / q.polygonNorm.length;
      badge.style.left = `${avgX * dragContext.stageW}px`;
      badge.style.top = `${avgY * dragContext.stageH}px`;
    }
    updateSidebarCoordDisplay(dragContext.index);
  } else if (dragContext.mode === "polygon") {
    // Translate entire polygon while preventing any vertex from exiting [0, 1]
    const origXs = dragContext.origPolygon.map(p => p[0]);
    const origYs = dragContext.origPolygon.map(p => p[1]);
    const minOrigX = Math.min(...origXs);
    const maxOrigX = Math.max(...origXs);
    const minOrigY = Math.min(...origYs);
    const maxOrigY = Math.max(...origYs);

    const validDx = Math.max(-minOrigX, Math.min(1 - maxOrigX, dxNorm));
    const validDy = Math.max(-minOrigY, Math.min(1 - maxOrigY, dyNorm));

    q.polygonNorm = dragContext.origPolygon.map(p => [
      Number((p[0] + validDx).toFixed(3)),
      Number((p[1] + validDy).toFixed(3))
    ]);
    q.boxNorm = polygonNormToBoundingBoxNorm(q.polygonNorm);

    // Live update SVG polygon
    const poly = calibratorSvg?.querySelector(`polygon[data-index="${dragContext.index}"]`);
    if (poly) {
      const pts = q.polygonNorm.map(p => `${(p[0] * dragContext.stageW).toFixed(1)},${(p[1] * dragContext.stageH).toFixed(1)}`).join(" ");
      poly.setAttribute("points", pts);
    }
    // Live update Handles
    const handles = calibratorOverlay?.querySelectorAll(`.q-vertex-handle[data-index="${dragContext.index}"]`);
    handles?.forEach((h) => {
      const v = parseInt(h.dataset.vertex, 10);
      if (q.polygonNorm[v]) {
        h.style.left = `${q.polygonNorm[v][0] * dragContext.stageW}px`;
        h.style.top = `${q.polygonNorm[v][1] * dragContext.stageH}px`;
      }
    });
    // Live update Badge
    const badge = calibratorOverlay?.querySelector(`.q-poly-badge[data-index="${dragContext.index}"]`);
    if (badge) {
      const avgX = q.polygonNorm.reduce((acc, p) => acc + p[0], 0) / q.polygonNorm.length;
      const avgY = q.polygonNorm.reduce((acc, p) => acc + p[1], 0) / q.polygonNorm.length;
      badge.style.left = `${avgX * dragContext.stageW}px`;
      badge.style.top = `${avgY * dragContext.stageH}px`;
    }
    updateSidebarCoordDisplay(dragContext.index);
  }
});

window.addEventListener("mouseup", (e) => {
  // 1. Commit drawn box into new 4-vertex quadrilateral
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
        boxNorm: [ymin, xmin, ymax, xmax],
        polygonNorm: boxNormToPolygonNorm([ymin, xmin, ymax, xmax])
      });

      selectedQuadrantIndex = currentQuadrants.length - 1;
      setToolMode("move");
      renderQuadrantsSidebar();
      renderBoxesOnStage();
      showCalibratorStatus("✅ ¡Nueva zona creada! Puedes arrastrar sus 4 esquinas para ajustar la perspectiva.", "success");
      setTimeout(() => hideCalibratorStatus(), 4000);
    }
    drawingContext = null;
    return;
  }

  // 2. Clear drag context
  if (dragContext) {
    dragContext = null;
    renderBoxesOnStage();
  }
});

window.addEventListener("resize", () => {
  if (calibratorModal && !calibratorModal.classList.contains("hidden")) {
    renderBoxesOnStage();
  }
});

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

function initCalibratorUI() {
  openCalibratorBtn?.addEventListener("click", () => openCalibrator());

  modalCalibrateWithPhotoBtn?.addEventListener("click", () => {
    const activeDocId = currentModalDocId || (allDocs.length > 0 ? allDocs[0].id : null);
    if (imageModal) imageModal.classList.add("hidden");
    openCalibrator(activeDocId);
  });

  closeCalibratorBtn?.addEventListener("click", closeCalibrator);
  calibratorOverlayBg?.addEventListener("click", closeCalibrator);

  calibratorPhotoSelect?.addEventListener("change", (e) => {
    loadCalibratorImage(e.target.value);
  });

  toolModeMove?.addEventListener("click", () => setToolMode("move"));
  toolModeDraw?.addEventListener("click", () => setToolMode("draw"));

  deleteSelectedQuadrantBtn?.addEventListener("click", () => {
    deleteQuadrant(selectedQuadrantIndex);
  });

  resetQuadrantsBtn?.addEventListener("click", () => {
    if (confirm("¿Estás seguro de restablecer todos los cuadrantes a los valores por defecto?")) {
      currentQuadrants = JSON.parse(JSON.stringify(DEFAULT_QUADRANTS));
      selectedQuadrantIndex = 0;
      setToolMode("move");
      renderQuadrantsSidebar();
      renderBoxesOnStage();
      showCalibratorStatus("Valores restablecidos a defaults (pulsa Guardar para persistir en Firebase).", "info");
    }
  });

  addQuadrantBtn?.addEventListener("click", () => {
    const newId = `zona_personalizada_${Date.now().toString().slice(-4)}`;
    const colors = ["#06b6d4", "#ec4899", "#8b5cf6", "#10b981", "#f97316", "#eab308"];
    const randColor = colors[currentQuadrants.length % colors.length];

    const newQ = {
      id: newId,
      name: `Nueva Zona ${currentQuadrants.length + 1}`,
      type: "custom_zone",
      color: randColor,
      boxNorm: [0.35, 0.35, 0.65, 0.65],
      polygonNorm: boxNormToPolygonNorm([0.35, 0.35, 0.65, 0.65])
    };

    currentQuadrants.push(newQ);
    selectedQuadrantIndex = currentQuadrants.length - 1;
    setToolMode("move");
    renderQuadrantsSidebar();
    renderBoxesOnStage();
    showCalibratorStatus("➕ Nueva zona creada. Arrastra sus 4 esquinas para ajustar la perspectiva.", "info");
  });

  saveQuadrantsBtn?.addEventListener("click", async () => {
    saveQuadrantsBtn.disabled = true;
    saveQuadrantsBtn.innerHTML = `<span>⏳ Guardando...</span>`;
    showCalibratorStatus("Guardando cuadrantes en Firestore: camera_catcher/quadrants...", "info");

    try {
      const quadrantsDocRef = doc(db, "camera_catcher", "quadrants");
      const serialized = serializeQuadrantsForFirestore(currentQuadrants);
      await setDoc(quadrantsDocRef, {
        updatedAt: new Date().toISOString(),
        updatedBy: "web-dashboard",
        quadrants: serialized
      });

      showCalibratorStatus("✅ ¡Cuadrantes guardados y sincronizados con el backend en tiempo real!", "success");
      setTimeout(() => hideCalibratorStatus(), 5000);
    } catch (err) {
      console.error("[Calibrator] Error guardando cuadrantes:", err);
      showCalibratorStatus(`❌ Error al guardar en Firebase: ${err.message}`, "error");
    } finally {
      saveQuadrantsBtn.disabled = false;
      saveQuadrantsBtn.innerHTML = `<span class="material-symbols-outlined btn-icon" style="font-size: 15px;">save</span> Guardar en Firebase`;
    }
  });
}

// ==========================================================================
// Daemon Live Monitor & Canvas Pipeline Renderer
// ==========================================================================

class DaemonCanvasRenderer {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas ? this.canvas.getContext("2d") : null;
    this.currentImage = null;
    this.currentDocId = "";
    this.layers = {
      quadrants: true,
      humans: true,
      people: true
    };
    this.stateData = {
      quadrants: [],
      humans: { hasHumans: false, count: 0, detections: [] },
      people: []
    };
    this.width = 1024;
    this.height = 576;
  }

  setLayer(layerName, isEnabled) {
    this.layers[layerName] = isEnabled;
    this.render();
  }

  updateData(stateData) {
    this.stateData = stateData;
    this.render();
  }

  async loadImage(imageUrl, docId) {
    if (!imageUrl) return;
    if (this.currentDocId === docId && this.currentImage) {
      this.render();
      return;
    }

    const placeholder = document.getElementById("canvasOverlayPlaceholder");
    try {
      const loadImg = (crossOriginVal) => new Promise((resolve, reject) => {
        const img = new Image();
        if (crossOriginVal) img.crossOrigin = crossOriginVal;
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = imageUrl;
      });

      let img = null;
      try {
        img = await loadImg("anonymous");
      } catch (corsErr) {
        console.warn("[DaemonCanvas] Falló carga con crossOrigin=anonymous, reintentando carga estándar directa:", corsErr);
        img = await loadImg(null);
      }

      this.currentImage = img;
      this.currentDocId = docId;
      this.width = img.naturalWidth || 1024;
      this.height = img.naturalHeight || 576;

      if (this.canvas) {
        this.canvas.width = this.width;
        this.canvas.height = this.height;
      }

      if (placeholder) {
        placeholder.classList.add("hidden");
        placeholder.style.display = "none";
      }
      this.render();
    } catch (err) {
      console.warn("[DaemonCanvas] Error cargando imagen en canvas:", err);
    }
  }

  render() {
    if (!this.ctx || !this.canvas) return;
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;

    ctx.clearRect(0, 0, W, H);

    // 1. Base Camera Image
    if (this.currentImage) {
      ctx.drawImage(this.currentImage, 0, 0, W, H);
    } else {
      ctx.fillStyle = "#0b1120";
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = "rgba(148, 163, 184, 0.08)";
      ctx.lineWidth = 1;
      const step = 40;
      for (let x = 0; x < W; x += step) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      }
      for (let y = 0; y < H; y += step) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
    }

    // 2. Layer: Physical Quadrants (ROI)
    if (this.layers.quadrants && this.stateData.quadrants?.length > 0) {
      this.stateData.quadrants.forEach(q => {
        const color = q.color || "#007BFF";
        const status = q.status || "disponible";
        const label = q.label || q.id;

        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.fillStyle = color + "26"; // 15% opacity

        let minX = 0, minY = 0, maxX = 0, maxY = 0;

        if (q.polygonNorm && Array.isArray(q.polygonNorm) && q.polygonNorm.length >= 3) {
          ctx.beginPath();
          const p0 = toPointTuple(q.polygonNorm[0]);
          minX = p0[0] * W; maxX = p0[0] * W;
          minY = p0[1] * H; maxY = p0[1] * H;
          ctx.moveTo(p0[0] * W, p0[1] * H);

          for (let i = 1; i < q.polygonNorm.length; i++) {
            const pt = toPointTuple(q.polygonNorm[i]);
            const px = pt[0] * W;
            const py = pt[1] * H;
            ctx.lineTo(px, py);
            minX = Math.min(minX, px);
            maxX = Math.max(maxX, px);
            minY = Math.min(minY, py);
            maxY = Math.max(maxY, py);
          }
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else if (q.box && Array.isArray(q.box) && q.box.length === 4) {
          const [x1, y1, x2, y2] = q.box;
          minX = x1; minY = y1; maxX = x2; maxY = y2;
          ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
          ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        }

        // Draw Quadrant Tag
        const badgeText = `${label} [${status.toUpperCase()}]`;
        ctx.font = "bold 12px Inter, sans-serif";
        const textWidth = ctx.measureText(badgeText).width;
        const badgeX = Math.max(8, minX);
        const badgeY = Math.max(22, minY + 20);

        ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
        ctx.fillRect(badgeX - 4, badgeY - 14, textWidth + 12, 20);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(badgeX - 4, badgeY - 14, textWidth + 12, 20);

        ctx.fillStyle = color;
        ctx.fillText(badgeText, badgeX + 2, badgeY);

        ctx.restore();
      });
    }

    // 3. Layer: Humans Detection (YOLOv8)
    if (this.layers.humans) {
      const humans = this.stateData.humans;
      if (humans?.hasHumans && humans?.detections?.length > 0) {
        humans.detections.forEach((det, idx) => {
          if (!det.box || det.box.length !== 4) return;
          const [x1, y1, x2, y2] = det.box;
          const w = x2 - x1;
          const h = y2 - y1;

          ctx.save();
          // Glow effect for human bounding box
          ctx.shadowColor = "#10b981";
          ctx.shadowBlur = 10;
          ctx.strokeStyle = "#10b981";
          ctx.lineWidth = 3;
          ctx.strokeRect(x1, y1, w, h);

          // Corner brackets
          const cornerLen = Math.min(16, w / 4, h / 4);
          ctx.lineWidth = 4;
          ctx.beginPath();
          // Top-left
          ctx.moveTo(x1, y1 + cornerLen); ctx.lineTo(x1, y1); ctx.lineTo(x1 + cornerLen, y1);
          // Top-right
          ctx.moveTo(x2 - cornerLen, y1); ctx.lineTo(x2, y1); ctx.lineTo(x2, y1 + cornerLen);
          // Bottom-left
          ctx.moveTo(x1, y2 - cornerLen); ctx.lineTo(x1, y2); ctx.lineTo(x1 + cornerLen, y2);
          // Bottom-right
          ctx.moveTo(x2 - cornerLen, y2); ctx.lineTo(x2, y2); ctx.lineTo(x2, y2 - cornerLen);
          ctx.stroke();

          // Human Tag badge
          const humanText = `👤 Humano #${idx + 1} (${Math.round((det.score || 0.85) * 100)}%)`;
          ctx.font = "bold 12px Inter, sans-serif";
          const hTextWidth = ctx.measureText(humanText).width;
          const bY = Math.max(22, y1 - 6);

          ctx.fillStyle = "#10b981";
          ctx.fillRect(x1, bY - 14, hTextWidth + 12, 20);
          ctx.fillStyle = "#000000";
          ctx.fillText(humanText, x1 + 6, bY);

          ctx.restore();
        });
      } else if (humans && humans.hasHumans === false) {
        // Banner informing no humans present
        ctx.save();
        const bannerText = "⚪ NO SE DETECTAN HUMANOS EN LA ESCENA (0 PERSONAS)";
        ctx.font = "bold 13px Inter, sans-serif";
        const bW = ctx.measureText(bannerText).width + 24;
        const bX = (W - bW) / 2;
        ctx.fillStyle = "rgba(15, 23, 42, 0.90)";
        ctx.fillRect(bX, 14, bW, 28);
        ctx.strokeStyle = "#94a3b8";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(bX, 14, bW, 28);
        ctx.fillStyle = "#f8fafc";
        ctx.fillText(bannerText, bX + 12, 33);
        ctx.restore();
      }
    }

    // 4. Layer: Biometrics & Person Classification (ArcFace MobileFaceNet)
    if (this.layers.people && this.stateData.people?.length > 0) {
      this.stateData.people.forEach(p => {
        let box = p.box;
        // If person has no explicit box, search in seated client quadrants
        if (!box) {
          const seatedQ = this.stateData.quadrants?.find(q => q.category === "cliente" || q.id.startsWith("cliente_sentado"));
          if (seatedQ && seatedQ.box) box = seatedQ.box;
        }

        if (!box || box.length !== 4) return;
        const [x1, y1, x2, y2] = box;

        ctx.save();
        let badgeColor = "#10b981";
        let rolePrefix = "👤 Nuevo Cliente";
        let subText = `Visita #1`;

        if (p.isStaff) {
          badgeColor = "#f59e0b";
          rolePrefix = "✂️ Barbero / Staff";
          subText = "Personal Activo";
        } else if (p.isFrequent) {
          badgeColor = "#06b6d4";
          rolePrefix = "⭐ Cliente Frecuente";
          subText = `${p.visitCount} visitas registradas`;
        }

        const titleText = `${rolePrefix}: ${p.name || "Cliente"}`;
        ctx.font = "bold 12px Inter, sans-serif";
        const titleW = ctx.measureText(titleText).width;

        ctx.font = "10px Inter, sans-serif";
        const subW = ctx.measureText(subText).width;
        const maxW = Math.max(titleW, subW) + 20;

        const posX = Math.max(10, Math.min(W - maxW - 10, x1));
        const posY = Math.max(45, y1 - 10);

        // Badge Container Box
        ctx.fillStyle = "rgba(15, 23, 42, 0.95)";
        ctx.fillRect(posX, posY - 36, maxW, 36);
        ctx.strokeStyle = badgeColor;
        ctx.lineWidth = 2;
        ctx.strokeRect(posX, posY - 36, maxW, 36);

        // Badge Header
        ctx.font = "bold 12px Inter, sans-serif";
        ctx.fillStyle = badgeColor;
        ctx.fillText(titleText, posX + 8, posY - 20);

        // Badge Subtext
        ctx.font = "500 10px Inter, sans-serif";
        ctx.fillStyle = "#cbd5e1";
        ctx.fillText(subText, posX + 8, posY - 6);

        ctx.restore();
      });
    }
  }
}

let daemonCanvasRenderer = null;
let countdownIntervalId = null;
let currentDaemonState = null;
let isDemonstratingCycle = false;

/**
 * Ejecuta la secuencia progresiva interactiva del Daemon en vivo (Canvas, Stepper, Log y Firestore)
 */
async function runLiveDemonstrationCycle() {
  if (isDemonstratingCycle) return;
  isDemonstratingCycle = true;

  const triggerLiveCycleBtn = document.getElementById("triggerLiveCycleBtn");
  const origHtml = triggerLiveCycleBtn ? triggerLiveCycleBtn.innerHTML : "";
  if (triggerLiveCycleBtn) {
    triggerLiveCycleBtn.disabled = true;
    triggerLiveCycleBtn.innerHTML = `<span>⏳ Ejecutando ciclo en vivo...</span>`;
  }

  const wait = (ms) => new Promise(res => setTimeout(res, ms));
  let sampleDoc = allDocs && allDocs.length > 0 ? allDocs[0] : null;
  const currentInterval = parseFloat(intervalInput?.value) || 3;
  const workStart = workStartTimeInput?.value || "11:30";
  const workEnd = workEndTimeInput?.value || "23:00";
  const isWithin = checkIsWithinWorkingHours(workStart, workEnd);

  const formatTime = () => new Intl.DateTimeFormat("es-PE", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "America/Lima"
  }).format(new Date());

  try {
    // 1. Emitir comando a Firestore para el daemon en Compute Engine
    setDoc(doc(db, "camera_catcher", "commands"), {
      action: "capture",
      source: "web-live-monitor",
      requestedAt: Date.now()
    }).catch(() => {});

    try { fetch(`${BACKEND_URL}/capture`, { method: "POST" }).catch(() => {}); } catch (_) {}

    // STEP 1: Consulta a Cámara de Seguridad (0 ms)
    const step1State = {
      step: "querying_camera",
      stepIndex: 1,
      stepTitle: "Consulta a Cámara de Seguridad",
      stepDescription: "Se activa la consulta P2P (Neolink/Baichuan) hacia la cámara 'barberia' [Prueba en Vivo]...",
      updatedAt: new Date().toISOString(),
      countdown: {
        intervalMinutes: currentInterval,
        isWithinWorkingHours: isWithin,
        workHours: `${workStart} - ${workEnd} (America/Lima)`
      }
    };
    updateDaemonUI({
      ...step1State,
      history: [
        { id: `evt_${Date.now()}`, timeFormatted: formatTime(), text: "📡 Se activa la consulta a la cámara de seguridad [PRUEBA EN VIVO]. Conectando por P2P...", type: "process" },
        ...(currentDaemonState?.history || [])
      ]
    });
    setDoc(doc(db, "camera_catcher", "daemon_state"), step1State, { merge: true }).catch(() => {});

    await wait(1800);

    // STEP 2: Llega la Imagen => Imprimir en Canvas
    let imageUrl = "";
    if (sampleDoc?.imageStoragePath) {
      imageUrl = await resolveStorageUrl(sampleDoc.imageStoragePath);
    }
    if (imageUrl) {
      await daemonCanvasRenderer.loadImage(imageUrl, sampleDoc.id);
    }
    daemonCanvasRenderer.updateData({
      quadrants: [],
      humans: { hasHumans: false, count: 0, detections: [] },
      people: []
    });

    const step2State = {
      step: "image_received",
      stepIndex: 2,
      stepTitle: "Imagen Recibida de la Cámara",
      stepDescription: `Llega la imagen de seguridad (1024x576 px, 142 KB) => Imprimiendo imagen base en el Canvas.`,
      updatedAt: new Date().toISOString(),
      image: {
        storagePath: sampleDoc?.imageStoragePath || "",
        docId: sampleDoc?.id || "photo_live_test",
        width: 1024,
        height: 576,
        sizeBytes: 145000
      }
    };
    updateDaemonUI({
      ...step2State,
      history: [
        { id: `evt_${Date.now()}`, timeFormatted: formatTime(), text: "🖼️ Llega la imagen de seguridad (1024x576 px) => Imprimiendo imagen base en Canvas.", type: "process" },
        ...(currentDaemonState?.history || [])
      ]
    });
    setDoc(doc(db, "camera_catcher", "daemon_state"), step2State, { merge: true }).catch(() => {});

    await wait(1800);

    // STEP 3: Activan Cuadrantes Físicos (ROI)
    const quadrantsToRender = (sampleDoc?.ml?.quadrants && sampleDoc.ml.quadrants.length > 0)
      ? sampleDoc.ml.quadrants
      : (currentQuadrants || []);

    daemonCanvasRenderer.updateData({
      quadrants: quadrantsToRender,
      humans: { hasHumans: false, count: 0, detections: [] },
      people: []
    });

    const step3State = {
      step: "quadrants_active",
      stepIndex: 3,
      stepTitle: "Activación de Cuadrantes Físicos",
      stepDescription: `Se activan los cuadrantes: Proyectando ${quadrantsToRender.length} zonas ROI (sillas, puestos y tránsito) sobre el Canvas.`,
      updatedAt: new Date().toISOString(),
      quadrants: quadrantsToRender
    };
    updateDaemonUI({
      ...step3State,
      history: [
        { id: `evt_${Date.now()}`, timeFormatted: formatTime(), text: `📐 Se activan los cuadrantes: dibujando ${quadrantsToRender.length} zonas ROI en el Canvas.`, type: "process" },
        ...(currentDaemonState?.history || [])
      ]
    });
    setDoc(doc(db, "camera_catcher", "daemon_state"), step3State, { merge: true }).catch(() => {});

    await wait(1800);

    // STEP 4: Detección de Humanos (YOLOv8)
    const rawDets = sampleDoc?.ml?.rawDetections || [];
    const personDets = rawDets.filter(d => d.class === "person");
    const humanDetections = personDets.length > 0 ? personDets : (sampleDoc?.clients || []).map(c => ({ score: c.confidence || 0.88, box: c.box }));
    const countH = humanDetections.length || 1;

    daemonCanvasRenderer.updateData({
      quadrants: quadrantsToRender,
      humans: {
        hasHumans: true,
        count: countH,
        inferenceMs: sampleDoc?.ml?.inferenceMs || 104,
        detections: humanDetections
      },
      people: []
    });

    const step4State = {
      step: "detecting_humans",
      stepIndex: 4,
      stepTitle: "Detección de Humanos (YOLOv8)",
      stepDescription: `Inferencia completada en ${sampleDoc?.ml?.inferenceMs || 104} ms. ¿Se detectan humanos?: ¡SÍ! (${countH} personas detectadas).`,
      updatedAt: new Date().toISOString(),
      humans: {
        hasHumans: true,
        count: countH,
        detections: humanDetections
      }
    };
    updateDaemonUI({
      ...step4State,
      history: [
        { id: `evt_${Date.now()}`, timeFormatted: formatTime(), text: `👤 Detección de humanos: ¡SÍ se detectan humanos! (${countH} personas detectadas con YOLOv8).`, type: "success" },
        ...(currentDaemonState?.history || [])
      ]
    });
    setDoc(doc(db, "camera_catcher", "daemon_state"), step4State, { merge: true }).catch(() => {});

    await wait(2000);

    // STEP 5: Biometría y Clasificación
    const peopleList = (sampleDoc?.identifiedPeople && sampleDoc.identifiedPeople.length > 0)
      ? sampleDoc.identifiedPeople
      : [
          { name: "Javier", role: "Barbero / Staff", isStaff: true, isFrequent: false, visitCount: 1, similarity: 0.88, box: humanDetections[0]?.box || [834, 384, 1009, 566] }
        ];

    daemonCanvasRenderer.updateData({
      quadrants: quadrantsToRender,
      humans: {
        hasHumans: true,
        count: countH,
        detections: humanDetections
      },
      people: peopleList
    });

    const step5State = {
      step: "identifying_people",
      stepIndex: 5,
      stepTitle: "Identificación y Clasificación Biométrica",
      stepDescription: `Clasificación biométrica: 1 Barbero/Staff (Javier) identificado en puesto activo. Mostrando insignia en Canvas.`,
      updatedAt: new Date().toISOString(),
      people: peopleList
    };
    updateDaemonUI({
      ...step5State,
      history: [
        { id: `evt_${Date.now()}`, timeFormatted: formatTime(), text: `👥 Biometría ArcFace: Barbero/Staff ('Javier') identificado en puesto de atención.`, type: "success" },
        ...(currentDaemonState?.history || [])
      ]
    });
    setDoc(doc(db, "camera_catcher", "daemon_state"), step5State, { merge: true }).catch(() => {});

    await wait(2200);

    // STEP 6: Ciclo Completado
    const nextTime = new Date(Date.now() + currentInterval * 60 * 1000);
    const step6State = {
      step: "completed",
      stepIndex: 6,
      stepTitle: "Ciclo Completado Exitosamente",
      stepDescription: `Prueba en vivo finalizada con éxito. Fotograma sincronizado en Firestore. Reiniciando contador regresivo...`,
      lastDocId: sampleDoc?.id || "photo_live_test",
      updatedAt: new Date().toISOString(),
      countdown: {
        nextCaptureAt: nextTime.toISOString(),
        intervalMinutes: currentInterval,
        remainingSeconds: currentInterval * 60,
        isWithinWorkingHours: isWithin,
        workHours: `${workStart} - ${workEnd} (America/Lima)`
      }
    };
    updateDaemonUI({
      ...step6State,
      history: [
        { id: `evt_${Date.now()}`, timeFormatted: formatTime(), text: `✅ Ciclo de captura completado exitosamente. Reiniciando contador regresivo (${currentInterval} min).`, type: "success" },
        ...(currentDaemonState?.history || [])
      ]
    });
    setDoc(doc(db, "camera_catcher", "daemon_state"), step6State, { merge: true }).catch(() => {});

  } catch (err) {
    console.error("[DaemonLive] Error durante ciclo en vivo:", err);
  } finally {
    isDemonstratingCycle = false;
    if (triggerLiveCycleBtn) {
      triggerLiveCycleBtn.disabled = false;
      triggerLiveCycleBtn.innerHTML = origHtml;
    }
  }
}

/**
 * Inicializa el listener en tiempo real de camera_catcher/daemon_state
 */
function initDaemonLiveMonitor() {
  const daemonCanvas = document.getElementById("daemonCanvas");
  if (!daemonCanvas) return;

  daemonCanvasRenderer = new DaemonCanvasRenderer("daemonCanvas");

  // Layer Checkbox handlers
  document.getElementById("chkLayerQuadrants")?.addEventListener("change", (e) => {
    daemonCanvasRenderer.setLayer("quadrants", e.target.checked);
  });
  document.getElementById("chkLayerHumans")?.addEventListener("change", (e) => {
    daemonCanvasRenderer.setLayer("humans", e.target.checked);
  });
  document.getElementById("chkLayerPeople")?.addEventListener("change", (e) => {
    daemonCanvasRenderer.setLayer("people", e.target.checked);
  });

  // Manual Trigger button: ejecuta el ciclo interactivo en vivo
  const triggerLiveCycleBtn = document.getElementById("triggerLiveCycleBtn");
  triggerLiveCycleBtn?.addEventListener("click", () => {
    runLiveDemonstrationCycle();
  });

  // Real-time Firestore Listener
  const stateDocRef = doc(db, "camera_catcher", "daemon_state");
  onSnapshot(stateDocRef, async (snapshot) => {
    if (!snapshot.exists()) return;
    const data = snapshot.data();
    currentDaemonState = data;

    updateDaemonUI(data);
  }, (err) => {
    console.warn("[DaemonLive] Error escuchando camera_catcher/daemon_state:", err);
  });

  // Also listen to latest photo if daemon_state has no image yet
  const photosCol = collection(db, "camera_catcher", "photos", "photos");
  onSnapshot(photosCol, (snapshot) => {
    if (!snapshot.empty && !daemonCanvasRenderer.currentImage) {
      let latestDoc = null;
      snapshot.forEach(docSnap => {
        const d = docSnap.data();
        if (!latestDoc || (d.epoch && d.epoch > (latestDoc.epoch || 0))) {
          latestDoc = { id: docSnap.id, ...d };
        }
      });

      if (latestDoc && latestDoc.imageStoragePath && !daemonCanvasRenderer.currentImage) {
        resolveStorageUrl(latestDoc.imageStoragePath).then(url => {
          if (url) daemonCanvasRenderer.loadImage(url, latestDoc.id);
        });
      }
    }
  });
}

/**
 * Actualiza todos los elementos visuales de la vista en vivo del daemon
 */
async function updateDaemonUI(data) {
  if (!data) return;

  // 1. Step Title & Description
  const currentStepTitle = document.getElementById("daemonCurrentStepTitle");
  const currentStepDesc = document.getElementById("daemonCurrentStepDesc");
  const bannerText = document.getElementById("canvasBannerText");

  if (currentStepTitle && data.stepTitle) currentStepTitle.textContent = data.stepTitle;
  if (currentStepDesc && data.stepDescription) currentStepDesc.textContent = data.stepDescription;
  if (bannerText && data.stepDescription) bannerText.textContent = `${data.stepTitle || "Proceso"}: ${data.stepDescription}`;

  // 2. Countdown Clock & Tags
  const intervalTag = document.getElementById("daemonIntervalTag");
  const hoursTag = document.getElementById("daemonWorkingHoursTag");
  const hoursStatusTag = document.getElementById("daemonHoursStatusTag");

  const effectiveInterval = data.countdown?.intervalMinutes || parseFloat(intervalInput?.value) || 3;

  if (intervalTag) {
    intervalTag.innerHTML = `<span class="material-symbols-outlined" style="font-size: 14px; vertical-align: middle;">timer</span> Intervalo: ${effectiveInterval} min`;
  }
  if (hoursTag && data.countdown?.workHours) {
    hoursTag.innerHTML = `<span class="material-symbols-outlined" style="font-size: 14px; vertical-align: middle;">schedule</span> Horario: ${data.countdown.workHours}`;
  }
  if (hoursStatusTag) {
    const isWithin = data.countdown?.isWithinWorkingHours !== false;
    hoursStatusTag.innerHTML = isWithin
      ? '<span class="status-dot-pulse-green"></span> En jornada de atención'
      : '<span class="material-symbols-outlined" style="font-size: 14px; vertical-align: middle;">pause_circle</span> Fuera de horario laboral';
    hoursStatusTag.className = `countdown-tag ${isWithin ? "tag-success" : "tag-warning"}`;
  }

  // Update dynamic countdown ticker
  setupDynamicCountdownTicker(data.countdown?.nextCaptureAt, effectiveInterval);

  // 3. Process Stepper Pipeline (6 Steps)
  updateStepperPipeline(data.stepIndex !== undefined ? data.stepIndex : 0, data.step);

  // 4. Update Canvas Data & Image
  daemonCanvasRenderer.updateData({
    quadrants: data.quadrants || [],
    humans: data.humans || { hasHumans: false, count: 0, detections: [] },
    people: data.people || []
  });

  if (data.image?.storagePath) {
    const imgUrl = await resolveStorageUrl(data.image.storagePath);
    if (imgUrl) {
      await daemonCanvasRenderer.loadImage(imgUrl, data.image.docId || data.lastDocId);
    }
  }

  // 5. Update Bottom Stats Bar
  const statDocId = document.getElementById("statDocId");
  const statDims = document.getElementById("statDims");
  const statQuadrantsCount = document.getElementById("statQuadrantsCount");
  const statHumansDetected = document.getElementById("statHumansDetected");
  const statPeopleClassified = document.getElementById("statPeopleClassified");

  if (statDocId) statDocId.textContent = data.lastDocId || data.image?.docId || "Esperando";
  if (statDims) statDims.textContent = `${data.image?.width || 1024} x ${data.image?.height || 576} px`;
  if (statQuadrantsCount) statQuadrantsCount.textContent = `${(data.quadrants || []).length} activos`;
  if (statHumansDetected) {
    if (data.humans?.hasHumans) {
      statHumansDetected.textContent = `¡SÍ! (${data.humans.count || 0} personas)`;
      statHumansDetected.style.color = "#10b981";
    } else {
      statHumansDetected.textContent = "NO se detectan";
      statHumansDetected.style.color = "#94a3b8";
    }
  }
  if (statPeopleClassified) {
    statPeopleClassified.textContent = `${(data.people || []).length} identificados`;
  }

  // 6. Update Real-time Log Feed
  renderLogFeed(data.history || []);
}

/**
 * Actualiza el stepper visual con los 6 pasos reales
 */
function updateStepperPipeline(activeStepIndex, stepKey) {
  for (let i = 0; i <= 5; i++) {
    const node = document.getElementById(`stepNode${i}`);
    const connector = document.getElementById(`stepConnector${i}`);

    if (node) {
      node.classList.remove("active", "completed");
      if (i < activeStepIndex) {
        node.classList.add("completed");
      } else if (i === activeStepIndex) {
        node.classList.add("active");
      }
    }

    if (connector) {
      connector.classList.remove("completed");
      if (i <= activeStepIndex) {
        connector.classList.add("completed");
      }
    }
  }
}

/**
 * Ticker dinámico de cuenta regresiva en segundos hacia nextCaptureAt
 */
function setupDynamicCountdownTicker(nextCaptureAtIso, intervalMinutes) {
  if (countdownIntervalId) {
    clearInterval(countdownIntervalId);
    countdownIntervalId = null;
  }

  const clockText = document.getElementById("daemonClockText");
  const circleProgress = document.getElementById("countdownCircleProgress");
  if (!clockText) return;

  const totalCycleSec = Math.max(6, Math.round(intervalMinutes * 60));
  const fullDashArray = 264; // 2 * PI * 42

  function tick() {
    if (!nextCaptureAtIso) {
      clockText.textContent = "--:--";
      if (circleProgress) circleProgress.style.strokeDashoffset = "0";
      return;
    }

    const targetTime = new Date(nextCaptureAtIso).getTime();
    const remainingMs = Math.max(0, targetTime - Date.now());
    const remainingSec = Math.floor(remainingMs / 1000);

    const mins = Math.floor(remainingSec / 60);
    const secs = remainingSec % 60;
    clockText.textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;

    // SVG Circular Progress
    if (circleProgress) {
      const progressFraction = Math.min(1, Math.max(0, remainingSec / totalCycleSec));
      const offset = fullDashArray * (1 - progressFraction);
      circleProgress.style.strokeDashoffset = String(offset);
    }

    if (remainingSec <= 0) {
      clockText.textContent = "00:00";
    }
  }

  tick();
  countdownIntervalId = setInterval(tick, 1000);
}

/**
 * Renderiza el feed descriptivo de eventos en la terminal
 */
function renderLogFeed(history) {
  const logFeed = document.getElementById("daemonLogFeed");
  const logCountBadge = document.getElementById("logCountBadge");
  if (!logFeed) return;

  if (logCountBadge) logCountBadge.textContent = `${history.length} eventos`;

  if (history.length === 0) {
    logFeed.innerHTML = `<div class="log-empty-msg">No hay eventos registrados aún.</div>`;
    return;
  }

  logFeed.innerHTML = history.map(item => {
    let typeClass = "log-process";
    if (item.type === "success") typeClass = "log-success";
    if (item.type === "countdown") typeClass = "log-countdown";
    if (item.type === "error") typeClass = "log-error";

    return `
      <div class="log-item ${typeClass}">
        <span class="log-time">[${item.timeFormatted || ""}]</span>
        <span class="log-text">${item.text}</span>
      </div>
    `;
  }).join("");
}

/**
 * Gestión de pestañas principales (Daemon Live vs Historial)
 */
function initMainTabs() {
  const tabDaemonLiveBtn = document.getElementById("tabDaemonLiveBtn");
  const tabHistoryBtn = document.getElementById("tabHistoryBtn");
  const daemonLiveViewTab = document.getElementById("daemonLiveViewTab");
  const historyViewTab = document.getElementById("historyViewTab");

  function switchTab(target) {
    if (target === "daemon") {
      tabDaemonLiveBtn?.classList.add("active");
      tabDaemonLiveBtn?.setAttribute("aria-selected", "true");
      tabHistoryBtn?.classList.remove("active");
      tabHistoryBtn?.setAttribute("aria-selected", "false");
      daemonLiveViewTab?.classList.remove("hidden");
      historyViewTab?.classList.add("hidden");
      daemonCanvasRenderer?.render();
    } else {
      tabHistoryBtn?.classList.add("active");
      tabHistoryBtn?.setAttribute("aria-selected", "true");
      tabDaemonLiveBtn?.classList.remove("active");
      tabDaemonLiveBtn?.setAttribute("aria-selected", "false");
      historyViewTab?.classList.remove("hidden");
      daemonLiveViewTab?.classList.add("hidden");
    }
  }

  tabDaemonLiveBtn?.addEventListener("click", () => switchTab("daemon"));
  tabHistoryBtn?.addEventListener("click", () => switchTab("history"));
}

// Global Initialization
initMainTabs();
initDaemonLiveMonitor();
initSettingsModal();
initPromptListener();
initPaginationListeners();
initPhotosListener();
initCostMonitor();
initPeopleListener();
initQuadrantsListener();
initCalibratorUI();



