import { ref } from 'vue';
import { boxNormToPolygonNorm, polygonNormToBoundingBoxNorm } from '@/shared/lib/geometry';

export function useCalibratorTools(quadrantsRef) {
  const currentMode = ref('move'); // 'move' | 'draw'
  const isDragging = ref(false);
  const dragTarget = ref(null); // { idx, handle: 'body' | 'nw' | 'ne' | 'se' | 'sw' }
  const dragStartPos = ref({ x: 0, y: 0 });
  const startBox = ref([0, 0, 0, 0]);

  // Drawing state
  const isDrawing = ref(false);
  const drawStartPos = ref({ x: 0, y: 0 });
  const drawCurrentBox = ref(null); // [ymin, xmin, ymax, xmax]

  const setMode = (mode) => {
    currentMode.value = mode;
  };

  const startDrag = (idx, handle, clientX, clientY, stageRect) => {
    if (currentMode.value !== 'move') return;
    const q = quadrantsRef.value[idx];
    if (!q) return;

    isDragging.value = true;
    dragTarget.value = { idx, handle };
    dragStartPos.value = { x: clientX, y: clientY };
    startBox.value = [...q.boxNorm];
  };

  const updateDrag = (clientX, clientY, stageWidth, stageHeight) => {
    if (!isDragging.value || !dragTarget.value) return;
    const { idx, handle } = dragTarget.value;
    const q = quadrantsRef.value[idx];
    if (!q) return;

    const deltaXNorm = ((clientX - dragStartPos.value.x) / stageWidth) * 1000;
    const deltaYNorm = ((clientY - dragStartPos.value.y) / stageHeight) * 1000;

    let [ymin, xmin, ymax, xmax] = startBox.value;

    if (handle === 'body') {
      const boxW = xmax - xmin;
      const boxH = ymax - ymin;
      xmin = Math.max(0, Math.min(1000 - boxW, xmin + deltaXNorm));
      ymin = Math.max(0, Math.min(1000 - boxH, ymin + deltaYNorm));
      xmax = xmin + boxW;
      ymax = ymin + boxH;
    } else if (handle === 'nw') {
      ymin = Math.max(0, Math.min(ymax - 30, ymin + deltaYNorm));
      xmin = Math.max(0, Math.min(xmax - 30, xmin + deltaXNorm));
    } else if (handle === 'ne') {
      ymin = Math.max(0, Math.min(ymax - 30, ymin + deltaYNorm));
      xmax = Math.max(xmin + 30, Math.min(1000, xmax + deltaXNorm));
    } else if (handle === 'se') {
      ymax = Math.max(ymin + 30, Math.min(1000, ymax + deltaYNorm));
      xmax = Math.max(xmin + 30, Math.min(1000, xmax + deltaXNorm));
    } else if (handle === 'sw') {
      ymax = Math.max(ymin + 30, Math.min(1000, ymax + deltaYNorm));
      xmin = Math.max(0, Math.min(xmax - 30, xmin + deltaXNorm));
    }

    const newBox = [Math.round(ymin), Math.round(xmin), Math.round(ymax), Math.round(xmax)];
    q.boxNorm = newBox;
    q.polygonNorm = boxNormToPolygonNorm(newBox);
  };

  const endDrag = () => {
    isDragging.value = false;
    dragTarget.value = null;
  };

  const startDrawing = (normX, normY) => {
    if (currentMode.value !== 'draw') return;
    isDrawing.value = true;
    drawStartPos.value = { x: normX, y: normY };
    drawCurrentBox.value = [normY, normX, normY, normX];
  };

  const updateDrawing = (normX, normY) => {
    if (!isDrawing.value) return;
    const ymin = Math.round(Math.min(drawStartPos.value.y, normY));
    const xmin = Math.round(Math.min(drawStartPos.value.x, normX));
    const ymax = Math.round(Math.max(drawStartPos.value.y, normY));
    const xmax = Math.round(Math.max(drawStartPos.value.x, normX));
    drawCurrentBox.value = [ymin, xmin, ymax, xmax];
  };

  const finishDrawing = () => {
    if (!isDrawing.value || !drawCurrentBox.value) {
      isDrawing.value = false;
      drawCurrentBox.value = null;
      return null;
    }

    const [ymin, xmin, ymax, xmax] = drawCurrentBox.value;
    isDrawing.value = false;
    drawCurrentBox.value = null;

    if (xmax - xmin < 20 || ymax - ymin < 20) {
      return null; // Demasiado pequeño
    }

    return [ymin, xmin, ymax, xmax];
  };

  return {
    currentMode,
    isDragging,
    isDrawing,
    drawCurrentBox,
    setMode,
    startDrag,
    updateDrag,
    endDrag,
    startDrawing,
    updateDrawing,
    finishDrawing
  };
}
