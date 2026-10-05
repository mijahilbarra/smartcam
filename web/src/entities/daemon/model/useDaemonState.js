import { ref, computed, onMounted, onUnmounted } from 'vue';
import { doc, onSnapshot, collection } from 'firebase/firestore';
import { db, resolveStorageUrl, IS_LOCAL_ENV } from '@/shared/api/firebase';
import { checkIsWithinWorkingHours } from '@/shared/lib/date-utils';

const STEP_DEFINITIONS = [
  { key: 'CYCLE_START', index: 0, title: 'Contador de Ciclo', sub: 'Cuenta regresiva', icon: 'timer' },
  { key: 'QUERY_CAMERA', index: 1, title: 'Consulta a Cámara', sub: 'P2P Baichuan', icon: 'sensors' },
  { key: 'IMAGE_ARRIVED', index: 2, title: 'Llega la Imagen', sub: 'Imprime en Canvas', icon: 'image' },
  { key: 'ACTIVATE_QUADRANTS', index: 3, title: 'Activan Cuadrantes', sub: 'Proyección ROI', icon: 'crop_free' },
  { key: 'DETECT_HUMANS', index: 4, title: 'Detecta Humanos', sub: 'YOLOv8: ¿Sí o No?', icon: 'person_search' },
  { key: 'BIOMETRY_PROFILE', index: 5, title: 'Biometría y Perfil', sub: 'Barbero / Frecuentes', icon: 'badge' }
];

