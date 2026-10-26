import { ref, onMounted, onUnmounted } from 'vue';
import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore';
import { db, setCustomBackendUrl, normalizeUrl } from '@/shared/api/firebase';

export function useSettings() {
  const prompt = ref('');
  const workingHours = ref({ start: '11:00', end: '23:00' });
  const streamUrl = ref('');
  const loading = ref(true);
  const saving = ref(false);
  const statusMessage = ref('');
  const statusType = ref('');

  let unsubscribe = null;

  const loadSettings = () => {
    loading.value = true;
    try {
      const docRef = doc(db, 'camera_catcher', 'prompt');
      unsubscribe = onSnapshot(docRef, (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          if (data.prompt) prompt.value = data.prompt;
          if (data.workingHours) {
            workingHours.value = {
              start: data.workingHours.start || '11:00',
              end: data.workingHours.end || '23:00'
            };
          }
          if (data.streamUrl) {
            streamUrl.value = data.streamUrl;
          } else {
            const local = typeof localStorage !== 'undefined' ? localStorage.getItem('CAMERA_CATCHER_API_URL') || '' : '';
            if (local) streamUrl.value = local;
          }
        }
        loading.value = false;
      }, (err) => {
        console.warn('[Settings] Error en listener de configuración:', err);
        loading.value = false;
      });
    } catch (err) {
      console.warn('[Settings] Error iniciando configuración:', err);
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

  onUnmounted(() => {
    if (unsubscribe) unsubscribe();
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
