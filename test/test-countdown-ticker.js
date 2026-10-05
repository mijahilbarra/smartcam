import assert from "node:assert";

console.log("=== Test de Resiliencia del Contador / Countdown Ticker ===");

// 1. Simulación de la lógica de extracción de useDaemonState.js
function extractCountdownState(data, isConnectedFallback = false) {
  const rawInterval = data?.countdown?.intervalMinutes || data?.intervalMinutes;
  const intervalMinutes = (!isNaN(Number(rawInterval)) && Number(rawInterval) > 0) ? Number(rawInterval) : 3;
  const nextCaptureAtIso = data?.countdown?.nextCaptureAt || data?.nextCaptureAtIso || data?.nextCaptureAt || null;

  const lastIso = data?.updatedAt || data?.timestamp || data?.countdown?.timestamp;
  let isConnected = false;
  if (lastIso) {
    const ageMs = Date.now() - new Date(lastIso).getTime();
    const maxStaleMs = (intervalMinutes * 2) * 60 * 1000;
    isConnected = ageMs < maxStaleMs;
  } else {
    isConnected = isConnectedFallback;
  }

  let targetNextIso = nextCaptureAtIso;
  if (!targetNextIso && isConnected) {
    const baseTime = lastIso ? new Date(lastIso).getTime() : Date.now();
    const estTime = baseTime + intervalMinutes * 60 * 1000;
    targetNextIso = new Date(estTime > Date.now() ? estTime : Date.now() + intervalMinutes * 60 * 1000).toISOString();
  }

  return {
    intervalMinutes,
    nextCaptureAtIso: targetNextIso,
    isConnected
  };
}

function formatCountdown(targetIso, nowMs = Date.now()) {
  if (!targetIso) return "--:--";
  const targetTime = new Date(targetIso).getTime();
  if (isNaN(targetTime)) return "--:--";

  const diffMs = targetTime - nowMs;
  const secLeft = Math.max(0, Math.floor(diffMs / 1000));
  const m = Math.floor(secLeft / 60);
  const s = secLeft % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// Case A: Daemon con estructura anidada (countdown.nextCaptureAt & countdown.intervalMinutes)
const now = Date.now();
const targetA = new Date(now + 125 * 1000).toISOString(); // 2m 5s
const stateA = extractCountdownState({
  updatedAt: new Date(now - 5000).toISOString(),
  countdown: {
    nextCaptureAt: targetA,
    intervalMinutes: 5
  }
});
assert.strictEqual(stateA.intervalMinutes, 5);
assert.strictEqual(stateA.nextCaptureAtIso, targetA);
assert.strictEqual(formatCountdown(stateA.nextCaptureAtIso, now), "02:05");
console.log("✓ Caso A (estructura anidada countdown.*) resuelto con éxito:", formatCountdown(stateA.nextCaptureAtIso, now));

// Case B: Daemon con campos aplanados (nextCaptureAtIso & intervalMinutes)
const targetB = new Date(now + 65 * 1000).toISOString(); // 1m 5s
const stateB = extractCountdownState({
  updatedAt: new Date(now - 2000).toISOString(),
  nextCaptureAtIso: targetB,
  intervalMinutes: 10
});
assert.strictEqual(stateB.intervalMinutes, 10);
assert.strictEqual(stateB.nextCaptureAtIso, targetB);
assert.strictEqual(formatCountdown(stateB.nextCaptureAtIso, now), "01:05");
console.log("✓ Caso B (campos aplanados nextCaptureAtIso) resuelto con éxito:", formatCountdown(stateB.nextCaptureAtIso, now));

// Case C: Daemon activo recientemente pero sin nextCaptureAt explícito (debe estimar y nunca quedarse en --:--)
const stateC = extractCountdownState({
  updatedAt: new Date(now - 10000).toISOString(), // 10 seg atrás
  intervalMinutes: 3
});
assert.strictEqual(stateC.isConnected, true);
assert.ok(stateC.nextCaptureAtIso !== null, "Debe haber generado targetNextIso estimado");
const formattedC = formatCountdown(stateC.nextCaptureAtIso, now);
assert.notStrictEqual(formattedC, "--:--");
console.log("✓ Caso C (activo sin fecha explícita => estimado resiliente):", formattedC);

// Case D: Daemon desconectado y sin fecha => reloj muestra --:--
const stateD = extractCountdownState({
  updatedAt: new Date(now - 3600 * 1000).toISOString(), // 1 hora atrás (desconectado)
  intervalMinutes: 3
});
assert.strictEqual(stateD.isConnected, false);
assert.strictEqual(stateD.nextCaptureAtIso, null);
assert.strictEqual(formatCountdown(stateD.nextCaptureAtIso, now), "--:--");
console.log("✓ Caso D (desconectado sin fecha => muestra --:--):", formatCountdown(stateD.nextCaptureAtIso, now));

console.log("\n🎉 ¡Todos los tests de resiliencia del countdown pasaron exitosamente!");
