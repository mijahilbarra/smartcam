<script setup>
const props = defineProps({
  modelValue: {
    type: [String, Number],
    default: ''
  },
  type: {
    type: String,
    default: 'text'
  },
  placeholder: {
    type: String,
    default: ''
  },
  disabled: {
    type: Boolean,
    default: false
  },
  min: {
    type: [Number, String],
    default: null
  },
  max: {
    type: [Number, String],
    default: null
  },
  step: {
    type: [Number, String],
    default: null
  }
});

const emit = defineEmits(['update:modelValue', 'change']);

const onInput = (e) => {
  emit('update:modelValue', e.target.value);
};
</script>

<template>
  <input
    :type="type"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    :min="min"
    :max="max"
    :step="step"
    @input="onInput"
    @change="emit('change', $event)"
    class="w-full bg-slate-900 border border-slate-700 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none transition disabled:opacity-50 disabled:cursor-not-allowed"
  />
</template>
