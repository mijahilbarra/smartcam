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
import { getEnvironmentInfo, switchFirestoreDatabase } from '@/shared/api/firebase';

const envInfo = getEnvironmentInfo();

defineProps({
  show: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(['close']);

const {
  prompt,
  workingHours,
  streamUrl,
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
          Instrucción analítica enviada al modelo de visión en cada análisis.
        </small>
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

      <!-- Stream Tunnel URL Setting (HTTPS) -->
      <div class="flex flex-col gap-1.5 pt-2 border-t border-slate-800">
        <label class="text-xs text-slate-300 font-semibold flex items-center justify-between">
          <span class="flex items-center gap-1.5">
            <AppIcon name="link" :size="16" class="text-blue-400" />
            URL del Túnel del Stream (HTTPS):
          </span>
          <AppBadge v-if="streamUrl" variant="success" class="text-[10px] font-mono">
            Configurado
          </AppBadge>
          <AppBadge v-else variant="default" class="text-[10px] text-slate-400">
            Opcional (Prod)
          </AppBadge>
        </label>
        <AppInput
          v-model="streamUrl"
          type="url"
          placeholder="https://stream.tudominio.com"
        />
        <small class="text-[11px] text-slate-400 leading-relaxed">
          Para ver el stream en vivo en producción (ej. <code class="text-slate-300">https://stream.tudominio.com</code> o túnel Cloudflare). En desarrollo local se utiliza automáticamente <code class="text-slate-300">http://localhost:8085</code>.
        </small>
      </div>

      <!-- Firestore Database Setting -->
      <div class="flex flex-col gap-2 pt-2 border-t border-slate-800">
        <label class="text-xs text-slate-300 font-semibold flex items-center justify-between">
          <span class="flex items-center gap-1.5">
            <AppIcon name="database" :size="16" class="text-blue-400" />
            Base de Datos Firestore:
          </span>
          <AppBadge :variant="envInfo.databaseId === 'test' ? 'warning' : 'info'" class="text-[10px] font-mono">
            {{ envInfo.databaseId }}
          </AppBadge>
        </label>
        <div class="flex items-center gap-2">
          <AppButton
            variant="secondary"
            class="text-xs py-1 px-2.5"
            :class="{ 'border-amber-500/50 bg-amber-500/10 text-amber-300': envInfo.databaseId === 'test' }"
            @click="switchFirestoreDatabase('test')"
          >
            Usar "test" (Local / Dev)
          </AppButton>
          <AppButton
            variant="secondary"
            class="text-xs py-1 px-2.5"
            :class="{ 'border-blue-500/50 bg-blue-500/10 text-blue-300': envInfo.databaseId === '(default)' }"
            @click="switchFirestoreDatabase('(default)')"
          >
            Usar "(default)" (Prod)
          </AppButton>
          <AppButton
            v-if="envInfo.hasCustomDb"
            variant="secondary"
            class="text-[11px] py-1 px-2 text-slate-400"
            @click="switchFirestoreDatabase('auto')"
            title="Restablecer al valor automático según entorno"
          >
            Auto
          </AppButton>
        </div>
        <small class="text-[11px] text-slate-400 leading-relaxed">
          • Local / Dev: DB <strong class="text-amber-400">test</strong> y Bucket <strong class="text-amber-400">skip-bigotes-test</strong>.<br/>
          • Producción GCP: DB <strong class="text-blue-400">(default)</strong> y Bucket <strong class="text-blue-400">skip-bigotes.firebasestorage.app</strong>.
        </small>
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
