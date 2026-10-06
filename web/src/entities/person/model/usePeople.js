import { ref, computed, onMounted, onUnmounted } from 'vue';
import { collection, doc, onSnapshot, updateDoc, deleteDoc } from 'firebase/firestore';
import { db } from '@/shared/api/firebase';

export function usePeople() {
  const people = ref([]);
  const loading = ref(true);
  const error = ref(null);

  let unsubscribe = null;

  const subscribe = () => {
    loading.value = true;
    error.value = null;

    // Colección oficial de perfiles biométricos de personas detectadas
    const colRef = collection(db, 'camera_catcher_people');
    unsubscribe = onSnapshot(colRef, (snap) => {
      const list = [];
      snap.forEach((docSnap) => {
        const data = docSnap.data();
        list.push({
          id: docSnap.id,
          name: data.name || 'Cliente sin nombre',
          isStaff: Boolean(data.isStaff),
          role: data.role || (data.isStaff ? 'barber' : 'client'),
          visitCount: data.visitCount ?? data.visitsCount ?? 1,
          bestFaceScore: data.bestFaceScore ?? 0,
          thumbnailBase64: data.thumbnailBase64 || null,
          thumbnailPath: data.thumbnailPath || data.lastThumbnailPath || null,
          firstSeen: data.firstSeen || null,
          lastSeen: data.lastSeen || null
        });
      });

      // Ordenar: Staff/Barberos primero, luego por cantidad de visitas desc, luego por última presencia
      list.sort((a, b) => {
        if (a.isStaff !== b.isStaff) {
          return a.isStaff ? -1 : 1;
        }
        if (b.visitCount !== a.visitCount) {
          return b.visitCount - a.visitCount;
        }
        const timeA = a.lastSeen ? new Date(a.lastSeen).getTime() : 0;
        const timeB = b.lastSeen ? new Date(b.lastSeen).getTime() : 0;
        return timeB - timeA;
      });

      people.value = list;
      loading.value = false;
    }, (err) => {
      console.warn('[People] Error cargando directorio de personas:', err);
      error.value = err.message;
      loading.value = false;
    });
  };

  /**
   * Cambia el rol de una persona entre Cliente y Barbero (Staff)
   * Al pasar a Barbero (isStaff: true), el modelo YOLO y el tracker lo reconocen automáticamente como Staff.
   */
  const toggleRole = async (person) => {
    if (!person || !person.id) return;
    const newIsStaff = !person.isStaff;
    const newRole = newIsStaff ? 'barber' : 'client';

    try {
      const docRef = doc(db, 'camera_catcher_people', person.id);
      await updateDoc(docRef, {
        isStaff: newIsStaff,
        role: newRole,
        updatedAt: new Date().toISOString()
      });
      return { success: true, isStaff: newIsStaff, role: newRole };
    } catch (err) {
      console.error('[People] Error alternando rol de persona:', err);
      throw err;
    }
  };

  /**
   * Actualiza el nombre personalizado de una persona
   */
  const updatePersonName = async (personId, newName) => {
    if (!personId || !newName?.trim()) return;
    try {
      const docRef = doc(db, 'camera_catcher_people', personId);
      await updateDoc(docRef, {
        name: newName.trim(),
        updatedAt: new Date().toISOString()
      });
      return { success: true };
    } catch (err) {
      console.error('[People] Error actualizando nombre:', err);
      throw err;
    }
  };

  /**
   * Elimina un perfil biométrico no deseado
   */
  const deletePerson = async (personId) => {
    if (!personId) return;
    try {
      const docRef = doc(db, 'camera_catcher_people', personId);
      await deleteDoc(docRef);
      return { success: true };
    } catch (err) {
      console.error('[People] Error eliminando persona:', err);
      throw err;
    }
  };

  const barbersCount = computed(() => people.value.filter(p => p.isStaff).length);
  const frequentCount = computed(() => people.value.filter(p => !p.isStaff && p.visitCount > 1).length);
  const newClientsCount = computed(() => people.value.filter(p => !p.isStaff && p.visitCount <= 1).length);

  onMounted(() => {
    subscribe();
  });

  onUnmounted(() => {
    if (unsubscribe) unsubscribe();
  });

  return {
    people,
    loading,
    error,
    barbersCount,
    frequentCount,
    newClientsCount,
    toggleRole,
    updatePersonName,
    deletePerson
  };
}
