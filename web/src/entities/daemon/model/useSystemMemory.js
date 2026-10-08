import { ref, computed, onMounted, onUnmounted, getCurrentInstance } from 'vue';
import { getEnvironmentInfo } from '@/shared/api/firebase';

// Referencia compartida a nivel de módulo (singleton)
const systemMemory = ref(null);

/**
 * Actualiza los datos de memoria del sistema desde SSE o fetch
 * @param {Object} data
 */
export function setSystemMemory(data) {
  if (data) {
    systemMemory.value = data;
  }
}

/**
 * Composable para el monitoreo de uso de RAM en el daemon / VM
 */
export function useSystemMemory() {
  const fetchMemory = async () => {
    try {
      const env = getEnvironmentInfo();
      const backendUrl = env?.backendUrl;
      if (!backendUrl) return;

      const res = await fetch(`${backendUrl}/`);
      if (!res.ok) return;

      const data = await res.json();
      if (data && data.memory) {
        setSystemMemory(data.memory);
      }
    } catch (_) {
      // Backend en reposo o no disponible por red
    }
  };

  let intervalId = null;

  if (getCurrentInstance()) {
    onMounted(() => {
      fetchMemory();
      intervalId = setInterval(fetchMemory, 10000);
    });

    onUnmounted(() => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    });
  }

  const memoryBadgeVariant = computed(() => {
    if (!systemMemory.value || typeof systemMemory.value.rssMB !== 'number') {
      return 'info';
    }
    if (systemMemory.value.rssMB >= 700) {
      return 'danger';
    }
    if (systemMemory.value.rssMB >= 450) {
      return 'warning';
    }
    return 'info';
  });

  const memoryLabel = computed(() => {
    if (!systemMemory.value || typeof systemMemory.value.rssMB !== 'number') {
      return '';
    }
    return `RAM: ${Math.round(systemMemory.value.rssMB)} MB`;
  });

  return {
    systemMemory,
    memoryBadgeVariant,
    memoryLabel,
    fetchMemory
  };
}
