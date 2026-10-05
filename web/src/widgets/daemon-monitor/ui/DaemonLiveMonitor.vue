<script setup>
import { ref, onMounted, watch } from 'vue';
import AppIcon from '@/shared/ui/atoms/AppIcon.vue';
import AppButton from '@/shared/ui/atoms/AppButton.vue';
import AppBadge from '@/shared/ui/atoms/AppBadge.vue';
import StatusPill from '@/shared/ui/molecules/StatusPill.vue';
import StatPill from '@/shared/ui/molecules/StatPill.vue';
import { useDaemonState } from '@/entities/daemon/model/useDaemonState';
import { useTriggerCapture } from '@/features/trigger-capture/model/useTriggerCapture';
import { hexToRgba, toPointObject, ensureNorm01 } from '@/shared/lib/geometry';

const emit = defineEmits(['open-calibrator-photo']);

const {
  daemonState,
  activeStepIndex,
  currentStep,
  stepList,
  logs,
  countdownTimeFormatted,
  countdownProgressPercent,
  workingHoursConfig,
  workingHoursStatus,
  isConnected,
  statusLabel,
  canvasImageData,
  addLog
} = useDaemonState();

const { isTriggering, triggerCapture } = useTriggerCapture();

// Canvas controls & layers
const canvasRef = ref(null);
const showQuadrants = ref(true);
const showHumans = ref(true);
const showBiometry = ref(true);
const currentLoadedImage = ref(null);

const onTriggerClick = () => {
  triggerCapture(addLog);
};

// Render on canvas
const renderCanvas = () => {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;

  // Clear
  ctx.clearRect(0, 0, W, H);

  // 1. Draw base photo if loaded
  if (currentLoadedImage.value) {
    ctx.drawImage(currentLoadedImage.value, 0, 0, W, H);
  } else {
    // Dark grid background
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

  // 2. Draw Quadrants Layer
  if (showQuadrants.value && canvasImageData.value.quadrants?.length) {
    canvasImageData.value.quadrants.forEach((q) => {
      const color = q.color || '#3b82f6';
      const poly = q.polygonNorm || [];
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
        ctx.fillStyle = hexToRgba(color, 0.18);
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Label
        const firstPt = toPointObject(poly[0]);
        const lx = firstPt.x * W + 4;
        const ly = firstPt.y * H + 18;
        ctx.fillStyle = color;
        ctx.font = 'bold 12px Inter, sans-serif';
        ctx.fillText(q.badge || q.name || 'Zona', lx, ly);
      }
    });
  }

  // 3. Draw Humans Layer (YOLOv8)
  if (showHumans.value && canvasImageData.value.humanBoxes?.length) {
    canvasImageData.value.humanBoxes.forEach((box) => {
      // box: [ymin, xmin, ymax, xmax]
      const ymin = ensureNorm01(box[0]);
      const xmin = ensureNorm01(box[1]);
      const ymax = ensureNorm01(box[2]);
      const xmax = ensureNorm01(box[3]);

      const x = xmin * W;
      const y = ymin * H;
      const w = (xmax - xmin) * W;
      const h = (ymax - ymin) * H;

      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(x, y, w, h);

      // Tag
      ctx.fillStyle = '#10b981';
      ctx.fillRect(x, Math.max(0, y - 18), 70, 18);
      ctx.fillStyle = '#064e3b';
      ctx.font = 'bold 11px Inter, sans-serif';
      ctx.fillText('Persona', x + 5, Math.max(12, y - 5));
    });
  }

  // 4. Draw Biometry Layer
  if (showBiometry.value && canvasImageData.value.peopleIdentified?.length) {
    canvasImageData.value.peopleIdentified.forEach((p) => {
      if (p.box) {
        const ymin = ensureNorm01(p.box[0]);
        const xmin = ensureNorm01(p.box[1]);
        const ymax = ensureNorm01(p.box[2]);
        const xmax = ensureNorm01(p.box[3]);

        const x = xmin * W;
        const y = ymin * H;
        const w = (xmax - xmin) * W;
        const h = (ymax - ymin) * H;

        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);

        // Label
        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(x, y + h, Math.max(80, (p.name || '').length * 8 + 10), 18);
        ctx.fillStyle = '#000000';
        ctx.font = 'bold 11px Inter, sans-serif';
        ctx.fillText(p.name || 'Identificado', x + 5, y + h + 13);
      }
    });
  }
};

// Load image into canvas with CORS fallback
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
    renderCanvas();
  } catch (err) {
    console.warn('[LiveCanvas] Error cargando imagen:', err);
  }
};

watch(() => canvasImageData.value.imageUrl, (newUrl) => {
  if (newUrl) updateCanvasImage(newUrl);
});

watch([showQuadrants, showHumans, showBiometry], () => {
  renderCanvas();
});

onMounted(() => {
  renderCanvas();
});
</script>

