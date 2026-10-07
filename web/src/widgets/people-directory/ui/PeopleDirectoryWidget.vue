<script setup>
import { ref, computed } from 'vue';
import AppIcon from '@/shared/ui/atoms/AppIcon.vue';
import AppButton from '@/shared/ui/atoms/AppButton.vue';
import AppBadge from '@/shared/ui/atoms/AppBadge.vue';
import AppSpinner from '@/shared/ui/atoms/AppSpinner.vue';
import ConfirmModal from '@/shared/ui/molecules/ConfirmModal.vue';
import ClientPhotosModal from './ClientPhotosModal.vue';
import { usePeople } from '@/entities/person/model/usePeople';
import { computeMergedPersonData, parseDateMs } from '@/entities/person/model/person-merge';
import { formatDateTime } from '@/shared/lib/date-utils';

const isCollapsed = ref(false);
const searchQuery = ref('');
const activeFilter = ref('all'); // 'all' | 'barbers' | 'clients'
const sortBy = ref('lastSeen'); // 'lastSeen' | 'visits' | 'name'

// Estado de selección múltiple
const selectedPersonIds = ref(new Set());

// Estado de edición de nombre
const editingId = ref(null);
const editingName = ref('');
const updatingId = ref(null);

// Estado de modal de fotos y ángulos
const selectedPersonIdForPhotos = ref(null);
const isPhotosModalOpen = ref(false);

// Estado de modal para eliminación individual
const personToDelete = ref(null);
const isConfirmDeleteOpen = ref(false);
const isDeletingSingle = ref(false);

// Estado de modal para eliminación por lote
const isConfirmBatchDeleteOpen = ref(false);
const isBatchDeleting = ref(false);

// Estado de modal para fusión de perfiles
const isMergeModalOpen = ref(false);
const isMerging = ref(false);
const mergeTargetId = ref(null);
const mergeTargetName = ref('');

const {
  people,
  loading,
  error,
  barbersCount,
  frequentCount,
  newClientsCount,
  toggleRole,
  updatePersonName,
  deletePerson,
  batchDeletePeople,
  mergePeople,
  deletePersonPhoto
} = usePeople();

// Perfil activo para el visor de fotos (reactivo con el estado de Firestore)
const selectedPersonForPhotos = computed(() => {
  if (!selectedPersonIdForPhotos.value) return null;
  return people.value.find(p => p.id === selectedPersonIdForPhotos.value) || null;
});

const openPhotosModal = (person) => {
  selectedPersonIdForPhotos.value = person.id;
  isPhotosModalOpen.value = true;
};

const closePhotosModal = () => {
  isPhotosModalOpen.value = false;
  selectedPersonIdForPhotos.value = null;
};

const handleDeletePersonFromModal = async (person) => {
  try {
    await deletePerson(person.id);
    selectedPersonIds.value.delete(person.id);
    closePhotosModal();
  } catch (err) {
    alert(`Error al eliminar: ${err.message}`);
  }
};

const handleDeletePhotoFromModal = async ({ personId, photoIndex }) => {
  try {
    await deletePersonPhoto(personId, photoIndex);
  } catch (err) {
    alert(`Error al eliminar ángulo: ${err.message}`);
  }
};

// Filtrado y ordenación reactiva de personas
const filteredPeople = computed(() => {
  let list = [...people.value];

  if (activeFilter.value === 'barbers') {
    list = list.filter(p => p.isStaff);
  } else if (activeFilter.value === 'clients') {
    list = list.filter(p => !p.isStaff);
  }

  if (searchQuery.value.trim()) {
    const q = searchQuery.value.trim().toLowerCase();
    list = list.filter(p =>
      p.name?.toLowerCase().includes(q) ||
      p.id?.toLowerCase().includes(q)
    );
  }

  list.sort((a, b) => {
    // Si estamos en la pestaña 'Todos', mantener a barberos arriba
    if (activeFilter.value === 'all' && a.isStaff !== b.isStaff) {
      return a.isStaff ? -1 : 1;
    }

    if (sortBy.value === 'lastSeen') {
      const timeA = parseDateMs(a.lastSeen);
      const timeB = parseDateMs(b.lastSeen);
      if (timeB !== timeA) return timeB - timeA;
      return (b.visitCount || 1) - (a.visitCount || 1);
    }

    if (sortBy.value === 'visits') {
      const diffVisits = (b.visitCount || 1) - (a.visitCount || 1);
      if (diffVisits !== 0) return diffVisits;
      return parseDateMs(b.lastSeen) - parseDateMs(a.lastSeen);
    }

    if (sortBy.value === 'name') {
      return (a.name || '').localeCompare(b.name || '');
    }

    return 0;
  });

  return list;
});

