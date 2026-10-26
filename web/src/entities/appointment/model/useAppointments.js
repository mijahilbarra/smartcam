import { ref, onMounted, onUnmounted } from 'vue';
import { collection, doc, deleteDoc, onSnapshot } from 'firebase/firestore';
import { db, resolveStorageUrl } from '@/shared/api/firebase';
import { getBestFaceThumbnail, isValidImageUrl } from '@/shared/lib/photo-utils';

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
   * Normaliza los datos de una atención para la UI
   */
  const mapAppointmentRecord = (data, id) => {
    const docId = id || data.id || `appt_${Date.now()}`;
    const photos = Array.isArray(data.photos) ? data.photos : [];
    const targetScore = data.bestFaceScore ?? data.best_face_score ?? 0;
    const fallbackThumb = data.thumbnailBase64 || data.avatarUrl || null;

    // Seleccionar la foto con mayor nitidez (bestFaceScore) de la atención
    const avatarUrl = getBestFaceThumbnail(photos, fallbackThumb, targetScore);

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
      
      unsubscribe = onSnapshot(colRef, (snapshot) => {
        const list = [];
        snapshot.forEach((docSnap) => {
          list.push(mapAppointmentRecord(docSnap.data(), docSnap.id));
        });
        list.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
        appointments.value = list;
        loading.value = false;
      }, (err) => {
        console.warn('[Appointments] Error en snapshot de Firestore:', err.message);
        error.value = err.message;
        loading.value = false;
      });
    } catch (err) {
      console.warn('[Appointments] Excepción inicializando suscripción:', err.message);
      error.value = err.message;
      loading.value = false;
    }
  };

  /**
   * Elimina una atención de Firestore (camera_catcher_appointments y camera_catcher_visits)
   */
  const deleteAppointment = async (appointmentId, { deletePersonId = null } = {}) => {
    if (!appointmentId) return;
    try {
      // 1. Eliminar de Firestore camera_catcher_appointments
      const apptRef = doc(db, 'camera_catcher_appointments', appointmentId);
      await deleteDoc(apptRef);

      // 2. Eliminar de Firestore camera_catcher_visits si existe
      try {
        const visitRef = doc(db, 'camera_catcher_visits', appointmentId);
        await deleteDoc(visitRef);
      } catch (vErr) {
        // Silencioso si no existía documento en visits
      }

      // Actualizar reactividad local inmediatamente
      appointments.value = appointments.value.filter(a => a.id !== appointmentId);
      return { success: true };
    } catch (err) {
      console.error('[Appointments] Error eliminando atención:', err);
      throw err;
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
    refresh: subscribe,
    deleteAppointment
  };
}
