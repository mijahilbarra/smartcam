import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { doc, onSnapshot } from 'firebase/firestore';
import { db, resolveStorageUrl, IS_LOCAL_ENV, getEnvironmentInfo, normalizeUrl } from '@/shared/api/firebase';
import { setSystemMemory } from './useSystemMemory';

export function useDaemonState() {
  const daemonState = ref(null);
  const rawVisits = ref([]);
  const telemetryLogs = ref([]);
  const actionLogs = ref([]);
  const isConnected = ref(false);
  const isYoloStreaming = ref(false);
  const liveOccupancy = ref(null);
  const firestoreStreamUrl = ref('');

  // Latest image & telemetry resolved for canvas overlay
  const canvasImageData = ref({
    imageUrl: '',
    docId: '',
    width: 640,
    height: 360,
    frameWidth: 640,
    frameHeight: 360,
    quadrants: [],
    humanBoxes: [],
    tracks: [],
    peopleIdentified: [],
    inferenceMs: 0
  });

  let unsubscribePrompt = null;
  let unsubscribeDaemon = null;
  let unsubscribeVisits = null;
  let sseEventSource = null;

  // URL base activa del backend / túnel
  const activeBackendUrl = computed(() => {
    const env = getEnvironmentInfo();

    // En entorno local (localhost / 127.0.0.1 / dev / simulador E2), SIEMPRE usar http://localhost:8085
    // a menos que la URL personalizada en localStorage sea explícitamente una URL local (localhost o 127.0.0.1).
    // NUNCA permitir que una URL remota de producción (perrosuelto.com o externa) anule el entorno local.
    if (IS_LOCAL_ENV) {
      if (env.hasCustomUrl && env.backendUrl) {
        const isLocalHost = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)/i.test(env.backendUrl);
        if (isLocalHost) {
          return normalizeUrl(env.backendUrl);
        }
      }
      return 'http://localhost:8085';
    }

    // En producción (Cloud / Firebase Hosting): Prioridad 1: URL de túnel configurada en Firestore
    if (firestoreStreamUrl.value) {
      return normalizeUrl(firestoreStreamUrl.value);
    }

    // Prioridad 2 en Cloud: Variable de entorno o localStorage
    if (env.backendUrl) {
      return normalizeUrl(env.backendUrl);
    }

    // Si es servidor cloud y no hay túnel configurado: null
    return null;
  });

  // Stream URL: direct MJPEG endpoint from stream server (null en cloud sin backend)
  const streamUrl = computed(() => {
    return activeBackendUrl.value ? `${activeBackendUrl.value}/api/stream` : null;
  });

  // Snapshot URL: fotograma continuo o fallback directo desde el stream server
  const snapshotUrl = computed(() => {
    return activeBackendUrl.value ? `${activeBackendUrl.value}/api/snapshot` : null;
  });

  // YOLO Telemetry Stream URL (SSE direct from backend, null en cloud sin backend)
  const yoloStreamUrl = computed(() => {
    return activeBackendUrl.value ? `${activeBackendUrl.value}/api/yolo/stream` : null;
  });

  const statusLabel = computed(() => {
    if (isConnected.value || isYoloStreaming.value) {
      return IS_LOCAL_ENV ? 'Sesión en Vivo Local Activa' : 'Sesión en Vivo Cloud Activa';
    }
    if (!activeBackendUrl.value && !IS_LOCAL_ENV) {
      return 'Túnel HTTPS no configurado';
    }
    return IS_LOCAL_ENV ? 'Stream Local en Espera' : 'Transmisión Desconectada';
  });

  // Dynamic Occupancy Metrics prioritizing real-time SSE stream
  const clientsInCut = computed(() => {
    if (typeof liveOccupancy.value?.clientsInCut === 'number') {
      return liveOccupancy.value.clientsInCut;
    }
    if (typeof daemonState.value?.occupancy?.clientsInCut === 'number') {
      return daemonState.value.occupancy.clientsInCut;
    }
    const activeVisitsCount = rawVisits.value.filter(v => v.status === 'en_corte').length;
    if (activeVisitsCount > 0) return activeVisitsCount;

    const quads = canvasImageData.value.quadrants?.length
      ? canvasImageData.value.quadrants
      : (daemonState.value?.quadrants || []);

    const cutZones = quads.filter(q => {
      const isChair = q.type === 'barber_chair' || q.category === 'silla_barbero' || q.category === 'cliente';
      const isBusy = q.status === 'en_corte' || q.status === 'ocupada';
      return isChair && isBusy;
    });

    return cutZones.length;
  });

  const clientsWaiting = computed(() => {
    if (typeof liveOccupancy.value?.clientsWaiting === 'number') {
      return liveOccupancy.value.clientsWaiting;
    }
    if (typeof daemonState.value?.occupancy?.clientsWaiting === 'number') {
      return daemonState.value.occupancy.clientsWaiting;
    }
    const quads = canvasImageData.value.quadrants?.length
      ? canvasImageData.value.quadrants
      : (daemonState.value?.quadrants || []);

    const waitZones = quads.filter(q => {
      const isWait = q.type === 'waiting_chair' || q.category === 'silla_espera';
      const isBusy = q.status === 'en_espera' || q.status === 'ocupada';
      return isWait && isBusy;
    });

    return waitZones.length;
  });

  const activeBarbers = computed(() => {
    if (typeof liveOccupancy.value?.activeBarbers === 'number') {
      return liveOccupancy.value.activeBarbers;
    }
    if (typeof daemonState.value?.occupancy?.activeBarbers === 'number') {
      return daemonState.value.occupancy.activeBarbers;
    }
    const identifiedStaff = (canvasImageData.value.peopleIdentified || daemonState.value?.people || [])
      .filter(p => p.isStaff === true);

    if (identifiedStaff.length > 0) return identifiedStaff.length;

    const quads = canvasImageData.value.quadrants?.length
      ? canvasImageData.value.quadrants
      : (daemonState.value?.quadrants || []);

    const workingZones = quads.filter(q => {
      const isStation = q.type === 'barber_workstation' || q.category === 'personal';
      return isStation && q.status === 'en_servicio';
    });

    return workingZones.length;
  });

  const totalHumans = computed(() => {
    if (typeof liveOccupancy.value?.totalHumans === 'number') {
      return liveOccupancy.value.totalHumans;
    }
    if (canvasImageData.value.tracks?.length) {
      return canvasImageData.value.tracks.length;
    }
    if (canvasImageData.value.humanBoxes?.length) {
      return canvasImageData.value.humanBoxes.length;
    }
    if (typeof daemonState.value?.humans?.count === 'number') {
      return daemonState.value.humans.count;
    }
    return 0;
  });

  const occupancyKpis = computed(() => ({
    clientsInCut: clientsInCut.value,
    clientsWaiting: clientsWaiting.value,
    activeBarbers: activeBarbers.value,
    totalHumans: totalHumans.value
  }));

  // Helper to add action log from UI triggers
  const addLog = (event) => {
    const timestamp = new Date().toLocaleTimeString('es-PE', { hour12: false });
    actionLogs.value.unshift({
      id: `act_${Date.now()}_${Math.random()}`,
      time: timestamp,
      rawTime: Date.now(),
      title: event.title || 'Acción',
      desc: event.desc || event.message || '',
      type: event.type || 'info',
      icon: event.type === 'warning' ? 'warning' : event.type === 'error' ? 'error' : 'bolt'
    });
    if (actionLogs.value.length > 20) actionLogs.value.pop();
  };

  // Unified real-time event log
  const logs = computed(() => {
    const combined = [];

    // 1. Visit events from Firestore collection camera_catcher_visits
    rawVisits.value.forEach(v => {
      const isCompleted = v.status === 'completed';
      const eventTime = isCompleted ? (v.endedAt || v.createdAt) : (v.startedAt || v.createdAt);
      const timeFormatted = eventTime
        ? new Date(eventTime).toLocaleTimeString('es-PE', { hour12: false })
        : '--:--';

      combined.push({
        id: `vis_${v.id}_${isCompleted ? 'end' : 'start'}`,
        time: timeFormatted,
        rawTime: eventTime ? new Date(eventTime).getTime() : 0,
        title: isCompleted ? 'Visita Registrada' : 'Sesión de Corte Iniciada',
        desc: isCompleted
          ? `${v.personName || 'Cliente'} finalizó servicio en ${v.chairName || 'Silla'} (${v.durationMinutes || 1} min).`
          : `${v.personName || 'Cliente'} inició atención en ${v.chairName || 'Silla de corte'}${v.isFrequent ? ` (Visita #${v.visitCount})` : ''}.`,
        type: isCompleted ? 'visit_completed' : 'visit_active',
        icon: isCompleted ? 'check_circle' : 'content_cut',
        badge: isCompleted ? 'Finalizada' : 'En Atención',
        badgeClass: isCompleted ? 'text-emerald-400 bg-emerald-950/60' : 'text-blue-400 bg-blue-950/60'
      });
    });

    // 2. Telemetry logs from daemon_state history
    telemetryLogs.value.forEach(item => {
      let icon = 'sensors';
      let badge = 'Telemetría';
      let badgeClass = 'text-slate-400 bg-slate-800/60';

      const textLower = (item.text || item.desc || '').toLowerCase();
      if (textLower.includes('humano') || textLower.includes('persona')) {
        icon = 'person_search';
        badge = 'Detección';
        badgeClass = 'text-emerald-400 bg-emerald-950/60';
      } else if (textLower.includes('biométrica') || textLower.includes('clasificación') || textLower.includes('cliente') || textLower.includes('barbero')) {
        icon = 'badge';
        badge = 'Biometría';
        badgeClass = 'text-amber-400 bg-amber-950/60';
      } else if (textLower.includes('cuadrante') || textLower.includes('silla')) {
        icon = 'crop_free';
        badge = 'Espacio';
        badgeClass = 'text-sky-400 bg-sky-950/60';
      } else if (textLower.includes('error') || textLower.includes('falló')) {
        icon = 'error';
        badge = 'Alerta';
        badgeClass = 'text-rose-400 bg-rose-950/60';
      }

      combined.push({
        id: item.id || `hist_${Math.random()}`,
        time: item.timeFormatted || (item.timestamp ? new Date(item.timestamp).toLocaleTimeString('es-PE', { hour12: false }) : '--:--'),
        rawTime: item.timestamp ? new Date(item.timestamp).getTime() : 0,
        title: item.type ? item.type.toUpperCase() : 'TELEMETRÍA',
        desc: item.text || item.desc,
        type: item.type || 'info',
        icon,
        badge,
        badgeClass
      });
    });

    // 3. User action logs
    actionLogs.value.forEach(act => {
      combined.push({
        ...act,
        badge: 'Acción',
        badgeClass: 'text-purple-400 bg-purple-950/60'
      });
    });

    // Sort by rawTime desc
    combined.sort((a, b) => (b.rawTime || 0) - (a.rawTime || 0));

    // Limit to 40 items
    return combined.slice(0, 40);
  });

  // Conexión directa SSE al servidor de telemetría YOLO (Latencia < 20ms)
  const connectYoloStream = () => {
    if (typeof window === 'undefined' || !window.EventSource) return;
    const url = yoloStreamUrl.value;

    // Si no hay URL válida (ej. cloud sin túnel configurado), cerramos SSE y evitamos bucles de reconexión
    if (!url) {
      if (sseEventSource) {
        sseEventSource.close();
        sseEventSource = null;
      }
      isYoloStreaming.value = false;
      isConnected.value = false;
      return;
    }

    try {
      if (sseEventSource) {
        sseEventSource.close();
        sseEventSource = null;
      }
      console.log(`[YOLO Stream] Conectando a flujo directo SSE: ${url}`);
      sseEventSource = new EventSource(url);

      sseEventSource.onopen = () => {
        isYoloStreaming.value = true;
        isConnected.value = true;
        console.log('[YOLO Stream] Flujo SSE conectado exitosamente.');
      };

      sseEventSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data && data.type === 'yolo_telemetry') {
            isYoloStreaming.value = true;
            isConnected.value = true;

            // Actualizar telemetría de cajas y seguimiento en tiempo real
            canvasImageData.value = {
              ...canvasImageData.value,
              docId: data.docId || canvasImageData.value.docId || 'En Vivo',
              frameWidth: data.frameWidth || 640,
              frameHeight: data.frameHeight || 360,
              humanBoxes: data.humanBoxes || [],
              tracks: data.tracks || [],
              quadrants: data.quadrants || canvasImageData.value.quadrants || [],
              peopleIdentified: data.peopleIdentified || canvasImageData.value.peopleIdentified || [],
              inferenceMs: data.inferenceMs || 0
            };

            if (data.occupancy) {
              liveOccupancy.value = data.occupancy;
            }

            if (data.memory) {
              setSystemMemory(data.memory);
            }
          }
        } catch (_) {}
      };

      sseEventSource.addEventListener('daemon_state', (e) => {
        try {
          applyDaemonState(JSON.parse(e.data));
        } catch (_) {}
      });

      sseEventSource.onerror = () => {
        isYoloStreaming.value = false;
        isConnected.value = false;
      };
    } catch (err) {
      console.warn('[YOLO Stream] Error iniciando SSE:', err);
    }
  };

  // Reconectar automáticamente cuando la URL del stream cambie dinámicamente
  watch(yoloStreamUrl, (newUrl, oldUrl) => {
    if (newUrl !== oldUrl) {
      console.log(`[YOLO Stream] URL de telemetría actualizada: ${newUrl || 'desconectada'}`);
      connectYoloStream();
    }
  });

  // Estado del daemon recibido DIRECTAMENTE del backend por SSE (sin Firestore)
  const applyDaemonState = async (data) => {
    if (!data) return;
    isConnected.value = true;
    daemonState.value = data;

    if (Array.isArray(data.history)) {
      telemetryLogs.value = data.history;
    }

    if (!isYoloStreaming.value && (data.humans || data.quadrants || data.people || data.tracks)) {
      canvasImageData.value = {
        ...canvasImageData.value,
        docId: data.lastDocId || canvasImageData.value.docId || 'En Vivo',
        quadrants: data.quadrants || canvasImageData.value.quadrants || [],
        humanBoxes: data.humans?.detections?.map(d => d.box) || (data.detections?.humans) || canvasImageData.value.humanBoxes || [],
        tracks: data.tracks || canvasImageData.value.tracks || [],
        peopleIdentified: data.people || data.detections?.people || canvasImageData.value.peopleIdentified || [],
        inferenceMs: data.humans?.inferenceMs || canvasImageData.value.inferenceMs || 0
      };
    }

    if (data.image?.storagePath) {
      const url = await resolveStorageUrl(data.image.storagePath);
      if (url) canvasImageData.value.imageUrl = url;
    } else if (data.image?.publicUrl) {
      canvasImageData.value.imageUrl = data.image.publicUrl;
    }
  };

  const subscribe = () => {
    // 1. Escuchar cambios de configuración de streamUrl en Firestore en tiempo real
    try {
      const promptDocRef = doc(db, 'camera_catcher', 'prompt');
      unsubscribePrompt = onSnapshot(promptDocRef, (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          firestoreStreamUrl.value = (data.streamUrl || '').trim();
        }
      }, (err) => {
        console.warn('[useDaemonState] Error escuchando camera_catcher/prompt:', err);
      });
    } catch (err) {
      console.warn('[useDaemonState] Error configurando listener de prompt:', err);
    }

    // 2. Conexión directa SSE con el daemon
    connectYoloStream();
  };

  onMounted(() => {
    subscribe();
  });

  onUnmounted(() => {
    if (unsubscribePrompt) unsubscribePrompt();
    if (unsubscribeDaemon) unsubscribeDaemon();
    if (sseEventSource) {
      sseEventSource.close();
      sseEventSource = null;
    }
  });

  return {
    daemonState,
    isConnected,
    isYoloStreaming,
    statusLabel,
    streamUrl,
    snapshotUrl,
    yoloStreamUrl,
    activeBackendUrl,
    canvasImageData,
    clientsInCut,
    clientsWaiting,
    activeBarbers,
    totalHumans,
    occupancyKpis,
    logs,
    addLog
  };
}
