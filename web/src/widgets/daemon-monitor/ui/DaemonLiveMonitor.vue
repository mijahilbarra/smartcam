<script setup>
import { ref, onMounted, onUnmounted, watch, computed } from 'vue';
import AppIcon from '@/shared/ui/atoms/AppIcon.vue';
import AppButton from '@/shared/ui/atoms/AppButton.vue';
import AppBadge from '@/shared/ui/atoms/AppBadge.vue';
import StatusPill from '@/shared/ui/molecules/StatusPill.vue';
import StatPill from '@/shared/ui/molecules/StatPill.vue';
import { useDaemonState } from '@/entities/daemon/model/useDaemonState';
import { useQuadrants } from '@/entities/quadrant/model/useQuadrants';
import { hexToRgba, toPointObject, ensureNorm01, boxNormToPolygonNorm } from '@/shared/lib/geometry';
import { IS_LOCAL_ENV } from '@/shared/api/firebase';
import TodayScheduleWidget from '@/widgets/today-schedule/ui/TodayScheduleWidget.vue';

const emit = defineEmits(['open-settings', 'open-calibrator', 'switch-tab']);

const {
  daemonState,
  isConnected,
  isYoloStreaming,
  statusLabel,
  streamUrl,
  snapshotUrl,
  activeBackendUrl,
  canvasImageData,
  activeChairSessions,
  analysisDecisions,
  clientsInCut,
  clientsWaiting,
  activeBarbers,
  totalHumans,
  logs,
  addLog
} = useDaemonState();

const { quadrants: configuredQuadrants } = useQuadrants();

// Viewport & canvas refs
const viewportRef = ref(null);
const canvasRef = ref(null);

// Layers switches
const showQuadrants = ref(true);
const showHumans = ref(true);
const showBiometry = ref(true);

// Reloj y estilos para las notificaciones flotantes (toasts) de decisiones del análisis (15s)
const nowMs = ref(Date.now());
const dismissedDecisionIds = ref(new Set());
let decisionTicker = null;

const decisionStyles = {
  success: { border: 'border-emerald-500/60', bg: 'from-emerald-950/95 via-slate-900/95 to-slate-950/95', text: 'text-emerald-300', bar: 'bg-emerald-400', icon: 'check_circle' },
  info: { border: 'border-sky-500/60', bg: 'from-sky-950/95 via-slate-900/95 to-slate-950/95', text: 'text-sky-300', bar: 'bg-sky-400', icon: 'merge' },
  warning: { border: 'border-amber-500/60', bg: 'from-amber-950/95 via-slate-900/95 to-slate-950/95', text: 'text-amber-300', bar: 'bg-amber-400', icon: 'report' },
  neutral: { border: 'border-slate-600/80', bg: 'from-slate-900/95 to-slate-950/95', text: 'text-slate-300', bar: 'bg-slate-400', icon: 'info' }
};
const getDecisionStyle = (d) => decisionStyles[d?.tone] || decisionStyles.neutral;

const dismissDecision = (id) => {
  dismissedDecisionIds.value = new Set([...dismissedDecisionIds.value, id]);
};

const activeDecisions = computed(() =>
  (Array.isArray(analysisDecisions.value) ? analysisDecisions.value : []).filter(
    (d) => d.expiresAt > nowMs.value && !dismissedDecisionIds.value.has(d.id)
  )
);

// Stream & image loading state
const streamKey = ref(Date.now());
const streamActive = ref(true);
const streamLoaded = ref(false);
const currentLoadedImage = ref(null);
let snapshotIntervalId = null;
let isFetchingSnapshot = false;

const fetchSnapshotFallback = async () => {
  const backend = activeBackendUrl.value;
  if (!backend || isFetchingSnapshot) return;
  isFetchingSnapshot = true;
  const snapUrl = `${backend}/api/snapshot?t=${Date.now()}`;
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((resolve, reject) => {
      img.onload = () => resolve(img);
      img.onerror = () => {
        const fallbackImg = new Image();
        fallbackImg.onload = () => resolve(fallbackImg);
        fallbackImg.onerror = reject;
        fallbackImg.src = snapUrl;
      };
      img.src = snapUrl;
    });
    currentLoadedImage.value = img;
    renderCanvas();
  } catch (err) {
    // Continuar polling silenciosamente si el backend aún no responde
  } finally {
    isFetchingSnapshot = false;
  }
};

const startSnapshotFallback = () => {
  if (snapshotIntervalId) return;
  fetchSnapshotFallback();
  snapshotIntervalId = setInterval(() => {
    // Si el stream MJPEG ya está activo y cargado, no saturar la red con polling continuo
    if (streamActive.value && streamLoaded.value) return;
    fetchSnapshotFallback();
  }, 500);
};

const stopSnapshotFallback = () => {
  if (snapshotIntervalId) {
    clearInterval(snapshotIntervalId);
    snapshotIntervalId = null;
  }
};

const onStreamLoad = () => {
  streamLoaded.value = true;
  streamActive.value = true;
  renderCanvas();
};