<template>
  <section class="w-full bg-slate-850 bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-6 flex flex-col gap-6 shadow-sm">
    <!-- Header Bar -->
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
      <div class="flex items-center gap-3">
        <div class="p-2 rounded-xl bg-blue-950/60 text-blue-400 border border-blue-500/20">
          <AppIcon name="bolt" :size="24" />
        </div>
        <div>
          <h2 class="text-lg sm:text-xl font-bold text-white">Flujo Operativo del Daemon en Tiempo Real</h2>
          <p class="text-xs sm:text-sm text-slate-400">
            Telemetría paso a paso: consulta P2P, fotograma base, cuadrantes, detección y biometría
          </p>
        </div>
      </div>

      <div class="flex items-center gap-3 self-end sm:self-center">
        <StatusPill
          :active="isConnected"
          :text="statusLabel"
        />
        <AppButton
          variant="primary"
          icon="bolt"
          :loading="isTriggering"
          @click="onTriggerClick"
          title="Iniciar prueba en vivo y disparar captura"
        >
          <span>Capturar Ahora (Prueba en Vivo)</span>
        </AppButton>
      </div>
    </div>

    <!-- Countdown & Working Hours Bar -->
    <div class="bg-slate-950/60 border border-slate-800/80 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row items-center gap-5">
      <div class="relative w-24 h-24 shrink-0 flex items-center justify-center">
        <svg viewBox="0 0 100 100" class="w-full h-full -rotate-90">
          <circle cx="50" cy="50" r="42" stroke="rgba(51, 65, 85, 0.4)" stroke-width="8" fill="none" />
          <circle
            cx="50" cy="50" r="42"
            stroke="#3b82f6"
            stroke-width="8"
            stroke-linecap="round"
            fill="none"
            stroke-dasharray="264"
            :stroke-dashoffset="264 - (264 * countdownProgressPercent) / 100"
            class="transition-all duration-1000 ease-linear"
          />
        </svg>
        <div class="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span class="text-lg font-bold font-mono text-white tracking-wider">{{ countdownTimeFormatted }}</span>
          <span class="text-[10px] text-slate-400 font-medium">min/seg</span>
        </div>
      </div>

      <div class="flex flex-col gap-2 flex-1 w-full text-center sm:text-left">
        <div class="flex flex-wrap items-center justify-center sm:justify-start gap-2">
          <AppBadge variant="default" icon="timer">
            Intervalo: {{ daemonState?.intervalMinutes || 3 }} min
          </AppBadge>
          <AppBadge variant="default" icon="schedule">
            Horario: {{ workingHoursConfig.start }} - {{ workingHoursConfig.end }}
          </AppBadge>
          <AppBadge :variant="workingHoursStatus.isWithin ? 'success' : 'warning'">
            {{ workingHoursStatus.isWithin ? '● Dentro de Horario' : '○ Fuera de Horario (En Pausa)' }}
          </AppBadge>
        </div>
        <h3 class="text-base font-semibold text-white">{{ currentStep.title }}</h3>
        <p class="text-xs text-slate-400">
          {{ daemonState?.lastStatus || currentStep.sub || 'Sincronizando estado con Firestore...' }}
        </p>
      </div>
    </div>

    <!-- Process Stepper Pipeline (6 Pasos Reales) -->
    <div class="w-full overflow-x-auto pb-2">
      <div class="flex items-center min-w-[650px] justify-between relative px-2">
        <div
          v-for="(step, idx) in stepList"
          :key="step.key"
          class="flex items-center flex-1 last:flex-none relative"
        >
          <!-- Step node -->
          <div class="flex flex-col items-center text-center gap-1.5 z-10">
            <div
              :class="[
                'w-10 h-10 rounded-full flex items-center justify-center border-2 transition-all duration-300 font-semibold',
                idx === activeStepIndex
                  ? 'bg-blue-600 border-blue-400 text-white shadow-lg shadow-blue-500/30 scale-110'
                  : idx < activeStepIndex
                  ? 'bg-slate-800 border-emerald-500 text-emerald-400'
                  : 'bg-slate-900 border-slate-700 text-slate-500'
              ]"
            >
              <AppIcon :name="step.icon" :size="20" />
            </div>
            <span
              :class="[
                'text-xs font-medium whitespace-nowrap',
                idx === activeStepIndex ? 'text-blue-400 font-bold' : 'text-slate-400'
              ]"
            >
              {{ step.title }}
            </span>
            <span class="text-[10px] text-slate-500">{{ step.sub }}</span>
          </div>

          <!-- Connector line -->
          <div
            v-if="idx < stepList.length - 1"
            :class="[
              'h-0.5 w-full mx-2 transition-colors duration-300',
              idx < activeStepIndex ? 'bg-emerald-500' : 'bg-slate-700'
            ]"
          ></div>
        </div>
      </div>
    </div>

    <!-- Main Live Grid: Canvas & Real-time Log Feed -->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-5 w-full items-start">
      <!-- Left: Canvas Area -->
      <div class="lg:col-span-8 flex flex-col gap-3">
        <!-- Canvas Toolbar -->
        <div class="flex items-center justify-between bg-slate-950/80 border border-slate-800 rounded-xl px-3 py-2 text-xs">
          <div class="flex items-center gap-2 text-slate-300">
            <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
            <span>Canvas Listo • {{ canvasImageData.imageUrl ? 'Fotograma Activo' : 'Esperando imagen' }}</span>
          </div>

          <!-- Layers Switches -->
          <div class="flex items-center gap-3 select-none text-slate-300">
            <label class="flex items-center gap-1.5 cursor-pointer hover:text-white">
              <input type="checkbox" v-model="showQuadrants" class="accent-blue-500 rounded cursor-pointer" />
              <span>Cuadrantes</span>
            </label>
            <label class="flex items-center gap-1.5 cursor-pointer hover:text-white">
              <input type="checkbox" v-model="showHumans" class="accent-emerald-500 rounded cursor-pointer" />
              <span>Humanos</span>
            </label>
            <label class="flex items-center gap-1.5 cursor-pointer hover:text-white">
              <input type="checkbox" v-model="showBiometry" class="accent-amber-500 rounded cursor-pointer" />
              <span>Biometría</span>
            </label>
          </div>
        </div>

        <!-- Canvas Viewport -->
        <div class="relative w-full aspect-video bg-black rounded-xl overflow-hidden border border-slate-800 flex items-center justify-center">
          <canvas
            ref="canvasRef"
            width="1024"
            height="576"
            class="w-full h-full object-contain"
          ></canvas>

          <div
            v-if="!canvasImageData.imageUrl"
            class="absolute inset-0 flex flex-col items-center justify-center text-center p-6 bg-slate-950/80 backdrop-blur-xs text-slate-400 gap-2 select-none"
          >
            <div class="p-3 bg-slate-900 rounded-full border border-slate-800 text-slate-400">
              <AppIcon name="photo_camera" :size="32" />
            </div>
            <h3 class="text-base font-semibold text-slate-200">Lienzo en Vivo del Daemon</h3>
            <p class="text-xs max-w-md text-slate-400">
              En cuanto el Daemon consulte la cámara o se dispare una captura, la imagen, cuadrantes y detecciones se dibujarán aquí en tiempo real.
            </p>
          </div>
        </div>

        <!-- Canvas Bottom Stats -->
        <div class="flex flex-wrap items-center gap-2 pt-1">
          <StatPill label="Fotograma" :value="canvasImageData.docId || 'Ninguno'" />
          <StatPill label="Dimensiones" :value="`${canvasImageData.width} x ${canvasImageData.height} px`" />
          <StatPill label="Cuadrantes" :value="`${canvasImageData.quadrants?.length || 0} activos`" />
          <StatPill
            label="¿Humanos Detectados?"
            :value="canvasImageData.humanBoxes?.length ? `Sí (${canvasImageData.humanBoxes.length})` : '0'"
            :value-class="canvasImageData.humanBoxes?.length ? 'text-emerald-400 font-bold' : 'text-slate-400'"
          />
          <StatPill label="Clasificación" :value="`${canvasImageData.peopleIdentified?.length || 0} identificados`" />
        </div>
      </div>

      <!-- Right: Real-time Descriptive Log Area -->
      <div class="lg:col-span-4 flex flex-col bg-slate-950/60 border border-slate-800 rounded-xl overflow-hidden h-[460px]">
        <div class="flex items-center justify-between p-3 border-b border-slate-800 bg-slate-900/60">
          <div class="flex items-center gap-2 text-sm font-semibold text-slate-200">
            <AppIcon name="terminal" :size="18" class="text-blue-400" />
            <h4>Bitácora de Procesos Reales</h4>
          </div>
          <AppBadge variant="default" class="text-[11px] font-mono">
            {{ logs.length }} eventos
          </AppBadge>
        </div>

        <div class="flex-1 p-3 overflow-y-auto flex flex-col gap-2 font-mono text-xs">
          <div
            v-for="log in logs"
            :key="log.id"
            class="p-2.5 rounded-lg border border-slate-800/80 bg-slate-900/80 flex flex-col gap-1 transition"
          >
            <div class="flex items-center justify-between text-[11px] text-slate-400">
              <span class="font-bold text-slate-200">{{ log.title || 'Evento' }}</span>
              <span>{{ log.time }}</span>
            </div>
            <p class="text-slate-300 font-sans text-xs">{{ log.desc || log.message }}</p>
          </div>

          <div
            v-if="logs.length === 0"
            class="h-full flex items-center justify-center text-slate-500 text-xs text-center p-4 font-sans"
          >
            Conectando con Firestore camera_catcher/daemon_state...
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
