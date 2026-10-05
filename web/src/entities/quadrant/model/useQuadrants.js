import { ref, onMounted, onUnmounted } from 'vue';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '@/shared/api/firebase';
import { normalizeQuadrants, serializeQuadrantsForFirestore, boxNormToPolygonNorm } from '@/shared/lib/geometry';

export const DEFAULT_QUADRANTS = [
  { id: 'silla_barbero_puesto1', name: 'Silla de barbero (Puesto 1)', badge: 'Sillón 1', color: '#FFD700', boxNorm: [0.65, 0.80, 1.00, 1.00] },
  { id: 'silla_barbero_puesto2', name: 'Silla de barbero (Frente)', badge: 'Sillón 2', color: '#007BFF', boxNorm: [0.80, 0.36, 1.00, 0.67] },
  { id: 'silla_espera', name: 'Silla de espera', badge: 'Espera', color: '#D250DC', boxNorm: [0.55, 0.73, 0.92, 0.90] },
  { id: 'zona_barbero', name: 'Zona de trabajo de barbero', badge: 'Barbero', color: '#FF4500', boxNorm: [0.45, 0.65, 0.95, 0.82] },
  { id: 'puerta_entrada', name: 'Entrada / Pasillo peatonal', badge: 'Entrada', color: '#10b981', boxNorm: [0.30, 0.40, 0.88, 0.60] }
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
        let quadsRaw = [];
        if (Array.isArray(data?.quadrants) && data.quadrants.length > 0) {
          quadsRaw = data.quadrants;
        } else if (data?.quadrants && typeof data.quadrants === 'object') {
          quadsRaw = Object.values(data.quadrants);
        } else if (Array.isArray(data?.zones) && data.zones.length > 0) {
          quadsRaw = data.zones;
        }

        if (quadsRaw.length > 0) {
          quadrants.value = normalizeQuadrants(quadsRaw);
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

  const addQuadrant = () => {
    const nextIdx = quadrants.value.length + 1;
    const newBox = [0.25, 0.25, 0.65, 0.65];
    const newQ = {
      id: `quad_${Date.now()}`,
      name: `Zona ${nextIdx}`,
      badge: `Z${nextIdx}`,
      color: '#06b6d4',
      type: 'custom_zone',
      polygonNorm: boxNormToPolygonNorm(newBox),
      boxNorm: newBox
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
