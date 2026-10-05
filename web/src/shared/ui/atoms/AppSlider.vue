<script setup>
const props = defineProps({
  modelValue: {
    type: Number,
    default: 15
  },
  min: {
    type: Number,
    default: 0.2
  },
  max: {
    type: Number,
    default: 60
  },
  step: {
    type: Number,
    default: 0.2
  },
  presets: {
    type: Array,
    default: () => [
      { label: '30s', value: 0.5 },
      { label: '1m', value: 1 },
      { label: '5m', value: 5 },
      { label: '15m', value: 15 },
      { label: '1h', value: 60 }
    ]
  }
});

const emit = defineEmits(['update:modelValue', 'change']);

const selectPreset = (val) => {
  emit('update:modelValue', val);
  emit('change', val);
};
</script>

<template>
  <div class="w-full flex flex-col gap-2">
    <div class="flex items-center justify-between">
      <slot name="label" />
      <div v-if="presets?.length" class="flex items-center gap-1.5">
        <button
          v-for="p in presets"
          :key="p.value"
          type="button"
          @click="selectPreset(p.value)"
          :class="[
            'text-xs px-2 py-0.5 rounded transition cursor-pointer font-medium select-none',
            Math.abs(modelValue - p.value) < 0.1
              ? 'bg-blue-600 text-white font-semibold'
              : 'bg-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-700'
          ]"
        >
          {{ p.label }}
        </button>
      </div>
    </div>
    <input
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :value="modelValue"
      @input="emit('update:modelValue', parseFloat($event.target.value))"
      @change="emit('change', parseFloat($event.target.value))"
      class="w-full accent-blue-500 cursor-pointer h-2 bg-slate-800 rounded-lg appearance-none"
    />
  </div>
</template>