export function useDaemonState() {
  const daemonState = ref(null);
  const activeStepIndex = ref(0);
  const currentStepKey = ref('CYCLE_START');
  const logs = ref([]);
  const countdownSeconds = ref(0);
  const totalIntervalSeconds = ref(180);
  const countdownTimeFormatted = ref('--:--');
  const workingHoursConfig = ref({ start: '11:00', end: '23:00' });
  const isConnected = ref(false);

  // Latest image data resolved for canvas
  const canvasImageData = ref({
    imageUrl: '',
    docId: '',
    width: 1024,
    height: 576,
    quadrants: [],
    humanBoxes: [],
    peopleIdentified: []
  });

  let unsubscribeDaemon = null;
  let countdownInterval = null;

  const currentStep = computed(() => {
    return STEP_DEFINITIONS[activeStepIndex.value] || STEP_DEFINITIONS[0];
  });

  const countdownProgressPercent = computed(() => {
    if (countdownTimeFormatted.value === '--:--') return 0;
    if (totalIntervalSeconds.value <= 0) return 0;
    const elapsed = totalIntervalSeconds.value - countdownSeconds.value;
    return Math.min(100, Math.max(0, (elapsed / totalIntervalSeconds.value) * 100));
  });

  const workingHoursStatus = computed(() => {
    return checkIsWithinWorkingHours(workingHoursConfig.value.start, workingHoursConfig.value.end);
  });

  const stepList = computed(() => STEP_DEFINITIONS);

  const statusLabel = computed(() => {
    if (isConnected.value) {
      return IS_LOCAL_ENV ? 'Daemon Local Activo' : 'Daemon Cloud Activo';
    }
    return IS_LOCAL_ENV ? 'Daemon Local Desconectado' : 'Daemon Desconectado';
  });

  const startCountdownTicker = (nextIso, intervalMin) => {
    if (countdownInterval) clearInterval(countdownInterval);
    const intervalSec = (parseFloat(intervalMin) || 3) * 60;
    totalIntervalSeconds.value = intervalSec;

    const tick = () => {
      if (!nextIso) {
        countdownTimeFormatted.value = '--:--';
        countdownSeconds.value = 0;
        return;
      }
      const targetTime = new Date(nextIso).getTime();
      if (isNaN(targetTime)) {
        countdownTimeFormatted.value = '--:--';
        countdownSeconds.value = 0;
        return;
      }

      const diffMs = targetTime - Date.now();
      const secLeft = Math.max(0, Math.floor(diffMs / 1000));
      countdownSeconds.value = secLeft;

      const m = Math.floor(secLeft / 60);
      const s = secLeft % 60;
      countdownTimeFormatted.value = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    };

    tick();
    countdownInterval = setInterval(tick, 1000);
  };

  const addLog = (event) => {
    const timestamp = new Date().toLocaleTimeString('es-PE', { hour12: false });
    logs.value.unshift({
      id: Date.now() + Math.random(),
      time: timestamp,
      ...event
    });
    if (logs.value.length > 50) logs.value.pop();
  };

  const subscribe = () => {
    const docRef = doc(db, 'camera_catcher', 'daemon_state');
    unsubscribeDaemon = onSnapshot(docRef, async (snap) => {
      if (!snap.exists()) {
        daemonState.value = null;
        isConnected.value = false;
        startCountdownTicker(null, 3);
        return;
      }
      const data = snap.data();

      // Extraer intervalo y fecha objetivo de forma resiliente
      const rawInterval = data.countdown?.intervalMinutes || data.intervalMinutes;
      const intervalMinutes = (!isNaN(Number(rawInterval)) && Number(rawInterval) > 0) ? Number(rawInterval) : 3;
      const nextCaptureAtIso = data.countdown?.nextCaptureAt || data.nextCaptureAtIso || data.nextCaptureAt || null;

      // Evaluar si el reporte del daemon es reciente
      const lastIso = data.updatedAt || data.timestamp || data.countdown?.timestamp;
      if (lastIso) {
        const ageMs = Date.now() - new Date(lastIso).getTime();
        const maxStaleMs = (intervalMinutes * 2) * 60 * 1000;
        isConnected.value = ageMs < maxStaleMs;
      } else {
        isConnected.value = false;
      }

      // Normalizar campos aplanados para uso directo en la UI
      data.intervalMinutes = intervalMinutes;
      data.nextCaptureAtIso = nextCaptureAtIso;
      daemonState.value = data;

      // Update Working hours from state if present
      if (data.workingHours) {
        workingHoursConfig.value = {
          start: data.workingHours.start || '11:00',
          end: data.workingHours.end || '23:00'
        };
      } else if (data.countdown?.workHours) {
        const match = String(data.countdown.workHours).match(/^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/);
        if (match) {
          workingHoursConfig.value = {
            start: match[1],
            end: match[2]
          };
        }
      }

      // Update Stepper
      const stepIdx = typeof data.stepIndex === 'number' ? data.stepIndex : 0;
      activeStepIndex.value = Math.min(Math.max(0, stepIdx), 5);
      currentStepKey.value = data.stepKey || STEP_DEFINITIONS[activeStepIndex.value].key;

      // Update Countdown ticker: si no hay fecha pero el daemon está activo, calcular la estimada
      let targetNextIso = nextCaptureAtIso;
      if (!targetNextIso && isConnected.value) {
        const baseTime = lastIso ? new Date(lastIso).getTime() : Date.now();
        const estTime = baseTime + intervalMinutes * 60 * 1000;
        targetNextIso = new Date(estTime > Date.now() ? estTime : Date.now() + intervalMinutes * 60 * 1000).toISOString();
      }

      startCountdownTicker(targetNextIso, intervalMinutes);

      // Update Event log if history exists or single event is recorded
      if (Array.isArray(data.history) && data.history.length > 0) {
        logs.value = data.history.map(item => ({
          id: item.id || `${item.timestamp}_${Math.random()}`,
          time: item.timeFormatted || (item.timestamp ? new Date(item.timestamp).toLocaleTimeString('es-PE', { hour12: false }) : '--:--'),
          title: item.type ? item.type.toUpperCase() : 'TELEMETRÍA',
          desc: item.text,
          type: item.type
        }));
      } else if (data.lastEvent) {
        addLog(data.lastEvent);
      }

      // Resolve canvas image if available
      if (data.image?.storagePath) {
        const url = await resolveStorageUrl(data.image.storagePath);
        if (url) {
          canvasImageData.value = {
            imageUrl: url,
            docId: data.image.docId || 'Reciente',
            width: data.image.width || 1024,
            height: data.image.height || 576,
            quadrants: data.quadrants || [],
            humanBoxes: data.detections?.humans || [],
            peopleIdentified: data.detections?.people || []
          };
        }
      }
    }, (err) => {
      console.warn('[DaemonState] Error de conexión:', err);
      isConnected.value = false;
    });
  };

  onMounted(() => {
    subscribe();
  });

  onUnmounted(() => {
    if (unsubscribeDaemon) unsubscribeDaemon();
    if (countdownInterval) clearInterval(countdownInterval);
  });

  return {
    daemonState,
    activeStepIndex,
    currentStepKey,
    currentStep,
    stepList,
    logs,
    countdownSeconds,
    totalIntervalSeconds,
    countdownTimeFormatted,
    countdownProgressPercent,
    workingHoursConfig,
    workingHoursStatus,
    isConnected,
    statusLabel,
    canvasImageData,
    addLog
  };
}
