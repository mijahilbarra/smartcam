<script setup>
import { ref, computed, watch } from 'vue';
import ModalTemplate from '@/shared/ui/templates/ModalTemplate.vue';
import ModalHeader from '@/shared/ui/molecules/ModalHeader.vue';
import AppButton from '@/shared/ui/atoms/AppButton.vue';
import AppIcon from '@/shared/ui/atoms/AppIcon.vue';

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  appointment: {
    type: Object,
    default: null
  },
  person: {
    type: Object,
    default: null
  },
  loading: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(['close', 'confirm']);

// 'appointment_only' | 'appointment_and_user'
const deleteTarget = ref('appointment_only');

watch(() => props.show, (newVal) => {
  if (newVal) {
    deleteTarget.value = 'appointment_only';
  }
});

const formatTimeOnly = (isoString) => {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return '';
  }
};

const isValidImageUrl = (url) => {
  if (!url || typeof url !== 'string') return false;
  return url.startsWith('data:image/') || url.startsWith('http://') || url.startsWith('https://') || url.startsWith('blob:');
};

const getAvatarUrl = computed(() => {
  if (!props.appointment) return '';
  if (isValidImageUrl(props.appointment.avatarUrl)) return props.appointment.avatarUrl;
  if (isValidImageUrl(props.person?.thumbnailBase64)) return props.person.thumbnailBase64;
  if (Array.isArray(props.appointment.photos)) {
    for (const p of props.appointment.photos) {
      if (!p) continue;
      const candidate = p.thumbnailBase64 || p.base64 || (typeof p === 'string' ? p : '') || p.url;
      if (isValidImageUrl(candidate)) return candidate;
    }
  }
  return '';
});

const personId = computed(() => {
  return props.person?.id || props.appointment?.personId || props.appointment?.clientId || null;
});

const hasAssociatedPerson = computed(() => {
  return Boolean(personId.value);
});

const clientDisplayName = computed(() => {
  return props.person?.name || props.appointment?.clientName || 'Cliente';
});

const onClose = () => {
  if (!props.loading) {
    emit('close');
  }
};

const onConfirm = () => {
  if (!props.loading && props.appointment) {
    emit('confirm', {
      appointmentId: props.appointment.id,
      deleteUser: deleteTarget.value === 'appointment_and_user' && hasAssociatedPerson.value,
      personId: personId.value
    });
  }
};
</script>

