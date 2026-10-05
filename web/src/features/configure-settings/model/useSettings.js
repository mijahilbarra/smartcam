import { ref, onMounted } from 'vue';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '@/shared/api/firebase';

export function useSettings() {
  const prompt = ref('');
  const intervalMinutes = ref(3);
  const workingHours = ref({ start: '11:00', end: '23:00' });
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
        if (data.intervalMinutes) intervalMinutes.value = Number(data.intervalMinutes);
        if (data.workingHours) {
          workingHours.value = {
            start: data.workingHours.start || '11:00',
            end: data.workingHours.end || '23:00'
          };
        }
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
      await setDoc(docRef, {
        prompt: prompt.value,
        intervalMinutes: parseFloat(intervalMinutes.value) || 3,
        workingHours: {
          start: workingHours.value.start || '11:00',
          end: workingHours.value.end || '23:00'
        },
        updatedAt: new Date().toISOString()
      }, { merge: true });

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
    intervalMinutes,
    workingHours,
    loading,
    saving,
    statusMessage,
    statusType,
    loadSettings,
    saveSettings
  };
}
