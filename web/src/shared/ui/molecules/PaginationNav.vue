<script setup>
import AppButton from '../atoms/AppButton.vue';
import AppSelect from '../atoms/AppSelect.vue';

const props = defineProps({
  currentPage: {
    type: Number,
    required: true
  },
  totalPages: {
    type: Number,
    required: true
  },
  pageSize: {
    type: Number,
    default: 10
  },
  totalItems: {
    type: Number,
    default: 0
  },
  pageSizeOptions: {
    type: Array,
    default: () => [10, 25, 50]
  }
});

const emit = defineEmits(['update:currentPage', 'update:pageSize']);

const startIndex = () => (props.totalItems === 0 ? 0 : (props.currentPage - 1) * props.pageSize + 1);
const endIndex = () => Math.min(props.currentPage * props.pageSize, props.totalItems);
</script>

<template>
  <div class="flex flex-col sm:flex-row items-center justify-between gap-3 p-3.5 border-t border-slate-700/60 bg-slate-850/40 text-xs text-slate-400">
    <div class="flex items-center gap-4">
      <span>Mostrando {{ startIndex() }} - {{ endIndex() }} de {{ totalItems }}</span>
      <div class="flex items-center gap-1.5">
        <label for="page-size">Filas por página:</label>
        <AppSelect
          id="page-size"
          :model-value="pageSize"
          :options="pageSizeOptions"
          @update:model-value="emit('update:pageSize', Number($event))"
        />
      </div>
    </div>

    <div class="flex items-center gap-1.5">
      <AppButton
        variant="pagination"
        :disabled="currentPage <= 1"
        @click="emit('update:currentPage', 1)"
        title="Primera página"
      >
        «
      </AppButton>
      <AppButton
        variant="pagination"
        :disabled="currentPage <= 1"
        @click="emit('update:currentPage', currentPage - 1)"
        title="Página anterior"
      >
        ‹ Anterior
      </AppButton>
      <span class="px-2.5 py-1 text-slate-300 font-mono">
        Página {{ currentPage }} de {{ Math.max(totalPages, 1) }}
      </span>
      <AppButton
        variant="pagination"
        :disabled="currentPage >= totalPages"
        @click="emit('update:currentPage', currentPage + 1)"
        title="Página siguiente"
      >
        Siguiente ›
      </AppButton>
      <AppButton
        variant="pagination"
        :disabled="currentPage >= totalPages"
        @click="emit('update:currentPage', totalPages)"
        title="Última página"
      >
        »
      </AppButton>
    </div>
  </div>
</template>