<template>
  <ModalTemplate
    :show="show"
    max-width="max-w-lg"
    @close="onClose"
  >
    <!-- Encabezado del Modal -->
    <ModalHeader
      title="Eliminar Atención"
      icon="delete_forever"
      tag="Confirmación"
      @close="onClose"
    />

    <!-- Contenido del Modal -->
    <div v-if="appointment" class="p-4 sm:p-6 space-y-5 text-sm overflow-y-auto">
      <!-- Tarjeta Resumen de la Cita a Eliminar -->
      <div class="bg-slate-800/80 border border-slate-700/80 rounded-2xl p-3.5 flex items-center gap-3">
        <!-- Avatar / Miniatura -->
        <div class="w-12 h-12 rounded-xl bg-slate-700 overflow-hidden flex-shrink-0 border border-slate-600 shadow-inner flex items-center justify-center">
          <img
            v-if="getAvatarUrl"
            :src="getAvatarUrl"
            :alt="clientDisplayName"
            class="w-full h-full object-cover"
          />
          <AppIcon v-else name="person" :size="24" class="text-slate-400" />
        </div>

        <!-- Info principal de la cita -->
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <h4 class="text-sm font-bold text-white truncate">{{ clientDisplayName }}</h4>
            <span
              v-if="appointment.clientBadge"
              class="px-2 py-0.2 rounded text-[10px] font-semibold bg-slate-900 text-blue-300 border border-blue-500/20"
            >
              {{ appointment.clientBadge }}
            </span>
          </div>

          <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-400 mt-1">
            <span class="flex items-center gap-1 text-blue-300">
              <AppIcon name="schedule" :size="13" />
              {{ formatTimeOnly(appointment.startTime) }} - {{ formatTimeOnly(appointment.endTime) }}
            </span>
            <span>•</span>
            <span class="text-slate-300 font-medium">
              {{ appointment.chairName || appointment.chairId }}
            </span>
            <span v-if="appointment.photos?.length">•</span>
            <span v-if="appointment.photos?.length" class="text-emerald-400">
              {{ appointment.photos.length }} fotos
            </span>
          </div>
        </div>
      </div>

      <!-- Pregunta de Acción -->
      <div class="space-y-3">
        <div>
          <h3 class="text-sm font-bold text-slate-100 flex items-center gap-2">
            <AppIcon name="help_outline" :size="18" class="text-amber-400" />
            ¿Deseas borrar también el usuario o solo la atención?
          </h3>
          <p class="text-xs text-slate-400 mt-0.5">
            Elige el alcance de la eliminación antes de continuar.
          </p>
        </div>

        <!-- Opciones Interactivas -->
        <div class="grid grid-cols-1 gap-2.5">
          <!-- Opción 1: Solo la atención -->
          <button
            type="button"
            @click="deleteTarget = 'appointment_only'"
            :class="[
              'w-full text-left p-3.5 rounded-xl border transition-all cursor-pointer flex items-start gap-3',
              deleteTarget === 'appointment_only'
                ? 'bg-amber-500/10 border-amber-500/70 shadow-sm ring-1 ring-amber-500/40'
                : 'bg-slate-800/50 border-slate-700/60 hover:bg-slate-800 hover:border-slate-600'
            ]"
          >
            <!-- Radio Indicator -->
            <div
              :class="[
                'w-4 h-4 rounded-full border mt-0.5 flex items-center justify-center flex-shrink-0 transition',
                deleteTarget === 'appointment_only'
                  ? 'border-amber-400 bg-amber-500'
                  : 'border-slate-500 bg-slate-800'
              ]"
            >
              <div
                v-if="deleteTarget === 'appointment_only'"
                class="w-1.5 h-1.5 rounded-full bg-slate-950"
              ></div>
            </div>

            <!-- Contenido Opción 1 -->
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <AppIcon name="event_busy" :size="16" class="text-amber-400" />
                <span class="text-xs font-bold text-white">Solo borrar la atención</span>
              </div>
              <p class="text-[11px] text-slate-300 mt-1 leading-relaxed">
                Elimina únicamente el registro de esta cita del calendario. El perfil de <span class="font-semibold text-white">{{ clientDisplayName }}</span> y su historial biométrico se mantendrán intactos.
              </p>
            </div>
          </button>

          <!-- Opción 2: Atención y usuario -->
          <button
            type="button"
            :disabled="!hasAssociatedPerson"
            @click="hasAssociatedPerson && (deleteTarget = 'appointment_and_user')"
            :class="[
              'w-full text-left p-3.5 rounded-xl border transition-all flex items-start gap-3',
              !hasAssociatedPerson
                ? 'opacity-40 cursor-not-allowed bg-slate-800/30 border-slate-800'
                : deleteTarget === 'appointment_and_user'
                  ? 'bg-rose-500/15 border-rose-500/80 shadow-sm ring-1 ring-rose-500/40 cursor-pointer'
                  : 'bg-slate-800/50 border-slate-700/60 hover:bg-slate-800 hover:border-slate-600 cursor-pointer'
            ]"
          >
            <!-- Radio Indicator -->
            <div
              :class="[
                'w-4 h-4 rounded-full border mt-0.5 flex items-center justify-center flex-shrink-0 transition',
                deleteTarget === 'appointment_and_user'
                  ? 'border-rose-400 bg-rose-500'
                  : 'border-slate-500 bg-slate-800'
              ]"
            >
              <div
                v-if="deleteTarget === 'appointment_and_user'"
                class="w-1.5 h-1.5 rounded-full bg-white"
              ></div>
            </div>

            <!-- Contenido Opción 2 -->
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <AppIcon name="person_remove" :size="16" class="text-rose-400" />
                <span class="text-xs font-bold text-white">Borrar atención y usuario</span>
                <span
                  v-if="!hasAssociatedPerson"
                  class="text-[10px] text-slate-400 bg-slate-800 px-1.5 py-0.2 rounded border border-slate-700"
                >
                  Sin usuario vinculado
                </span>
              </div>
              <p class="text-[11px] text-slate-300 mt-1 leading-relaxed">
                Elimina esta cita del calendario <strong class="text-rose-300">Y borra permanentemente</strong> el perfil de <span class="font-semibold text-white">{{ clientDisplayName }}</span> del directorio biométrico (incluyendo sus fotos y vectores faciales).
              </p>
            </div>
          </button>
        </div>
      </div>
    </div>

    <!-- Acciones del Modal -->
    <div class="flex items-center justify-end gap-3 p-4 border-t border-slate-800 bg-slate-950/80 shrink-0">
      <AppButton
        variant="secondary"
        size="sm"
        :disabled="loading"
        @click="onClose"
      >
        Cancelar
      </AppButton>

      <AppButton
        :variant="deleteTarget === 'appointment_and_user' ? 'danger' : 'danger'"
        size="sm"
        :icon="deleteTarget === 'appointment_and_user' ? 'person_remove' : 'delete'"
        :loading="loading"
        @click="onConfirm"
      >
        {{ deleteTarget === 'appointment_and_user' ? 'Borrar Atención y Usuario' : 'Borrar Solo Atención' }}
      </AppButton>
    </div>
  </ModalTemplate>
</template>
