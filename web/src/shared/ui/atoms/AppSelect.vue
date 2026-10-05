<script setup>
defineProps({
  modelValue: {
    type: [String, Number],
    default: ''
  },
  options: {
    type: Array,
    default: () => []
  },
  disabled: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(['update:modelValue', 'change']);
</script>

<template>
  <select
    :value="modelValue"
    :disabled="disabled"
    @change="emit('update:modelValue', $event.target.value); emit('change', $event)"
    class="bg-slate-900 border border-slate-700 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 rounded-lg px-3 py-1.5 text-sm text-slate-200 outline-none cursor-pointer transition disabled:opacity-50"
  >
    <option
      v-for="opt in options"
      :key="typeof opt === 'object' ? opt.value : opt"
      :value="typeof opt === 'object' ? opt.value : opt"
    >
      {{ typeof opt === 'object' ? opt.label : opt }}
    </option>
    <slot />
  </select>
</template>
