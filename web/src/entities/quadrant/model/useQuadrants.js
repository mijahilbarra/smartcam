import { ref, onMounted, onUnmounted } from 'vue';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '@/shared/api/firebase';
import { normalizeQuadrants, serializeQuadrantsForFirestore, boxNormToPolygonNorm } from '@/shared/lib/geometry';

export const DEFAULT_QUADRANTS = [
  { id: 'quad_1', name: 'Sillón 1 (Izquierda)', badge: 'Sillón 1', color: '#3b82f6', boxNorm: [250, 100, 850, 400] },
  { id: 'quad_2', name: 'Sillón 2 (Centro)', badge: 'Sillón 2', color: '#10b981', boxNorm: [250, 380, 850, 680] },
  { id: 'quad_3', name: 'Sillón 3 (Derecha)', badge: 'Sillón 3', color: '#f59e0b', boxNorm: [250, 660, 850, 950] },
  { id: 'quad_4', name: 'Sofá de Espera', badge: 'Espera', color: '#a855f7', boxNorm: [350, 10, 750, 220] }
];

export function useQuadrants() {
  const quadrants = ref(normalizeQuadrants(DEFAULT_QUADRANTS));
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
        const rawList = data.zones || data.quadrants || data.items || [];
        if (Array.isArray(rawList) && rawList.length > 0) {
          quadrants.value = normalizeQuadrants(rawList);
        } else {
          quadrants.value = normalizeQuadrants(DEFAULT_QUADRANTS);
        }
      } else {
        quadrants.value = normalizeQuadrants(DEFAULT_QUADRANTS);
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
        zones: serialized,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      saving.value = false;
      return { success: true };
    } catch (err) {
      console.error('[Quadrants] Error guardando cuadrantes en Firestore:', err);
      saving.value = false;
      return { success: false, error: err.message };
    }
  };

  const addQuadrant = () => {
    const nextIdx = quadrants.value.length + 1;
    const newQ = {
      id: `quad_${Date.now()}`,
      name: `Zona ${nextIdx}`,
      badge: `Z${nextIdx}`,
      color: '#06b6d4',
      polygonNorm: boxNormToPolygonNorm([200, 200, 600, 600]),
      boxNorm: [200, 200, 600, 600]
    };
    quadrants.value.push(newQ);
    selectedIndex.value = quadrants.value.length - 1;
  };

  const deleteQuadrant = (idx) => {
    if (idx >= 0 && idx < quadrants.value.length) {
      quadrants.value.splice(idx, 1);
      if (selectedIndex.value >= quadrants.value.length) {
        selectedIndex.value = Math.max(0, quadrants.value.length - 1);
      }
    }
  };

  const resetToDefaults = () => {
    quadrants.value = normalizeQuadrants(DEFAULT_QUADRANTS);
    selectedIndex.value = 0;
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