const reloadStream = () => {
  if (!streamUrl.value) return;
  streamLoaded.value = false;
  streamActive.value = false;
  streamKey.value = Date.now();
  fetchSnapshotFallback();
  setTimeout(() => {
    if (streamUrl.value) {
      streamActive.value = true;
    }
  }, 150);
};

const onStreamError = () => {
  streamActive.value = false;
  streamLoaded.value = false;
  // El fallback de snapshot toma el relevo inmediatamente
  fetchSnapshotFallback();
  if (!streamUrl.value) return;
  console.info('[LiveStream] Reconectando flujo MJPEG...');
  setTimeout(() => {
    if (streamUrl.value) {
      streamKey.value = Date.now();
      streamActive.value = true;
    }
  }, 2500);
};

// Reconectar y reactivar el stream automáticamente cuando streamUrl cambie
watch(streamUrl, (newUrl) => {
  if (newUrl) {
    streamActive.value = true;
    streamLoaded.value = false;
    streamKey.value = Date.now();
    startSnapshotFallback();
  } else {
    streamActive.value = false;
    streamLoaded.value = false;
  }
});

const toggleFullscreen = () => {
  if (!viewportRef.value) return;
  if (!document.fullscreenElement) {
    viewportRef.value.requestFullscreen().catch((err) => {
      console.warn('[Fullscreen] Error solicitando pantalla completa:', err.message);
    });
  } else {
    document.exitFullscreen().catch(() => {});
  }
};

// Render telemetry overlays on canvas
const renderCanvas = () => {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;

  // Clear canvas
  ctx.clearRect(0, 0, W, H);

  // If live stream is NOT actively loaded or playing, render latest fallback frame or dark grid as background
  if (!streamActive.value || !streamLoaded.value) {
    if (currentLoadedImage.value) {
      ctx.drawImage(currentLoadedImage.value, 0, 0, W, H);
    } else {
      ctx.fillStyle = '#0b1120';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
      ctx.lineWidth = 1;
      for (let x = 0; x < W; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      }
      for (let y = 0; y < H; y += 40) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
    }
  }

  // 1. Draw Quadrants Layer (Physical Sillas and Zones)
  if (showQuadrants.value && configuredQuadrants.value?.length) {
    const telemetryQuadrants = canvasImageData.value.quadrants || daemonState.value?.quadrants || [];

    configuredQuadrants.value.forEach((zone) => {
      const matches = telemetryQuadrants.filter(t => t.id === zone.id || t.zoneId === zone.id);

      let dynamicStatus = 'disponible';
      if (zone.type === 'walking_zone') {
        dynamicStatus = 'despejado';
      }

      if (matches.length > 0) {
        if (matches.some(m => m.status === 'en_corte')) {
          dynamicStatus = 'en_corte';
        } else if (matches.some(m => m.status === 'en_servicio')) {
          dynamicStatus = 'en_servicio';
        } else if (matches.some(m => m.status === 'en_transito')) {
          dynamicStatus = 'en_transito';
        } else if (matches.some(m => m.status === 'en_espera')) {
          dynamicStatus = 'en_espera';
        } else if (matches.some(m => m.status === 'ocupada')) {
          dynamicStatus = 'ocupada';
        } else if (matches[0]?.status) {
          dynamicStatus = matches[0].status;
        }
      }

      const color = zone.color || '#3b82f6';
      const poly = (zone.polygonNorm && zone.polygonNorm.length >= 3)
        ? zone.polygonNorm
        : (zone.boxNorm ? boxNormToPolygonNorm(zone.boxNorm) : []);

      if (poly.length >= 3) {
        ctx.beginPath();
        poly.forEach((pt, i) => {
          const ptObj = toPointObject(pt);
          const x = ptObj.x * W;
          const y = ptObj.y * H;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();

        const isOccupied = dynamicStatus === 'ocupada' || dynamicStatus === 'en_corte' || dynamicStatus === 'en_servicio' || dynamicStatus === 'en_transito';
        ctx.fillStyle = hexToRgba(color, isOccupied ? 0.32 : 0.16);
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = isOccupied ? 2.5 : 1.5;
        ctx.stroke();

        // Label with dynamic business status
        const firstPt = toPointObject(poly[0]);
        const lx = Math.max(8, Math.min(W - 180, firstPt.x * W + 4));
        const ly = Math.max(18, Math.min(H - 8, firstPt.y * H + 18));

        const statusMap = {
          'en_corte': 'En corte',
          'ocupada': 'Ocupada',
          'en_servicio': 'En servicio',
          'en_transito': 'En tránsito',
          'en_espera': 'En espera',
          'despejado': 'Despejado',
          'disponible': 'Disponible'
        };
        const statusPretty = statusMap[dynamicStatus] || dynamicStatus;
        const text = `${zone.badge || zone.name || 'Zona'} [${statusPretty}]`;

        ctx.font = 'bold 11px Inter, sans-serif';
        const textWidth = ctx.measureText(text).width;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
        ctx.fillRect(lx - 2, ly - 13, textWidth + 8, 18);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(lx - 2, ly - 13, textWidth + 8, 18);

        ctx.fillStyle = color;
        ctx.fillText(text, lx + 2, ly);
      }
    });
  }

  // 2. Draw Animated Humans Layer (Smooth 60 FPS Sliding Interpolation)
  if (showHumans.value) {
    for (const t of animatedTracks.values()) {
      if (t.opacity <= 0.01) continue;

      const x = t.current.xmin * W;
      const y = t.current.ymin * H;
      const w = Math.max(12, (t.current.xmax - t.current.xmin) * W);
      const h = Math.max(16, (t.current.ymax - t.current.ymin) * H);

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, t.opacity));

      // 1. Primary Bounding Box
      ctx.strokeStyle = t.strokeColor;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);

      // 2. Cyber Reticle Corners (Estilo Computer Vision Target)
      const cornerLen = Math.min(14, w * 0.25, h * 0.25);
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ffffff';

      // Top-Left
      ctx.beginPath(); ctx.moveTo(x, y + cornerLen); ctx.lineTo(x, y); ctx.lineTo(x + cornerLen, y); ctx.stroke();
      // Top-Right
      ctx.beginPath(); ctx.moveTo(x + w - cornerLen, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + cornerLen); ctx.stroke();
      // Bottom-Left
      ctx.beginPath(); ctx.moveTo(x, y + h - cornerLen); ctx.lineTo(x, y + h); ctx.lineTo(x + cornerLen, y + h); ctx.stroke();
      // Bottom-Right
      ctx.beginPath(); ctx.moveTo(x + w - cornerLen, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + h - cornerLen); ctx.stroke();

      // 3. Person Track & Quadrant Tag
      ctx.font = 'bold 11px Inter, sans-serif';
      const tagW = ctx.measureText(t.tagText).width + 12;

      ctx.fillStyle = t.tagBg;
      ctx.fillRect(x, Math.max(0, y - 20), tagW, 20);
      ctx.strokeStyle = t.strokeColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(x, Math.max(0, y - 20), tagW, 20);

      ctx.fillStyle = '#ffffff';
      ctx.fillText(t.tagText, x + 6, Math.max(14, y - 6));
      ctx.restore();
    }
  }

  // 3. Draw Animated Biometry Layer (Staff, Frequent, New Customer Badges)
  if (showBiometry.value) {
    for (const p of animatedPeople.values()) {
      if (p.opacity <= 0.01) continue;

      const x = p.current.xmin * W;
      const y = p.current.ymin * H;
      const w = Math.max(12, (p.current.xmax - p.current.xmin) * W);
      const h = Math.max(16, (p.current.ymax - p.current.ymin) * H);

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, p.opacity));

      ctx.strokeStyle = p.badgeColor;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);

      // Biometry insignia banner
      ctx.font = 'bold 11px Inter, sans-serif';
      const labelW = ctx.measureText(p.labelText).width + 12;

      ctx.fillStyle = p.badgeBg;
      ctx.fillRect(x, Math.min(H - 20, y + h + 2), labelW, 20);
      ctx.strokeStyle = p.badgeColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(x, Math.min(H - 20, y + h + 2), labelW, 20);

      ctx.fillStyle = p.badgeColor;
      ctx.fillText(p.labelText, x + 6, Math.min(H - 6, y + h + 16));
      ctx.restore();
    }
  }
};

