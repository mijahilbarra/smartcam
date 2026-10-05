<script setup>
defineProps({
  label: {
    type: String,
    required: true
  },
  value: {
    type: [String, Number],
    required: true
  },
  valueClass: {
    type: String,
    default: 'text-slate-100 font-semibold'
  }
});
</script>

<template>
  <div class="flex items-center gap-1.5 px-3 py-1 bg-slate-850/80 bg-slate-900 border border-slate-800 rounded-lg text-xs">
    <span class="text-slate-400 font-medium">{{ label }}:</span>
    <span :class="valueClass">{{ value }}</span>
  </div>
</template>
