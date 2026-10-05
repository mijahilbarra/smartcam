<script setup>
defineProps({
  modelValue: {
    type: String,
    default: ''
  },
  placeholder: {
    type: String,
    default: ''
  },
  rows: {
    type: [Number, String],
    default: 3
  },
  disabled: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(['update:modelValue']);
</script>

<template>
  <textarea
    :value="modelValue"
    :placeholder="placeholder"
    :rows="rows"
    :disabled="disabled"
    @input="emit('update:modelValue', $event.target.value)"
    class="w-full bg-slate-900 border border-slate-700 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 rounded-lg p-3 text-sm text-slate-100 placeholder-slate-500 outline-none transition resize-y font-sans disabled:opacity-50 disabled:cursor-not-allowed"
  ></textarea>
</template>