// State for smooth 60 FPS interpolated bounding boxes
const animatedTracks = new Map();
const animatedPeople = new Map();
let animationFrameId = null;

const syncIncomingTelemetry = (telemetry) => {
  if (!telemetry) return;
  const frameW = telemetry.frameWidth || 640;
  const frameH = telemetry.frameHeight || 360;

  // 1. Sync Humans / Tracks
  const tracksToDraw = (telemetry.tracks && telemetry.tracks.length > 0)
    ? telemetry.tracks
    : (telemetry.humanBoxes || []).map((b, idx) => ({ trackId: idx + 1, box: b }));

  const activeTrackKeys = new Set();

  tracksToDraw.forEach((t, idx) => {
    const trackKey = t.trackId ? `track_${t.trackId}` : `box_${idx}`;
    activeTrackKeys.add(trackKey);

    let xmin, ymin, xmax, ymax;
    if (t.boxNorm && Array.isArray(t.boxNorm) && t.boxNorm.length === 4) {
      ymin = t.boxNorm[0]; xmin = t.boxNorm[1]; ymax = t.boxNorm[2]; xmax = t.boxNorm[3];
    } else if (t.box && Array.isArray(t.box) && t.box.length === 4) {
      const b = t.box;
      if (b[0] <= 1 && b[1] <= 1 && b[2] <= 1 && b[3] <= 1) {
        ymin = b[0]; xmin = b[1]; ymax = b[2]; xmax = b[3];
      } else {
        xmin = b[0] / frameW; ymin = b[1] / frameH;
        xmax = b[2] / frameW; ymax = b[3] / frameH;
      }
    } else {
      return;
    }

    xmin = Math.max(0, Math.min(1, xmin));
    ymin = Math.max(0, Math.min(1, ymin));
    xmax = Math.max(0, Math.min(1, xmax));
    ymax = Math.max(0, Math.min(1, ymax));

    const isStaff = t.identity?.isStaff;
    const isFrequent = t.identity?.isFrequent;
    const strokeColor = isStaff ? '#38bdf8' : (isFrequent ? '#fbbf24' : '#10b981');
    const tagBg = isStaff ? 'rgba(12, 74, 110, 0.92)' : (isFrequent ? 'rgba(120, 53, 15, 0.92)' : 'rgba(6, 78, 59, 0.92)');
    const confText = t.confidence ? ` ${Math.round(t.confidence * 100)}%` : '';
    const quadText = t.quadrant ? ` [${t.quadrant}]` : '';
    const idText = t.identity?.name ? ` • ${t.identity.name}` : '';
    const tagText = `YOLO #${t.trackId || idx + 1}${quadText}${idText}${confText}`;

    const existing = animatedTracks.get(trackKey);
    if (existing) {
      existing.target = { xmin, ymin, xmax, ymax };
      existing.targetOpacity = 1.0;
      existing.lastSeen = Date.now();
      existing.strokeColor = strokeColor;
      existing.tagBg = tagBg;
      existing.tagText = tagText;
    } else {
      animatedTracks.set(trackKey, {
        current: { xmin, ymin, xmax, ymax },
        target: { xmin, ymin, xmax, ymax },
        opacity: 0.1,
        targetOpacity: 1.0,
        lastSeen: Date.now(),
        strokeColor,
        tagBg,
        tagText
      });
    }
  });

  // Fade out tracks no longer present
  for (const [key, track] of animatedTracks.entries()) {
    if (!activeTrackKeys.has(key)) {
      track.targetOpacity = 0.0;
    }
  }

  // 2. Sync Biometry / People Identified
  const activePeopleKeys = new Set();
  const people = telemetry.peopleIdentified || [];

  people.forEach((p, idx) => {
    if (!p.box) return;
    const personKey = p.personId || p.name ? `p_${p.personId || p.name}` : `p_idx_${idx}`;
    activePeopleKeys.add(personKey);

    let pXmin, pYmin, pXmax, pYmax;
    if (p.boxNorm && Array.isArray(p.boxNorm)) {
      pYmin = p.boxNorm[0]; pXmin = p.boxNorm[1]; pYmax = p.boxNorm[2]; pXmax = p.boxNorm[3];
    } else {
      pXmin = p.box[0] / frameW; pYmin = p.box[1] / frameH;
      pXmax = p.box[2] / frameW; pYmax = p.box[3] / frameH;
    }

    pXmin = Math.max(0, Math.min(1, pXmin));
    pYmin = Math.max(0, Math.min(1, pYmin));
    pXmax = Math.max(0, Math.min(1, pXmax));
    pYmax = Math.max(0, Math.min(1, pYmax));

    let badgeColor = '#38bdf8';
    let badgeBg = 'rgba(12, 74, 110, 0.9)';
    let labelText = `Barbero: ${p.name || 'Personal'}`;

    if (!p.isStaff && p.isFrequent) {
      badgeColor = '#fbbf24';
      badgeBg = 'rgba(120, 53, 15, 0.9)';
      labelText = `Frecuente: ${p.name || 'Cliente'} (${p.visitCount || 2} v.)`;
    } else if (!p.isStaff) {
      badgeColor = '#34d399';
      badgeBg = 'rgba(6, 78, 59, 0.9)';
      labelText = `Nuevo: ${p.name || 'Cliente'}`;
    }

    const existing = animatedPeople.get(personKey);
    if (existing) {
      existing.target = { xmin: pXmin, ymin: pYmin, xmax: pXmax, ymax: pYmax };
      existing.targetOpacity = 1.0;
      existing.lastSeen = Date.now();
      existing.badgeColor = badgeColor;
      existing.badgeBg = badgeBg;
      existing.labelText = labelText;
    } else {
      animatedPeople.set(personKey, {
        current: { xmin: pXmin, ymin: pYmin, xmax: pXmax, ymax: pYmax },
        target: { xmin: pXmin, ymin: pYmin, xmax: pXmax, ymax: pYmax },
        opacity: 0.1,
        targetOpacity: 1.0,
        lastSeen: Date.now(),
        badgeColor,
        badgeBg,
        labelText
      });
    }
  });

  for (const [key, p] of animatedPeople.entries()) {
    if (!activePeopleKeys.has(key)) {
      p.targetOpacity = 0.0;
    }
  }
};

