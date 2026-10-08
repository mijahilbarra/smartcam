import { ref, onMounted, onUnmounted } from 'vue';
import { collection, onSnapshot } from 'firebase/firestore';
import { db, BACKEND_URL, resolveStorageUrl } from '@/shared/api/firebase';

export function useAppointments() {
  const appointments = ref([]);
  const loading = ref(true);
  const error = ref(null);

  let unsubscribe = null;

  const isValidUrlOrBase64 = (val) => {
    if (!val || typeof val !== 'string') return false;
    return val.startsWith('data:image/') || val.startsWith('http://') || val.startsWith('https://') || val.startsWith('blob:');
  };

  /**
   * Intenta consultar el endpoint local del backend (/api/appointments) que lee directamente de SQLite
   */
  const fetchFromBackendFallback = async () => {
    try {
      const baseUrl = BACKEND_URL || (typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.hostname}:8085` : 'http://localhost:8085');
      const res = await fetch(`${baseUrl}/api/appointments`);
      if (!res.ok) return false;
      const data = await res.json();
      if (Array.isArray(data.appointments) && data.appointments.length > 0) {
        appointments.value = data.appointments.map(mapAppointmentRecord);
        appointments.value.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
        console.log(`[Appointments] Cargadas ${data.appointments.length} atenciones reales desde SQLite local.`);
        return true;
      }
    } catch (err) {
      console.warn('[Appointments] No se pudo consultar SQLite local:', err.message);
    }
    return false;
  };

  /**
   * Normaliza los datos de una atención para la UI
   */
  const mapAppointmentRecord = (data, id) => {
    const docId = id || data.id || `appt_${Date.now()}`;
    const photos = Array.isArray(data.photos) ? data.photos : [];

    // Buscar primera foto que contenga datos válidos en base64 o URL completa
    let firstPhotoThumb = '';
    for (const p of photos) {
      if (!p) continue;
      const candidate = p.thumbnailBase64 || p.base64 || (typeof p === 'string' ? p : '') || p.url;
      if (isValidUrlOrBase64(candidate)) {
        firstPhotoThumb = candidate;
        break;
      }
    }

    // Solo asignar avatarUrl si es base64 o URL válida
    let avatarUrl = '';
    if (isValidUrlOrBase64(data.thumbnailBase64)) {
      avatarUrl = data.thumbnailBase64;
    } else if (isValidUrlOrBase64(data.avatarUrl)) {
      avatarUrl = data.avatarUrl;
    } else if (firstPhotoThumb) {
      avatarUrl = firstPhotoThumb;
    }

    const rawThumbnailPath = data.thumbnailPath || data.thumbnail_path || (photos[0]?.thumbnailPath) || null;
    const startTime = data.startedAt || data.startTime || new Date().toISOString();
    const endTime = data.endedAt || data.endTime || new Date(new Date(startTime).getTime() + (data.durationMinutes || 45) * 60000).toISOString();

    const record = {
      id: docId,
      chairId: data.chairId || data.chair_id || 'silla_corte_1',
      chairName: data.chairName || data.chair_name || 'Silla de Corte 1',
      personId: data.clientId || data.client_id || data.personId || '',
      clientId: data.clientId || data.client_id || data.personId || '',
      clientName: data.clientName || data.client_name || data.personName || 'Cliente',
      clientBadge: data.clientBadge || ((data.isFrequent || (data.visitCount || 1) > 1) ? 'Cliente Frecuente' : 'Nuevo Cliente'),
      avatarUrl,
      thumbnailPath: rawThumbnailPath,
      startTime,
      endTime,
      startedAt: startTime,
      endedAt: endTime,
      durationMinutes: data.durationMinutes || data.duration_minutes || 45,
      photos,
      status: data.status || 'completed',
      notes: data.notes || ''
    };

    // Si aún no tiene avatarUrl pero tiene ruta en Cloud Storage, resolver asíncronamente
    if (!record.avatarUrl && record.thumbnailPath && typeof resolveStorageUrl === 'function') {
      resolveStorageUrl(record.thumbnailPath).then((resolvedUrl) => {
        if (resolvedUrl) {
          record.avatarUrl = resolvedUrl;
        }
      }).catch(() => {});
    }

    return record;
  };

  const subscribe = () => {
    loading.value = true;
    error.value = null;

    try {
      const colRef = collection(db, 'camera_catcher_appointments');
      
      unsubscribe = onSnapshot(colRef, async (snapshot) => {
        const list = [];
        snapshot.forEach((docSnap) => {
          list.push(mapAppointmentRecord(docSnap.data(), docSnap.id));
        });

        if (list.length > 0) {
          list.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
          appointments.value = list;
          loading.value = false;
        } else {
          // Si Firestore aún no tiene documentos cargados, intentar SQLite local
          const loadedFromBackend = await fetchFromBackendFallback();
          if (!loadedFromBackend) {
            appointments.value = [];
          }
          loading.value = false;
        }
      }, async (err) => {
        console.warn('[Appointments] Error en snapshot de Firestore, intentando SQLite local:', err.message);
        error.value = err.message;
        const loadedFromBackend = await fetchFromBackendFallback();
        if (!loadedFromBackend) {
          appointments.value = [];
        }
        loading.value = false;
      });
    } catch (err) {
      console.warn('[Appointments] Excepción inicializando suscripción:', err.message);
      error.value = err.message;
      fetchFromBackendFallback().then(loaded => {
        if (!loaded) appointments.value = [];
        loading.value = false;
      });
    }
  };

  onMounted(() => {
    subscribe();
  });

  onUnmounted(() => {
    if (unsubscribe) {
      unsubscribe();
    }
  });

  return {
    appointments,
    loading,
    error,
    refresh: subscribe
  };
}