// Selección múltiple
const isSelected = (id) => selectedPersonIds.value.has(id);

const toggleSelect = (id) => {
  const next = new Set(selectedPersonIds.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  selectedPersonIds.value = next;
};

const clearSelection = () => {
  selectedPersonIds.value = new Set();
};

const selectAllVisible = () => {
  const next = new Set(selectedPersonIds.value);
  filteredPeople.value.forEach(p => next.add(p.id));
  selectedPersonIds.value = next;
};

const selectedProfiles = computed(() => {
  return people.value.filter(p => selectedPersonIds.value.has(p.id));
});

// Vista previa de fusión
const mergePreview = computed(() => {
  if (selectedProfiles.value.length < 2) return null;
  try {
    return computeMergedPersonData(selectedProfiles.value, {
      targetId: mergeTargetId.value,
      name: mergeTargetName.value
    });
  } catch {
    return null;
  }
});

const onToggleRole = async (person) => {
  updatingId.value = person.id;
  try {
    await toggleRole(person);
  } catch (err) {
    alert(`Error al cambiar rol: ${err.message}`);
  } finally {
    updatingId.value = null;
  }
};

const startEditing = (person) => {
  editingId.value = person.id;
  editingName.value = person.name || '';
};

const cancelEditing = () => {
  editingId.value = null;
  editingName.value = '';
};

const saveEditing = async (person) => {
  if (!editingName.value.trim()) return;
  updatingId.value = person.id;
  try {
    await updatePersonName(person.id, editingName.value);
    editingId.value = null;
  } catch (err) {
    alert(`Error al guardar nombre: ${err.message}`);
  } finally {
    updatingId.value = null;
  }
};

// Eliminación individual con ConfirmModal
const promptDeletePerson = (person) => {
  personToDelete.value = person;
  isConfirmDeleteOpen.value = true;
};

const confirmDeletePerson = async () => {
  if (!personToDelete.value) return;
  isDeletingSingle.value = true;
  try {
    await deletePerson(personToDelete.value.id);
    const next = new Set(selectedPersonIds.value);
    next.delete(personToDelete.value.id);
    selectedPersonIds.value = next;
    isConfirmDeleteOpen.value = false;
    personToDelete.value = null;
  } catch (err) {
    alert(`Error al eliminar: ${err.message}`);
  } finally {
    isDeletingSingle.value = false;
  }
};

// Eliminación múltiple con ConfirmModal
const openBatchDeleteModal = () => {
  if (selectedPersonIds.value.size === 0) return;
  isConfirmBatchDeleteOpen.value = true;
};

const confirmBatchDelete = async () => {
  if (selectedPersonIds.value.size === 0) return;
  isBatchDeleting.value = true;
  try {
    await batchDeletePeople(Array.from(selectedPersonIds.value));
    clearSelection();
    isConfirmBatchDeleteOpen.value = false;
  } catch (err) {
    alert(`Error al eliminar perfiles: ${err.message}`);
  } finally {
    isBatchDeleting.value = false;
  }
};

// Fusión de perfiles con ConfirmModal
const openMergeModal = () => {
  if (selectedPersonIds.value.size < 2) return;
  const sorted = [...selectedProfiles.value].sort((a, b) => {
    const timeA = parseDateMs(a.firstSeen) || parseDateMs(a.lastSeen) || Infinity;
    const timeB = parseDateMs(b.firstSeen) || parseDateMs(b.lastSeen) || Infinity;
    return timeA - timeB;
  });
  mergeTargetId.value = sorted[0]?.id || selectedProfiles.value[0]?.id;
  mergeTargetName.value = sorted[0]?.name || selectedProfiles.value[0]?.name || '';
  isMergeModalOpen.value = true;
};

const confirmMerge = async () => {
  if (selectedProfiles.value.length < 2) return;
  isMerging.value = true;
  try {
    await mergePeople(selectedProfiles.value, {
      targetId: mergeTargetId.value,
      name: mergeTargetName.value
    });
    clearSelection();
    isMergeModalOpen.value = false;
  } catch (err) {
    alert(`Error al fusionar perfiles: ${err.message}`);
  } finally {
    isMerging.value = false;
  }
};
</script>

<template>
  <section class="w-full bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl flex flex-col relative">
    <!-- Header -->
    <div
      class="flex flex-col sm:flex-row sm:items-center justify-between p-4 sm:p-5 border-b border-slate-800 bg-slate-900/90 gap-4 cursor-pointer select-none"
      @click="isCollapsed = !isCollapsed"
      title="Clic para expandir o contraer"
    >
      <div class="flex items-center gap-3">
        <div class="p-2.5 rounded-xl bg-sky-950/60 text-sky-400 border border-sky-500/30 flex items-center justify-center">
          <AppIcon name="groups" :size="24" />
        </div>
        <div>
          <div class="flex items-center gap-2.5">
            <h2 class="text-base sm:text-lg font-bold text-white tracking-wide">
              Directorio de Personas y Roles Biométricos
            </h2>
            <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-sky-950 text-sky-400 border border-sky-500/20">
              {{ people.length }} perfiles
            </span>
          </div>
          <p class="text-xs text-slate-400 mt-0.5">
            Perfiles faciales registrados automáticamente por IA. Cambia manualmente a <strong class="text-sky-300">Barbero</strong> para que el modelo lo reconozca como Staff en vivo.
          </p>
        </div>
      </div>

      <div class="flex items-center gap-2 sm:gap-3 flex-wrap">
        <div class="flex items-center gap-1.5 text-xs">
          <span class="px-2.5 py-1 rounded-lg bg-sky-950/70 text-sky-300 border border-sky-500/30 font-medium flex items-center gap-1.5">
            <AppIcon name="content_cut" :size="14" />
            <span>{{ barbersCount }} Barberos</span>
          </span>
          <span class="px-2.5 py-1 rounded-lg bg-amber-950/60 text-amber-300 border border-amber-500/30 font-medium flex items-center gap-1.5">
            <AppIcon name="star" :size="14" />
            <span>{{ frequentCount }} Frecuentes</span>
          </span>
        </div>

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

    <!-- Body Controls & Content -->
    <div v-show="!isCollapsed" class="p-4 sm:p-6 flex flex-col gap-5">
      <!-- Toolbar: Search, Sort and Filter Tabs -->
      <div class="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3 bg-slate-950/50 p-3 rounded-xl border border-slate-800">
        <!-- Search bar -->
        <div class="relative flex-1 max-w-md">
          <AppIcon name="search" :size="18" class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Buscar por nombre o ID de perfil..."
            class="w-full pl-9 pr-4 py-2 bg-slate-900 border border-slate-700/80 rounded-lg text-xs sm:text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition"
          />
          <button
            v-if="searchQuery"
            @click="searchQuery = ''"
            class="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
          >
            <AppIcon name="close" :size="16" />
          </button>
        </div>

        <div class="flex items-center gap-3 flex-wrap">
          <!-- Multi-select helper buttons -->
          <div class="flex items-center gap-1.5">
            <button
              v-if="selectedPersonIds.size > 0"
              type="button"
              @click="clearSelection"
              class="px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 transition cursor-pointer flex items-center gap-1"
              title="Deseleccionar todos"
            >
              <AppIcon name="close" :size="14" />
              <span>Limpiar ({{ selectedPersonIds.size }})</span>
            </button>
            <button
              v-else-if="filteredPeople.length > 0"
              type="button"
              @click="selectAllVisible"
              class="px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-sky-300 bg-slate-900/80 hover:bg-slate-800 border border-slate-700/70 transition cursor-pointer flex items-center gap-1"
              title="Seleccionar todos los perfiles visibles"
            >
              <AppIcon name="checklist" :size="14" />
              <span>Seleccionar todos</span>
            </button>
          </div>

          <!-- Sort dropdown -->
          <div class="flex items-center gap-1.5 text-xs text-slate-400">
            <AppIcon name="sort" :size="15" class="text-slate-400" />
            <span class="hidden sm:inline">Ordenar:</span>
            <select
              v-model="sortBy"
              class="bg-slate-900 border border-slate-700/80 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-sky-500 cursor-pointer"
            >
              <option value="lastSeen">Última vez (más reciente)</option>
              <option value="visits">Más visitas</option>
              <option value="name">Nombre (A-Z)</option>
            </select>
          </div>

          <!-- Filter tabs -->
          <div class="flex items-center gap-1.5 select-none overflow-x-auto pb-1 lg:pb-0">
            <button
              type="button"
              @click="activeFilter = 'all'"
              :class="[
                'px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer',
                activeFilter === 'all'
                  ? 'bg-slate-700 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              ]"
            >
              Todos ({{ people.length }})
            </button>
            <button
              type="button"
              @click="activeFilter = 'barbers'"
              :class="[
                'px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer flex items-center gap-1.5',
                activeFilter === 'barbers'
                  ? 'bg-sky-600 text-white shadow-sm'
                  : 'text-sky-400 hover:text-sky-200 hover:bg-sky-950/40'
              ]"
            >
              <AppIcon name="content_cut" :size="14" />
              <span>Barberos ({{ barbersCount }})</span>
            </button>
            <button
              type="button"
              @click="activeFilter = 'clients'"
              :class="[
                'px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer flex items-center gap-1.5',
                activeFilter === 'clients'
                  ? 'bg-slate-700 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              ]"
            >
              <AppIcon name="person" :size="14" />
              <span>Clientes ({{ people.length - barbersCount }})</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Loading State -->
      <div v-if="loading && people.length === 0" class="py-12 text-center text-slate-400 text-xs flex items-center justify-center gap-3">
        <AppSpinner size="md" />
        <span>Sincronizando perfiles biométricos desde Firestore...</span>
      </div>

      <!-- Empty State -->
      <div v-else-if="filteredPeople.length === 0" class="py-12 text-center text-slate-500 text-sm flex flex-col items-center justify-center gap-2">
        <AppIcon name="person_search" :size="36" class="text-slate-600" />
        <span>No se encontraron perfiles que coincidan con la búsqueda o filtro.</span>
      </div>

      <!-- People Grid -->
      <div v-else class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        <div
          v-for="person in filteredPeople"
          :key="person.id"
          :class="[
            'border rounded-xl p-4 flex flex-col justify-between gap-3.5 transition-all shadow-sm relative overflow-hidden',
            isSelected(person.id)
              ? 'ring-2 ring-sky-400/80 border-sky-400 shadow-sky-950/50 bg-slate-900'
              : (person.isStaff
                ? 'bg-slate-900/90 border-sky-500/50 hover:border-sky-400 shadow-sky-950/20'
                : (person.visitCount > 1
                  ? 'bg-slate-950/70 border-amber-500/40 hover:border-amber-400/70'
                  : 'bg-slate-950/50 border-slate-800 hover:border-slate-700'))
          ]"
        >
          <!-- Top Row: Selection Checkbox, Avatar & Role Badge -->
          <div class="flex items-start justify-between gap-2">
            <div class="flex items-center gap-2.5 min-w-0">
              <!-- Botón de Selección múltiple -->
              <button
                type="button"
                @click.stop="toggleSelect(person.id)"
                :class="[
                  'p-1 rounded-lg transition-colors cursor-pointer shrink-0 flex items-center justify-center',
                  isSelected(person.id)
                    ? 'bg-sky-600 text-white shadow-sm ring-1 ring-sky-400'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/80 bg-slate-900/80 border border-slate-700/60'
                ]"
                :title="isSelected(person.id) ? 'Deseleccionar perfil' : 'Seleccionar perfil'"
              >
                <AppIcon :name="isSelected(person.id) ? 'check_box' : 'check_box_outline_blank'" :size="18" />
              </button>

              <!-- Avatar con Miniatura Facial Real o fallback -->
              <div
                @click="openPhotosModal(person)"
                :class="[
                  'w-12 h-12 rounded-xl flex items-center justify-center font-bold text-sm shrink-0 border overflow-hidden relative shadow-md transition-all cursor-pointer hover:scale-105 hover:ring-2 hover:ring-sky-400 hover:shadow-sky-500/20',
                  person.isStaff
                    ? 'bg-sky-950 text-sky-300 border-sky-500/50 shadow-sky-950/40'
                    : (person.visitCount > 1
                      ? 'bg-amber-950 text-amber-300 border-amber-500/40'
                      : 'bg-emerald-950 text-emerald-300 border-emerald-500/30')
                ]"
                title="Ver fotos y ángulos biométricos"
              >
                <img
                  v-if="person.thumbnailBase64"
                  :src="person.thumbnailBase64"
                  :alt="person.name"
                  class="w-full h-full object-cover"
                />
                <template v-else>
                  <AppIcon v-if="person.isStaff" name="content_cut" :size="22" />
                  <span v-else class="text-base font-bold">{{ (person.name || 'C').charAt(0).toUpperCase() }}</span>
                </template>
              </div>

              <!-- Name & Inline Edit -->
              <div class="min-w-0 flex-1">
                <div v-if="editingId === person.id" class="flex items-center gap-1">
                  <input
                    v-model="editingName"
                    @keyup.enter="saveEditing(person)"
                    @keyup.esc="cancelEditing"
                    type="text"
                    class="w-full px-2 py-1 bg-slate-800 border border-sky-500 rounded text-xs text-white focus:outline-none"
                    placeholder="Nombre..."
                    autoFocus
                  />
                  <button
                    @click="saveEditing(person)"
                    class="p-1 rounded bg-sky-600 hover:bg-sky-500 text-white shrink-0 cursor-pointer"
                    title="Guardar nombre"
                  >
                    <AppIcon name="check" :size="14" />
                  </button>
                  <button
                    @click="cancelEditing"
                    class="p-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 shrink-0 cursor-pointer"
                    title="Cancelar"
                  >
                    <AppIcon name="close" :size="14" />
                  </button>
                </div>

                <div v-else class="flex items-center gap-1.5 group">
                  <span
                    class="font-bold text-sm text-white truncate max-w-[130px]"
                    :title="person.name"
                  >
                    {{ person.name }}
                  </span>
                  <button
                    @click="startEditing(person)"
                    class="opacity-0 group-hover:opacity-100 p-0.5 text-slate-400 hover:text-sky-300 transition cursor-pointer"
                    title="Editar nombre"
                  >
                    <AppIcon name="edit" :size="14" />
                  </button>
                </div>

                <div class="text-[11px] text-slate-500 font-mono truncate" :title="person.id">
                  {{ person.id }}
                </div>
              </div>
            </div>

            <!-- Role Badge -->
            <div class="shrink-0">
              <span
                v-if="person.isStaff"
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-sky-950 text-sky-300 border border-sky-500/40"
              >
                <AppIcon name="badge" :size="12" />
                Barbero
              </span>
              <span
                v-else-if="person.visitCount > 1"
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-950/80 text-amber-300 border border-amber-500/40"
              >
                Frecuente
              </span>
              <span
                v-else
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-950/60 text-emerald-300 border border-emerald-500/30"
              >
                Nuevo
              </span>
            </div>
          </div>

          <!-- Middle Row: Metrics -->
          <div class="flex flex-col gap-1.5 text-xs text-slate-400 bg-slate-950/40 p-2.5 rounded-lg border border-slate-800/60">
            <div class="flex items-center justify-between">
              <span class="flex items-center gap-1.5">
                <AppIcon name="visibility" :size="14" class="text-slate-500" />
                <span>Visitas:</span>
              </span>
              <strong :class="person.visitCount > 1 ? 'text-amber-300' : 'text-slate-200'">
                {{ person.visitCount }}
              </strong>
            </div>

            <div class="flex items-center justify-between">
              <span class="flex items-center gap-1.5">
                <AppIcon name="collections" :size="14" class="text-slate-500" />
                <span>Ángulos guardados:</span>
              </span>
              <span class="font-mono text-sky-300 font-semibold">
                {{ person.photos?.length || (person.thumbnailBase64 ? 1 : 0) }}
              </span>
            </div>

            <div class="flex items-center justify-between">
              <span class="flex items-center gap-1.5">
                <AppIcon name="center_focus_strong" :size="14" class="text-slate-500" />
                <span>Nitidez facial:</span>
              </span>
              <span class="font-mono text-slate-300">
                {{ person.bestFaceScore }}%
              </span>
            </div>

            <div class="flex items-center justify-between pt-1 border-t border-slate-800/50 text-[10px] text-slate-500">
              <span class="flex items-center gap-1">
                <AppIcon name="login" :size="13" class="text-emerald-500" />
                <span>Entrada:</span>
              </span>
              <span v-if="person.firstSeen" class="font-mono text-slate-300 truncate max-w-[130px]" :title="formatDateTime(person.firstSeen)">
                {{ formatDateTime(person.firstSeen) }}
              </span>
              <span v-else class="text-slate-600 italic">Sin registro</span>
            </div>

            <div class="flex items-center justify-between text-[10px] text-slate-500">
              <span class="flex items-center gap-1">
                <AppIcon name="schedule" :size="13" class="text-amber-500" />
                <span>Salida / Última vez:</span>
              </span>
              <span v-if="person.lastSeen" class="font-mono text-slate-300 truncate max-w-[130px]" :title="formatDateTime(person.lastSeen)">
                {{ formatDateTime(person.lastSeen) }}
              </span>
              <span v-else class="text-slate-600 italic">Sin registro</span>
            </div>
          </div>

          <!-- Botón de Acción: Ver Galería de Fotos -->
          <button
            type="button"
            @click="openPhotosModal(person)"
            class="w-full flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg text-xs font-medium bg-slate-900/90 hover:bg-slate-800 text-sky-300 hover:text-sky-200 border border-slate-800 hover:border-sky-500/40 transition select-none cursor-pointer"
          >
            <AppIcon name="photo_library" :size="14" />
            <span>Ver fotos ({{ person.photos?.length || (person.thumbnailBase64 ? 1 : 0) }})</span>
          </button>

          <!-- Bottom Row: Manual Role Switch Button & Delete -->
          <div class="flex items-center gap-2 pt-1">
            <!-- Botón Principal: Pasar a Barbero o Cambiar a Cliente -->
            <button
              type="button"
              :disabled="updatingId === person.id"
              @click="onToggleRole(person)"
              :class="[
                'flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-bold transition select-none cursor-pointer',
                person.isStaff
                  ? 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 hover:border-slate-600'
                  : 'bg-sky-600/20 hover:bg-sky-600/30 text-sky-300 border border-sky-500/40 hover:border-sky-400'
              ]"
            >
              <AppSpinner v-if="updatingId === person.id" size="xs" />
              <template v-else>
                <AppIcon :name="person.isStaff ? 'person' : 'content_cut'" :size="15" />
                <span>{{ person.isStaff ? 'Cambiar a Cliente' : 'Pasar a Barbero' }}</span>
              </template>
            </button>

            <!-- Botón Eliminar Perfil individual -->
            <button
              type="button"
              :disabled="updatingId === person.id"
              @click="promptDeletePerson(person)"
              class="p-2 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-950/30 border border-transparent hover:border-red-500/30 transition cursor-pointer shrink-0"
              title="Eliminar perfil biométrico"
            >
              <AppIcon name="delete_outline" :size="16" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Barra Flotante de Acciones para Selección Múltiple -->
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="transform translate-y-8 opacity-0"
      enter-to-class="transform translate-y-0 opacity-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="transform translate-y-0 opacity-100"
      leave-to-class="transform translate-y-8 opacity-0"
    >
      <div
        v-if="selectedPersonIds.size >= 1"
        class="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-slate-900/95 backdrop-blur-md border border-sky-500/40 rounded-2xl shadow-2xl px-4 py-3 sm:px-6 sm:py-3.5 flex flex-wrap items-center justify-between gap-3 text-white max-w-2xl w-[calc(100%-2rem)]"
      >
        <div class="flex items-center gap-2.5">
          <span class="p-1.5 rounded-lg bg-sky-950 text-sky-400 border border-sky-500/30 flex items-center justify-center">
            <AppIcon name="checklist" :size="18" />
          </span>
          <span class="text-xs sm:text-sm font-semibold text-slate-100">
            {{ selectedPersonIds.size === 1 ? '1 persona seleccionada' : `${selectedPersonIds.size} personas seleccionadas` }}
          </span>
        </div>

        <div class="flex items-center gap-2 flex-wrap">
          <!-- Botón Fusionar Perfiles (N) -->
          <AppButton
            size="sm"
            variant="primary"
            icon="merge_type"
            :disabled="selectedPersonIds.size < 2"
            :title="selectedPersonIds.size < 2 ? 'Selecciona al menos 2 perfiles para fusionar' : 'Fusionar perfiles seleccionados'"
            @click="openMergeModal"
          >
            <span>Fusionar perfiles ({{ selectedPersonIds.size }})</span>
          </AppButton>

          <!-- Botón Eliminar Perfiles (N) -->
          <AppButton
            size="sm"
            variant="danger"
            icon="delete"
            @click="openBatchDeleteModal"
            title="Eliminar todos los perfiles seleccionados"
          >
            <span>Eliminar perfiles ({{ selectedPersonIds.size }})</span>
          </AppButton>

          <!-- Botón Cancelar Selección -->
          <AppButton
            size="sm"
            variant="secondary"
            icon="close"
            @click="clearSelection"
            title="Cancelar selección actual"
          >
            <span>Cancelar</span>
          </AppButton>
        </div>
      </div>
    </Transition>

    <!-- Modal de Galería e Inspector de Fotos y Ángulos -->
    <ClientPhotosModal
      :show="isPhotosModalOpen"
      :person="selectedPersonForPhotos"
      @close="closePhotosModal"
      @delete-person="handleDeletePersonFromModal"
      @delete-photo="handleDeletePhotoFromModal"
    />

    <!-- ConfirmModal: Eliminar Perfil Individual -->
    <ConfirmModal
      :show="isConfirmDeleteOpen"
      :title="`¿Eliminar perfil de '${personToDelete?.name}'?`"
      :message="`Se eliminará permanentemente el perfil biométrico de '${personToDelete?.name}' (ID: ${personToDelete?.id}) de Firestore, junto con todas sus fotos y registros de visita.`"
      confirm-text="Eliminar perfil"
      confirm-variant="danger"
      confirm-icon="delete"
      icon="person_remove"
      icon-color="text-red-400"
      :loading="isDeletingSingle"
      @confirm="confirmDeletePerson"
      @close="isConfirmDeleteOpen = false"
    />

    <!-- ConfirmModal: Eliminación por Lote -->
    <ConfirmModal
      :show="isConfirmBatchDeleteOpen"
      :title="`¿Eliminar ${selectedPersonIds.size} perfiles seleccionados?`"
      :message="`Se eliminarán permanentemente ${selectedPersonIds.size} perfiles biométricos de Firestore junto con todas sus fotos, vectores y registros de visita. Esta acción no se puede revertir.`"
      confirm-text="Eliminar perfiles"
      confirm-variant="danger"
      confirm-icon="delete"
      icon="delete_sweep"
      icon-color="text-red-400"
      :loading="isBatchDeleting"
      @confirm="confirmBatchDelete"
      @close="isConfirmBatchDeleteOpen = false"
    />

    <!-- ConfirmModal: Fusión de Perfiles Seleccionados -->
    <ConfirmModal
      :show="isMergeModalOpen"
      title="Fusionar perfiles biométricos"
      confirm-text="Confirmar fusión"
      confirm-variant="primary"
      confirm-icon="merge_type"
      icon="merge_type"
      icon-color="text-sky-400"
      max-width="max-w-xl"
      :loading="isMerging"
      @confirm="confirmMerge"
      @close="isMergeModalOpen = false"
    >
      <div v-if="mergePreview" class="space-y-4">
        <p class="text-xs sm:text-sm text-slate-300 leading-relaxed">
          Se combinarán <strong class="text-sky-300">{{ selectedProfiles.length }} perfiles</strong> en uno solo.
          Se conservarán hasta 6 ángulos faciales de mayor nitidez y se unificarán los tiempos de visita y conteo acumulado.
        </p>

        <!-- Selector de Nombre Unificado -->
        <div class="bg-slate-950/60 p-3 rounded-xl border border-slate-800 space-y-2">
          <label class="block text-xs font-semibold text-slate-300">
            Nombre para el perfil unificado:
          </label>
          <input
            v-model="mergeTargetName"
            type="text"
            placeholder="Nombre del perfil resultante..."
            class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-white focus:outline-none focus:border-sky-500"
          />

          <!-- Selector de Perfil Base de Destino -->
          <div class="pt-2 border-t border-slate-800/80">
            <span class="block text-[11px] text-slate-400 mb-1.5">Perfil base que conservará el ID de Firestore:</span>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                v-for="p in selectedProfiles"
                :key="p.id"
                type="button"
                @click="mergeTargetId = p.id; mergeTargetName = p.name || ''"
                :class="[
                  'p-2 rounded-lg border text-left flex items-center gap-2 transition cursor-pointer',
                  mergeTargetId === p.id
                    ? 'bg-sky-950/70 border-sky-500/80 ring-1 ring-sky-500/50'
                    : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
                ]"
              >
                <div class="w-8 h-8 rounded-lg overflow-hidden bg-slate-950 shrink-0 border border-slate-700 flex items-center justify-center text-xs font-bold">
                  <img v-if="p.thumbnailBase64" :src="p.thumbnailBase64" class="w-full h-full object-cover" />
                  <span v-else>{{ (p.name || 'C').charAt(0) }}</span>
                </div>
                <div class="min-w-0 flex-1">
                  <div class="text-xs font-bold text-white truncate">{{ p.name }}</div>
                  <div class="text-[10px] text-slate-500 font-mono truncate">{{ p.id }}</div>
                </div>
                <AppIcon v-if="mergeTargetId === p.id" name="check_circle" :size="16" class="text-sky-400" />
              </button>
            </div>
          </div>
        </div>

        <!-- Métricas Previas de la Fusión -->
        <div class="grid grid-cols-2 gap-2.5 text-xs">
          <!-- Entrada más antigua -->
          <div class="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800">
            <span class="text-[11px] text-slate-400 flex items-center gap-1.5 mb-0.5">
              <AppIcon name="login" :size="14" class="text-emerald-400" />
              <span>Entrada más antigua:</span>
            </span>
            <span class="font-mono text-slate-200 block truncate" :title="formatDateTime(mergePreview.mergedData.firstSeen)">
              {{ mergePreview.mergedData.firstSeen ? formatDateTime(mergePreview.mergedData.firstSeen) : 'Sin registro' }}
            </span>
          </div>

          <!-- Salida más reciente -->
          <div class="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800">
            <span class="text-[11px] text-slate-400 flex items-center gap-1.5 mb-0.5">
              <AppIcon name="schedule" :size="14" class="text-amber-400" />
              <span>Última vez más reciente:</span>
            </span>
            <span class="font-mono text-slate-200 block truncate" :title="formatDateTime(mergePreview.mergedData.lastSeen)">
              {{ mergePreview.mergedData.lastSeen ? formatDateTime(mergePreview.mergedData.lastSeen) : 'Sin registro' }}
            </span>
          </div>

          <!-- Fotos conservadas -->
          <div class="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800">
            <span class="text-[11px] text-slate-400 flex items-center gap-1.5 mb-0.5">
              <AppIcon name="collections" :size="14" class="text-sky-400" />
              <span>Fotos resultantes:</span>
            </span>
            <span class="font-mono text-sky-300 font-bold">
              {{ mergePreview.mergedData.photos.length }} / 6 conservadas
            </span>
          </div>

          <!-- Visitas acumuladas -->
          <div class="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800">
            <span class="text-[11px] text-slate-400 flex items-center gap-1.5 mb-0.5">
              <AppIcon name="visibility" :size="14" class="text-purple-400" />
              <span>Visitas totales:</span>
            </span>
            <span class="font-mono text-purple-300 font-bold">
              {{ mergePreview.mergedData.visitCount }} visitas
            </span>
          </div>
        </div>

        <p class="text-[11px] text-amber-400/90 flex items-center gap-1.5">
          <AppIcon name="warning" :size="15" />
          <span>Los perfiles secundarios serán eliminados de forma permanente de la base de datos tras la fusión.</span>
        </p>
      </div>
    </ConfirmModal>
  </section>
</template>