const updateInterpolatedPositions = () => {
  const LERP_FACTOR = 0.20; // Suave amortiguación para deslizar el recuadro a 60 FPS
  const FADE_FACTOR = 0.14;

  for (const [key, track] of animatedTracks.entries()) {
    track.current.xmin += (track.target.xmin - track.current.xmin) * LERP_FACTOR;
    track.current.ymin += (track.target.ymin - track.current.ymin) * LERP_FACTOR;
    track.current.xmax += (track.target.xmax - track.current.xmax) * LERP_FACTOR;
    track.current.ymax += (track.target.ymax - track.current.ymax) * LERP_FACTOR;

    track.opacity += (track.targetOpacity - track.opacity) * FADE_FACTOR;

    if (track.targetOpacity === 0 && track.opacity < 0.02) {
      animatedTracks.delete(key);
    }
  }

  for (const [key, p] of animatedPeople.entries()) {
    p.current.xmin += (p.target.xmin - p.current.xmin) * LERP_FACTOR;
    p.current.ymin += (p.target.ymin - p.current.ymin) * LERP_FACTOR;
    p.current.xmax += (p.target.xmax - p.current.xmax) * LERP_FACTOR;
    p.current.ymax += (p.target.ymax - p.current.ymax) * LERP_FACTOR;

    p.opacity += (p.targetOpacity - p.opacity) * FADE_FACTOR;

    if (p.targetOpacity === 0 && p.opacity < 0.02) {
      animatedPeople.delete(key);
    }
  }
};

