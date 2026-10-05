<script setup>
import { computed } from 'vue';
import ModalTemplate from '@/shared/ui/templates/ModalTemplate.vue';
import ModalHeader from '@/shared/ui/molecules/ModalHeader.vue';
import AppIcon from '@/shared/ui/atoms/AppIcon.vue';
import AppButton from '@/shared/ui/atoms/AppButton.vue';
import AppBadge from '@/shared/ui/atoms/AppBadge.vue';
import AppInput from '@/shared/ui/atoms/AppInput.vue';
import AppTextarea from '@/shared/ui/atoms/AppTextarea.vue';
import TimeRangeField from '@/shared/ui/molecules/TimeRangeField.vue';
import { useSettings } from '@/features/configure-settings/model/useSettings';
import { checkIsWithinWorkingHours } from '@/shared/lib/date-utils';

defineProps({
  show: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(['close']);

const {
  prompt,
  intervalMinutes,
  workingHours,
  loading,
  saving,
  statusMessage,
  statusType,
  saveSettings
} = useSettings();

const workingHoursStatus = computed(() => {
  return checkIsWithinWorkingHours(workingHours.value.start, workingHours.value.end);
});

const onSave = async () => {
  const res = await saveSettings();
  if (res.success) {
    setTimeout(() => {
      emit('close');
    }, 1200);
  }
};
</script>

<template>
  <ModalTemplate :show="show" max-width="max-w-2xl" @close="emit('close')">
    <!-- Header -->
    <ModalHeader
      title="Configuración del Capturador"
      icon="settings"
      tag="camera_catcher/prompt"
      @close="emit('close')"
    />

    <!-- Body -->
    <div class="p-5 sm:p-6 flex flex-col gap-5 overflow-y-auto max-h-[80vh]">
      <!-- Prompt -->
      <div class="flex flex-col gap-1.5">
        <label class="text-xs text-slate-300 font-semibold flex items-center gap-1.5">
          <AppIcon name="psychology" :size="16" class="text-blue-400" />
          Instrucción para Gemini Vision AI:
        </label>
        <AppTextarea
          v-model="prompt"
          rows="3"
          placeholder="Escribe el prompt analítico de visión..."
        />
        <small class="text-[11px] text-slate-400">
          Instrucción analítica enviada al modelo de visión en cada captura periódica.
        </small>
      </div>

      <!-- Capture Interval -->
      <div class="flex flex-col gap-1.5">
        <label class="text-xs text-slate-300 font-semibold flex items-center gap-1.5">
          <AppIcon name="timer" :size="16" class="text-blue-400" />
          Intervalo entre capturas (en minutos):
        </label>
        <div class="flex items-center gap-2">
          <AppInput
            type="number"
            min="0.1"
            step="0.1"
            v-model="intervalMinutes"
            class="max-w-[140px]"
          />
          <span class="text-xs text-slate-400">minutos (ej: 3 = cada 3 min, 0.5 = cada 30 seg)</span>
        </div>
      </div>

      <!-- Working Hours -->
      <div class="flex flex-col gap-2 pt-2 border-t border-slate-800">
        <label class="text-xs text-slate-300 font-semibold flex items-center gap-1.5">
          <AppIcon name="schedule" :size="16" class="text-blue-400" />
          Horario de Atención de la Barbería (Apertura y Cierre):
        </label>
        <TimeRangeField
          v-model:start-time="workingHours.start"
          v-model:end-time="workingHours.end"
        />

        <div class="flex items-center justify-between pt-1">
          <small class="text-[11px] text-slate-400">
            Zona horaria: <strong class="text-slate-200">America/Lima (UTC-5)</strong>. Fuera de horario, las capturas se suspenden.
          </small>
          <AppBadge :variant="workingHoursStatus.isWithin ? 'success' : 'warning'" class="text-[10px]">
            {{ workingHoursStatus.isWithin ? 'Dentro de Horario' : 'Fuera de Horario' }}
          </AppBadge>
        </div>
      </div>

      <!-- Status Banner -->
      <div
        v-if="statusMessage"
        :class="[
          'p-3 rounded-lg text-xs font-medium',
          statusType === 'success' ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-500/30' : 'bg-red-950/60 text-red-300 border border-red-500/30'
        ]"
      >
        {{ statusMessage }}
      </div>
    </div>

    <!-- Footer -->
    <div class="p-4 sm:p-5 border-t border-slate-800 bg-slate-900/60 flex items-center justify-end gap-3">
      <AppButton variant="secondary" @click="emit('close')">
        Cancelar
      </AppButton>
      <AppButton variant="primary" icon="save" :loading="saving" @click="onSave">
        Guardar Configuración
      </AppButton>
    </div>
  </ModalTemplate>
</template>
