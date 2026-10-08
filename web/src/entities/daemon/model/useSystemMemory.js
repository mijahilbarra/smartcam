import { ref, computed } from 'vue';

// Referencia compartida a nivel de módulo (singleton)
const systemMemory = ref(null);

/**
 * Actualiza los datos de memoria del sistema desde SSE o reportes del daemon
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
    memoryLabel
  };
}