const startAnimationLoop = () => {
  if (animationFrameId) return;
  const loop = () => {
    updateInterpolatedPositions();
    renderCanvas();
    animationFrameId = requestAnimationFrame(loop);
  };
  animationFrameId = requestAnimationFrame(loop);
};

const stopAnimationLoop = () => {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
};

// Fallback image loader with cross-origin resilience
const updateCanvasImage = async (url) => {
  if (!url) return;
  const loadImg = (crossOriginVal) => new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOriginVal) img.crossOrigin = crossOriginVal;
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });

  try {
    let img = null;
    try {
      img = await loadImg('anonymous');
    } catch {
      img = await loadImg(null);
    }
    currentLoadedImage.value = img;
  } catch (err) {
    console.warn('[LiveCanvas] Error cargando fotograma continuo:', err);
  }
};

watch(() => canvasImageData.value.imageUrl, (newUrl) => {
  if (newUrl) updateCanvasImage(newUrl);
});

watch(() => canvasImageData.value, (newData) => {
  syncIncomingTelemetry(newData);
}, { deep: true, immediate: true });

onMounted(() => {
  startAnimationLoop();
  startSnapshotFallback();
  decisionTicker = setInterval(() => { nowMs.value = Date.now(); }, 1000);
});

onUnmounted(() => {
  stopAnimationLoop();
  stopSnapshotFallback();
  if (decisionTicker) clearInterval(decisionTicker);
});
</script>

