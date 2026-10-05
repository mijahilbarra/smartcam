<script setup>
import { ref } from 'vue';
import AppIcon from '@/shared/ui/atoms/AppIcon.vue';
import AppButton from '@/shared/ui/atoms/AppButton.vue';
import AppBadge from '@/shared/ui/atoms/AppBadge.vue';
import AppSpinner from '@/shared/ui/atoms/AppSpinner.vue';
import { usePeople } from '@/entities/person/model/usePeople';
import { formatDateTime } from '@/shared/lib/date-utils';

const isCollapsed = ref(false);
const { people, loading } = usePeople();
</script>

<template>
  <section class="w-full bg-slate-850 bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm flex flex-col">
    <!-- Header -->
    <div
      class="flex items-center justify-between p-4 sm:p-5 border-b border-slate-800 bg-slate-900/60 cursor-pointer select-none"
      @click="isCollapsed = !isCollapsed"
      title="Clic para expandir o contraer"
    >
      <div class="flex items-center gap-3">
        <div class="p-2 rounded-xl bg-sky-950/50 text-sky-400 border border-sky-500/20">
          <AppIcon name="group" :size="22" />
        </div>
        <div>
          <h2 class="text-base sm:text-lg font-bold text-white">Reconocimiento de Personas y Clientes Frecuentes</h2>
          <p class="text-xs text-slate-400">Re-identificación biométrica automática (MobileFaceNet ArcFace) • Staff vs Clientes Frecuentes</p>
        </div>
      </div>

      <div class="flex items-center gap-3">
        <AppBadge variant="info" icon="badge">
          {{ people.length }} personas registradas
        </AppBadge>
        <AppButton
          size="sm"
          variant="secondary"
          :icon="isCollapsed ? 'expand_more' : 'expand_less'"
          @click.stop="isCollapsed = !isCollapsed"
        >
          {{ isCollapsed ? 'Expandir' : 'Contraer' }}
        </AppButton>
      </div>
    </div>

    <!-- Body Grid -->
    <div v-show="!isCollapsed" class="p-4 sm:p-6">
      <div v-if="loading && people.length === 0" class="py-8 text-center text-slate-400 text-xs flex items-center justify-center gap-2">
        <AppSpinner size="sm" />
        <span>Cargando directorio biométrico en tiempo real...</span>
      </div>

      <div v-else-if="people.length === 0" class="py-8 text-center text-slate-500 text-xs">
        No hay personas registradas en el directorio aún. Se detectarán automáticamente con las capturas.
      </div>

      <div v-else class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3.5">
        <div
          v-for="person in people"
          :key="person.id"
          class="bg-slate-950/60 border border-slate-800/80 rounded-xl p-3.5 flex flex-col gap-2 hover:border-slate-700 transition"
        >
          <div class="flex items-center justify-between">
            <span class="font-bold text-sm text-white">{{ person.name || 'Cliente' }}</span>
            <AppBadge :variant="person.isStaff ? 'warning' : 'info'" class="text-[10px]">
              {{ person.isStaff ? 'Staff' : 'Cliente Frecuente' }}
            </AppBadge>
          </div>

          <div class="flex items-center gap-1.5 text-xs text-slate-400">
            <AppIcon name="visibility" :size="14" class="text-slate-500" />
            <span>Visitas detectadas: <strong class="text-slate-200">{{ person.visitsCount || 1 }}</strong></span>
          </div>

          <div v-if="person.lastSeen" class="text-[11px] text-slate-500 font-mono">
            Última: {{ formatDateTime(person.lastSeen) }}
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
