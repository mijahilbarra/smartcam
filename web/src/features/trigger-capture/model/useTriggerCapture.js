import { ref } from 'vue';
import { doc, setDoc } from 'firebase/firestore';
import { db, BACKEND_URL, IS_LOCAL_ENV, getEnvironmentInfo } from '@/shared/api/firebase';

export function useTriggerCapture() {
  const isTriggering = ref(false);
  const statusMessage = ref('');
  const statusType = ref('info');
  const envInfo = getEnvironmentInfo();

  const triggerCapture = async (addLogCallback = null) => {
    isTriggering.value = true;
    statusMessage.value = 'Iniciando captura inmediata...';
    statusType.value = 'info';

    const timestampNow = Date.now();

    if (addLogCallback) {
      addLogCallback({
        title: '⚡ Disparo de Captura Solicitado',
        desc: `Entorno: ${envInfo.environmentLabel}. Destino: ${envInfo.dispatchTarget}`,
        type: 'action'
      });
    }

    try {
      let dispatchedViaHttp = false;

      // 1. Si estamos en ENTORNO LOCAL y existe BACKEND_URL, intentar HTTP directo al simulador E2 / daemon
      if (IS_LOCAL_ENV && BACKEND_URL) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 2500);

          const res = await fetch(`${BACKEND_URL}/capture`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: 'dashboard_local_button', timestamp: new Date().toISOString() }),
            signal: controller.signal
          });
          clearTimeout(timeoutId);

          if (res.ok) {
            dispatchedViaHttp = true;
            statusMessage.value = '¡Captura procesada por el daemon/simulador local (HTTP)!';
            statusType.value = 'success';
          }
        } catch (httpErr) {
          console.warn('[TriggerCapture] Daemon local (8085) no conectado. Enviando a Firestore:', httpErr.message);
        }
      }

      // 2. Si estamos en SERVIDOR CLOUD (o si falló HTTP local), enviar por el Bus de Eventos de Firestore
      if (!dispatchedViaHttp) {
        const cmdRef = doc(db, 'camera_catcher', 'commands');
        await setDoc(cmdRef, {
          action: 'capture',
          source: IS_LOCAL_ENV ? 'dashboard-local-fallback' : 'dashboard-web-cloud',
          requestedAt: timestampNow
        }, { merge: true });

        if (IS_LOCAL_ENV) {
          statusMessage.value = 'Comando enviado a Firestore [test]. Si el simulador local no está activo, ejecuta "npm run sim:e2" en tu terminal.';
          statusType.value = 'warning';
        } else {
          statusMessage.value = 'Comando enviado a GCP Compute Engine (Firestore Event Bus)';
          statusType.value = 'success';
        }
      }

      if (addLogCallback) {
        addLogCallback({
          title: dispatchedViaHttp ? '✓ Ciclo activado (HTTP)' : '✓ Ciclo enviado a Firestore',
          desc: dispatchedViaHttp
            ? 'Orden ejecutada vía HTTP directo (Simulador E2 localhost:8085).'
            : `Orden enviada vía Firestore [${envInfo.databaseId}].`,
          type: dispatchedViaHttp ? 'success' : (IS_LOCAL_ENV ? 'warning' : 'success')
        });
      }
    } catch (err) {
      console.error('[TriggerCapture] Error disparando ciclo:', err);
      statusMessage.value = `Error: ${err.message}`;
      statusType.value = 'error';
    } finally {
      setTimeout(() => {
        isTriggering.value = false;
      }, 1000);
    }
  };

  return {
    isTriggering,
    statusMessage,
    statusType,
    envInfo,
    triggerCapture
  };
}