<template>
  <section class="w-full bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-6 flex flex-col gap-6 shadow-sm">
    <!-- Header Bar: Real-Time Live Session -->
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
      <div class="flex items-center gap-3">
        <div class="p-2.5 rounded-xl bg-red-950/50 text-red-400 border border-red-500/20">
          <AppIcon name="videocam" :size="24" />
        </div>
        <div>
          <div class="flex items-center gap-2.5">
            <h2 class="text-lg sm:text-xl font-bold text-white">Análisis</h2>
            <div class="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-[11px] font-bold tracking-wide uppercase bg-red-950/70 text-red-400 border border-red-500/40 shadow-sm shadow-red-500/20 select-none">
              <span class="live-dot-pulse-red"></span>
              <span>EN VIVO</span>
            </div>
          </div>
          <p class="text-xs sm:text-sm text-slate-400">
            Transmisión continua de video, análisis espacial de sillas, seguimiento y biometría
          </p>
        </div>
      </div>

      <div class="flex items-center gap-2.5 self-end sm:self-center flex-wrap">
        <AppButton
          size="sm"
          variant="secondary"
          icon="aspect_ratio"
          @click="emit('open-calibrator')"
          title="Calibrar cuadrantes y zonas de sillas"
        >
          <span>Calibrar Cuadrantes</span>
        </AppButton>
        <StatusPill
          :active="isConnected"
          :text="statusLabel"
        />
      </div>
    </div>

    <!-- Real-Time Occupancy Metrics KPI Bar -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
      <!-- KPI 1: Clientes en Corte -->
      <div class="p-3.5 sm:p-4 rounded-xl bg-slate-950/70 border border-emerald-500/30 flex items-center justify-between shadow-xs">
        <div class="flex flex-col">
          <span class="text-xs font-semibold text-slate-400 uppercase tracking-wider">Clientes en Corte</span>
          <span class="text-2xl sm:text-3xl font-bold text-emerald-400 font-mono mt-0.5">{{ clientsInCut }}</span>
          <span class="text-[11px] text-slate-400">Sillas de atención</span>
        </div>
        <div class="p-2.5 rounded-lg bg-emerald-950/60 text-emerald-400 border border-emerald-500/20">
          <AppIcon name="content_cut" :size="24" />
        </div>
      </div>

      <!-- KPI 2: Clientes en Espera -->
      <div class="p-3.5 sm:p-4 rounded-xl bg-slate-950/70 border border-purple-500/30 flex items-center justify-between shadow-xs">
        <div class="flex flex-col">
          <span class="text-xs font-semibold text-slate-400 uppercase tracking-wider">Clientes en Espera</span>
          <span class="text-2xl sm:text-3xl font-bold text-purple-400 font-mono mt-0.5">{{ clientsWaiting }}</span>
          <span class="text-[11px] text-slate-400">Sala de espera</span>
        </div>
        <div class="p-2.5 rounded-lg bg-purple-950/60 text-purple-400 border border-purple-500/20">
          <AppIcon name="hourglass_empty" :size="24" />
        </div>
      </div>

      <!-- KPI 3: Barberos Activos -->
      <div class="p-3.5 sm:p-4 rounded-xl bg-slate-950/70 border border-amber-500/30 flex items-center justify-between shadow-xs">
        <div class="flex flex-col">
          <span class="text-xs font-semibold text-slate-400 uppercase tracking-wider">Barberos Activos</span>
          <span class="text-2xl sm:text-3xl font-bold text-amber-400 font-mono mt-0.5">{{ activeBarbers }}</span>
          <span class="text-[11px] text-slate-400">Personal en puesto</span>
        </div>
        <div class="p-2.5 rounded-lg bg-amber-950/60 text-amber-400 border border-amber-500/20">
          <AppIcon name="badge" :size="24" />
        </div>
      </div>

      <!-- KPI 4: Total Personas en Escena -->
      <div class="p-3.5 sm:p-4 rounded-xl bg-slate-950/70 border border-sky-500/30 flex items-center justify-between shadow-xs">
        <div class="flex flex-col">
          <span class="text-xs font-semibold text-slate-400 uppercase tracking-wider">Total en Barbería</span>
          <span class="text-2xl sm:text-3xl font-bold text-sky-400 font-mono mt-0.5">{{ totalHumans }}</span>
          <span class="text-[11px] text-slate-400">Detección YOLO</span>
        </div>
        <div class="p-2.5 rounded-lg bg-sky-950/60 text-sky-400 border border-sky-500/20">
          <AppIcon name="group" :size="24" />
        </div>
      </div>
    </div>

    <!-- Main Live Grid: Video Stream / Overlays (Left) & Real-Time Today Calendar (Right) -->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-5 w-full items-start">
      <!-- Left Column: Video Stream, Overlays & Logs underneath -->
      <div class="lg:col-span-7 xl:col-span-8 flex flex-col gap-3.5">
        <!-- Viewport Toolbar -->
        <div class="flex flex-wrap items-center justify-between gap-3 bg-slate-950/80 border border-slate-800 rounded-xl px-3 py-2 text-xs">
          <div class="flex items-center gap-2 text-slate-300">
            <span class="live-dot-pulse-red"></span>
            <span class="font-medium text-white">Transmisión en Vivo</span>
            <span class="text-slate-500">•</span>
            <span class="font-mono text-slate-400">{{ streamActive && streamLoaded ? 'Stream MJPEG' : 'Fotograma Continuo (Snapshot)' }}</span>
            <span class="text-slate-500">•</span>
            <div class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-mono bg-emerald-950/70 text-emerald-400 border border-emerald-500/30 select-none">
              <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
              <span>YOLOv8: {{ canvasImageData.tracks?.length || canvasImageData.humanBoxes?.length || 0 }} pers. ({{ canvasImageData.inferenceMs }} ms)</span>
            </div>
            <AppBadge variant="default" class="text-[10px] font-mono">{{ canvasImageData.frameWidth && canvasImageData.frameHeight ? `${canvasImageData.frameWidth}x${canvasImageData.frameHeight}` : '640x360' }}</AppBadge>
          </div>

          <!-- Layers Switches -->
          <div class="flex items-center gap-3 sm:gap-4 select-none text-slate-300">
            <label class="flex items-center gap-1.5 cursor-pointer hover:text-white transition" title="Mostrar proyección de sillas y cuadrantes">
              <input type="checkbox" v-model="showQuadrants" class="accent-blue-500 rounded cursor-pointer" />
              <AppIcon name="crop_free" :size="16" class="text-blue-400" />
              <span>Sillas</span>
            </label>
            <label class="flex items-center gap-1.5 cursor-pointer hover:text-white transition" title="Mostrar seguimiento de personas YOLO">
              <input type="checkbox" v-model="showHumans" class="accent-emerald-500 rounded cursor-pointer" />
              <AppIcon name="person_search" :size="16" class="text-emerald-400" />
              <span>Personas</span>
            </label>
            <label class="flex items-center gap-1.5 cursor-pointer hover:text-white transition" title="Mostrar insignias biométricas (Staff, Frecuente, Nuevo)">
              <input type="checkbox" v-model="showBiometry" class="accent-amber-500 rounded cursor-pointer" />
              <AppIcon name="badge" :size="16" class="text-amber-400" />
              <span>Biometría</span>
            </label>
            <button
              type="button"
              @click="reloadStream"
              class="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition cursor-pointer"
              title="Recargar transmisión en vivo"
            >
              <AppIcon name="refresh" :size="18" />
            </button>
            <button
              type="button"
              @click="toggleFullscreen"
              class="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition cursor-pointer"
              title="Pantalla Completa"
            >
              <AppIcon name="fullscreen" :size="18" />
            </button>
          </div>
        </div>

        <!-- Viewport Box: Video Stream + Transparent Canvas Overlays -->
        <div
          ref="viewportRef"
          class="relative w-full aspect-video bg-black rounded-xl overflow-hidden border border-slate-800 flex items-center justify-center select-none shadow-inner"
        >
          <!-- Live MJPEG Stream -->
          <img
            v-if="streamActive && streamUrl"
            :src="`${streamUrl}?t=${streamKey}`"
            @load="onStreamLoad"
            @error="onStreamError"
            alt="Transmisión en Vivo"
            class="absolute inset-0 w-full h-full object-contain pointer-events-none"
          />

          <!-- Canvas Overlay for Quadrants, YOLO boxes & Biometry badges -->
          <canvas
            v-if="streamUrl || activeBackendUrl"
            ref="canvasRef"
            width="1024"
            height="576"
            class="absolute inset-0 w-full h-full object-contain pointer-events-none z-10"
          ></canvas>

          <!-- Estado informativo: Túnel HTTPS no configurado en entorno cloud -->
          <div
            v-if="!activeBackendUrl && !IS_LOCAL_ENV"
            class="absolute inset-0 flex flex-col items-center justify-center text-center p-6 bg-slate-950/90 text-slate-400 gap-3 z-30"
          >
            <div class="p-3.5 bg-slate-900 rounded-full border border-slate-800 text-amber-400 shadow-lg">
              <AppIcon name="videocam_off" :size="36" />
            </div>
            <div class="flex flex-col gap-1 items-center max-w-md">
              <h3 class="text-base font-semibold text-slate-100 flex items-center gap-1.5">
                Túnel HTTPS no configurado
              </h3>
              <p class="text-xs text-slate-400 leading-relaxed">
                Para ver la transmisión en vivo y telemetría SSE desde producción, configura la URL pública de tu túnel HTTPS en Ajustes.
              </p>
            </div>
            <AppButton
              variant="secondary"
              icon="settings"
              class="text-xs mt-1"
              @click="emit('open-settings')"
            >
              Abrir Ajustes
            </AppButton>
          </div>

          <!-- Fallback when stream is inactive and no image is loaded yet -->
          <div
            v-else-if="!streamActive && !currentLoadedImage && !canvasImageData.imageUrl"
            class="absolute inset-0 flex flex-col items-center justify-center text-center p-6 bg-slate-950/85 text-slate-400 gap-2 z-20"
          >
            <div class="p-3 bg-slate-900 rounded-full border border-slate-800 text-slate-400">
              <AppIcon name="videocam" :size="32" />
            </div>
            <h3 class="text-base font-semibold text-slate-200">Reconectando Transmisión</h3>
            <p class="text-xs max-w-md text-slate-400">
              Sincronizando flujo de video en vivo del Daemon...
            </p>
          </div>
        </div>

        <!-- Viewport Bottom Telemetry Strip -->
        <div class="flex flex-wrap items-center gap-2 pt-1">
          <StatPill
            label="Transmisión"
            :value="!streamUrl && !IS_LOCAL_ENV ? 'Sin Túnel' : (streamActive && streamLoaded ? 'En Vivo' : 'Fotograma Continuo')"
            :value-class="!streamUrl && !IS_LOCAL_ENV ? 'text-amber-400 font-medium' : (streamActive && streamLoaded ? 'text-red-400 font-bold' : 'text-emerald-400 font-medium')"
          />
          <StatPill
            label="YOLO Streaming"
            :value="!streamUrl && !IS_LOCAL_ENV ? 'Túnel requerido' : (isYoloStreaming ? 'SSE Directo (<20ms)' : 'Conectando...')"
            :value-class="isYoloStreaming ? 'text-emerald-400 font-bold' : 'text-slate-400'"
          />
          <StatPill label="Inferencia ML" :value="canvasImageData.inferenceMs ? `${canvasImageData.inferenceMs} ms` : 'En tiempo real'" />
          <StatPill label="Sillas Activas" :value="`${configuredQuadrants?.length || 0} configuradas`" />
          <StatPill
            label="Biometría"
            :value="`${canvasImageData.peopleIdentified?.length || 0} identificados`"
            :value-class="canvasImageData.peopleIdentified?.length ? 'text-amber-400 font-bold' : 'text-slate-400'"
          />
        </div>

        <!-- Logs debajo del Video (Bitácora de Visitas y Seguimiento) -->
        <div class="flex flex-col bg-slate-950/70 border border-slate-800 rounded-xl overflow-hidden h-[290px] shadow-xs mt-1">
          <div class="flex items-center justify-between p-3 border-b border-slate-800 bg-slate-900/80">
            <div class="flex items-center gap-2 text-sm font-semibold text-slate-200">
              <AppIcon name="timeline" :size="18" class="text-blue-400" />
              <h4>Bitácora de Visitas y Seguimiento en Vivo</h4>
            </div>
            <div class="flex items-center gap-2">
              <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-950/70 text-emerald-400 border border-emerald-500/30">
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                En directo
              </span>
              <AppBadge variant="default" class="text-[11px] font-mono">
                {{ logs.length }} eventos
              </AppBadge>
            </div>
          </div>

          <div class="flex-1 p-3 overflow-y-auto flex flex-col gap-2 font-mono text-xs">
            <div
              v-for="log in logs"
              :key="log.id"
              class="p-2.5 rounded-lg border border-slate-800/90 bg-slate-900/90 flex flex-col gap-1 transition hover:border-slate-700"
            >
              <div class="flex items-center justify-between text-[11px] text-slate-400">
                <div class="flex items-center gap-1.5 font-bold text-slate-200">
                  <AppIcon :name="log.icon || 'sensors'" :size="15" class="text-blue-400" />
                  <span>{{ log.title }}</span>
                </div>
                <span class="font-mono text-slate-500">{{ log.time }}</span>
              </div>

              <p class="text-slate-300 font-sans text-xs leading-relaxed">{{ log.desc }}</p>

              <div v-if="log.badge" class="self-start mt-0.5">
                <span :class="['px-2 py-0.5 rounded-md text-[10px] font-semibold font-sans uppercase tracking-wider', log.badgeClass || 'text-slate-400 bg-slate-800']">
                  {{ log.badge }}
                </span>
              </div>
            </div>

            <div
              v-if="logs.length === 0"
              class="h-full flex items-center justify-center text-slate-500 text-xs text-center p-4 font-sans"
            >
              Esperando eventos de seguimiento y visitas en tiempo real...
            </div>
          </div>
        </div>
      </div>

      <!-- Right Column: Lateral - Calendario de Atención del Día -->
      <div class="lg:col-span-5 xl:col-span-4 flex flex-col">
        <TodayScheduleWidget
          :clients-in-cut="clientsInCut"
          :active-barbers="activeBarbers"
          :active-chair-sessions="activeChairSessions"
          @switch-tab="emit('switch-tab', $event)"
        />
      </div>
    </div>

    <!-- Columna de Toasts Flotantes (Lado Derecho Inferior) -->
    <Teleport to="body">
      <div
        v-if="activeDecisions.length > 0"
        class="fixed bottom-4 right-4 z-50 flex flex-col gap-2.5 w-[340px] sm:w-[380px] max-w-[calc(100vw-2rem)] max-h-[80vh] overflow-y-auto pointer-events-none"
        aria-live="polite"
      >
        <TransitionGroup name="toast-slide">
          <div
            v-for="decision in activeDecisions"
            :key="decision.id"
            :class="[
              'pointer-events-auto rounded-xl bg-gradient-to-br border p-3.5 relative overflow-hidden shadow-2xl backdrop-blur-md transition-all',
              getDecisionStyle(decision).bg,
              getDecisionStyle(decision).border
            ]"
          >
            <div class="flex items-start gap-2.5">
              <AppIcon
                :name="getDecisionStyle(decision).icon"
                :size="18"
                :class="['mt-0.5 flex-shrink-0', getDecisionStyle(decision).text]"
              />
              <div class="min-w-0 flex-1">
                <div class="flex items-center justify-between gap-2">
                  <span :class="['text-xs font-bold leading-snug', getDecisionStyle(decision).text]">
                    {{ decision.title }}
                  </span>
                  <div class="flex items-center gap-1.5 flex-shrink-0">
                    <span class="text-[10px] font-mono text-slate-400">
                      {{ Math.max(0, Math.ceil((decision.expiresAt - nowMs) / 1000)) }}s
                    </span>
                    <button
                      type="button"
                      @click="dismissDecision(decision.id)"
                      class="text-slate-400 hover:text-white transition p-0.5 rounded cursor-pointer"
                      title="Cerrar notificación"
                    >
                      <AppIcon name="close" :size="14" />
                    </button>
                  </div>
                </div>
                <div v-if="decision.trackId || decision.chairName" class="text-[10px] font-mono text-slate-400 mt-0.5">
                  <span v-if="decision.trackId">Bloque #{{ decision.trackId }}</span>
                  <span v-if="decision.trackId && decision.chairName"> · </span>
                  <span v-if="decision.chairName">{{ decision.chairName }}</span>
                </div>
                <p class="text-[11px] text-slate-200 leading-relaxed mt-1 break-words">
                  {{ decision.reason }}
                </p>
              </div>
            </div>

            <!-- Barra de cuenta regresiva de 15s -->
            <div class="absolute bottom-0 left-0 right-0 h-0.5 bg-slate-800/80">
              <div
                :class="['h-full decision-countdown', getDecisionStyle(decision).bar]"
                :style="{ animationDuration: (decision.expiresAt - decision.receivedAt) + 'ms' }"
              ></div>
            </div>
          </div>
        </TransitionGroup>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
@keyframes decision-shrink {
  from { width: 100%; }
  to { width: 0%; }
}
.decision-countdown {
  width: 100%;
  animation-name: decision-shrink;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
}

.toast-slide-enter-active,
.toast-slide-leave-active {
  transition: all 0.25s ease;
}
.toast-slide-enter-from {
  opacity: 0;
  transform: translateX(24px) scale(0.96);
}
.toast-slide-leave-to {
  opacity: 0;
  transform: translateX(24px) scale(0.96);
}
</style>
