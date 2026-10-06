import { ref, onMounted, onUnmounted } from 'vue';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '@/shared/api/firebase';
import { normalizeQuadrants, serializeQuadrantsForFirestore, boxNormToPolygonNorm } from '@/shared/lib/geometry';

export const DEFAULT_QUADRANTS = [];

export function useQuadrants() {
  const quadrants = ref([]);
  const loading = ref(true);
  const saving = ref(false);
  const selectedIndex = ref(0);

  let unsubscribe = null;

  const subscribe = () => {
    loading.value = true;
    const docRef = doc(db, 'camera_catcher', 'quadrants');
    unsubscribe = onSnapshot(docRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        let quadsRaw = [];
        if (Array.isArray(data?.quadrants)) {
          quadsRaw = data.quadrants;
        } else if (data?.quadrants && typeof data.quadrants === 'object') {
          quadsRaw = Object.values(data.quadrants);
        } else if (Array.isArray(data?.zones)) {
          quadsRaw = data.zones;
        }

        // Single Source of Truth: Usar exclusivamente los cuadrantes guardados por el usuario
        quadrants.value = normalizeQuadrants(quadsRaw);
      } else {
        // Si el documento NO existe en Firestore, iniciar vacío para calibración inicial
        quadrants.value = [];
      }
      loading.value = false;
    }, (err) => {
      console.warn('[Quadrants] Error cargando cuadrantes:', err);
      loading.value = false;
    });
  };

  const saveToFirebase = async () => {
    saving.value = true;
    try {
      const serialized = serializeQuadrantsForFirestore(quadrants.value);
      const docRef = doc(db, 'camera_catcher', 'quadrants');
      await setDoc(docRef, {
        quadrants: serialized,
        updatedAt: new Date().toISOString(),
        updatedBy: 'web-dashboard'
      }, { merge: true });
      saving.value = false;
      return { success: true };
    } catch (err) {
      console.error('[Quadrants] Error guardando cuadrantes en Firestore:', err);
      saving.value = false;
      return { success: false, error: err.message };
    }
  };

  const addQuadrant = (type = 'barber_chair') => {
    const nextIdx = quadrants.value.length + 1;
    const newBox = [0.25, 0.25, 0.65, 0.65];
    const defaultColors = {
      barber_chair: '#FFD700',
      waiting_chair: '#D250DC',
      barber_workstation: '#FF4500',
      walking_zone: '#007BFF',
      custom_zone: '#10B981'
    };
    const newQ = {
      id: `zone_${Date.now()}`,
      name: `Zona ${nextIdx}`,
      badge: `Z${nextIdx}`,
      color: defaultColors[type] || '#FFD700',
      type: type,
      polygonNorm: boxNormToPolygonNorm(newBox),
      boxNorm: newBox
    };
    quadrants.value.push(newQ);
    selectedIndex.value = quadrants.value.length - 1;
  };

  const deleteQuadrant = (idx) => {
    if (idx >= 0 && idx < quadrants.value.length) {
      quadrants.value.splice(idx, 1);
      if (quadrants.value.length === 0) {
        selectedIndex.value = -1;
      } else if (selectedIndex.value >= quadrants.value.length) {
        selectedIndex.value = Math.max(0, quadrants.value.length - 1);
      }
    }
  };

  const resetToDefaults = () => {
    quadrants.value = [];
    selectedIndex.value = -1;
  };

  onMounted(() => {
    subscribe();
  });

  onUnmounted(() => {
    if (unsubscribe) unsubscribe();
  });

  return {
    quadrants,
    loading,
    saving,
    selectedIndex,
    addQuadrant,
    deleteQuadrant,
    resetToDefaults,
    saveToFirebase
  };
}
