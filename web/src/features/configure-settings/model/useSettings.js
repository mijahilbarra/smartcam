import { ref, onMounted } from 'vue';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db, setCustomBackendUrl, normalizeUrl } from '@/shared/api/firebase';

export function useSettings() {
  const prompt = ref('');
  const workingHours = ref({ start: '11:00', end: '23:00' });
  const streamUrl = ref('');
  const loading = ref(true);
  const saving = ref(false);
  const statusMessage = ref('');
  const statusType = ref('');

  const loadSettings = async () => {
    loading.value = true;
    try {
      const docRef = doc(db, 'camera_catcher', 'prompt');
      const snap = await getDoc(docRef);
      if (snap.exists()) {
        const data = snap.data();
        if (data.prompt) prompt.value = data.prompt;
        if (data.workingHours) {
          workingHours.value = {
            start: data.workingHours.start || '11:00',
            end: data.workingHours.end || '23:00'
          };
        }
        streamUrl.value = data.streamUrl || (typeof localStorage !== 'undefined' ? localStorage.getItem('CAMERA_CATCHER_API_URL') || '' : '');
      } else {
        const local = typeof localStorage !== 'undefined' ? localStorage.getItem('CAMERA_CATCHER_API_URL') || '' : '';
        if (local) streamUrl.value = local;
      }
    } catch (err) {
      console.warn('[Settings] Error cargando configuración:', err);
    } finally {
      loading.value = false;
    }
  };

  const saveSettings = async () => {
    saving.value = true;
    statusMessage.value = 'Guardando configuración en Firestore...';
    statusType.value = 'info';

    try {
      const docRef = doc(db, 'camera_catcher', 'prompt');
      const normalizedStreamUrl = normalizeUrl(streamUrl.value) || '';

      await setDoc(docRef, {
        prompt: prompt.value,
        workingHours: {
          start: workingHours.value.start || '11:00',
          end: workingHours.value.end || '23:00'
        },
        streamUrl: normalizedStreamUrl,
        updatedAt: new Date().toISOString()
      }, { merge: true });

      // Actualizar localStorage (en local, evitar guardar dominios remotos en localStorage)
      if (typeof localStorage !== 'undefined') {
        const isLocal = typeof window !== 'undefined' && (
          window.location.hostname === 'localhost' ||
          window.location.hostname === '127.0.0.1'
        );
        const isUrlLocal = normalizedStreamUrl && /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)/i.test(normalizedStreamUrl);

        if (normalizedStreamUrl) {
          if (!isLocal || isUrlLocal) {
            localStorage.setItem('CAMERA_CATCHER_API_URL', normalizedStreamUrl);
          } else {
            localStorage.removeItem('CAMERA_CATCHER_API_URL');
          }
        } else {
          localStorage.removeItem('CAMERA_CATCHER_API_URL');
        }
      }

      statusMessage.value = '¡Configuración guardada exitosamente!';
      statusType.value = 'success';
      saving.value = false;
      return { success: true };
    } catch (err) {
      console.error('[Settings] Error guardando configuración:', err);
      statusMessage.value = `Error: ${err.message}`;
      statusType.value = 'error';
      saving.value = false;
      return { success: false, error: err.message };
    }
  };

  onMounted(() => {
    loadSettings();
  });

  return {
    prompt,
    workingHours,
    streamUrl,
    loading,
    saving,
    statusMessage,
    statusType,
    loadSettings,
    saveSettings
  };
}
