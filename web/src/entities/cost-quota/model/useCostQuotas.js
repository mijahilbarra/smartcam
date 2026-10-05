import { computed } from 'vue';

export function useCostQuotas(totalPhotosCount = 0, intervalMinutes = 15) {
  // 1. Cloud Storage calculations
  const photoSizeMb = 1.5;
  const storageLimitGb = 5.0;
  const storageLimitMb = storageLimitGb * 1024;
  const currentStorageUsedMb = computed(() => {
    return Math.max(144, Math.round(totalPhotosCount * photoSizeMb * 10) / 10);
  });
  const currentStorageProgressPercent = computed(() => {
    return Math.min(100, (currentStorageUsedMb.value / storageLimitMb) * 100);
  });

  // Daily growth calculation
  const capturesPerDay = computed(() => {
    const minutesInDay = 24 * 60;
    return Math.round(minutesInDay / Math.max(intervalMinutes, 0.1));
  });

  const dailyGrowthMb = computed(() => {
    return Math.round(capturesPerDay.value * photoSizeMb * 10) / 10;
  });

  const daysToLimit = computed(() => {
    const remainingMb = storageLimitMb - currentStorageUsedMb.value;
    if (dailyGrowthMb.value <= 0) return 999;
    return Math.max(1, Math.round(remainingMb / dailyGrowthMb.value));
  });

  // 2. Firestore calculations
  const firestoreDailyLimit = 20000;
  const firestoreEstimatedWrites = computed(() => capturesPerDay.value);
  const firestoreProgressPercent = computed(() => {
    return Math.min(100, (firestoreEstimatedWrites.value / firestoreDailyLimit) * 100);
  });

  // 3. Gemini Vision calculations
  const geminiDailyLimit = 1500;
  const geminiEstimatedCalls = computed(() => capturesPerDay.value);
  const geminiProgressPercent = computed(() => {
    return Math.min(100, (geminiEstimatedCalls.value / geminiDailyLimit) * 100);
  });

  // 4. Simulator calculations
  const simulateInterval = (min) => {
    const capsDay = Math.round((24 * 60) / Math.max(min, 0.1));
    const capsMonth = capsDay * 30;
    const storageMonthGb = Math.round((capsMonth * photoSizeMb / 1024) * 10) / 10;
    const storageOpsClassA = capsMonth * 2;
    const firestoreWrites = capsDay;
    const geminiCalls = capsDay;

    let alertType = 'info';
    let alertMsg = 'Con este intervalo te mantienes dentro del Free Tier ($0.00).';

    if (min < 2) {
      alertType = 'warning';
      alertMsg = `⚠️ Advertencia: Un intervalo de ${min * 60}s continuo generará ~${storageMonthGb} GB al mes, excediendo los 5 GB de Storage. Se recomienda solo para pruebas breves.`;
    } else if (storageMonthGb > 5) {
      alertType = 'info';
      alertMsg = `💡 Recomendación: Generarás ~${storageMonthGb} GB/mes. Configura una regla de ciclo de vida (eliminación a los 30 días) para mantenerte en $0.00.`;
    }

    return {
      capsDay,
      capsMonth,
      storageMonthGb,
      storageOpsClassA,
      firestoreWrites,
      geminiCalls,
      alertType,
      alertMsg
    };
  };

  return {
    currentStorageUsedMb,
    currentStorageProgressPercent,
    dailyGrowthMb,
    daysToLimit,
    firestoreDailyLimit,
    firestoreEstimatedWrites,
    firestoreProgressPercent,
    geminiDailyLimit,
    geminiEstimatedCalls,
    geminiProgressPercent,
    simulateInterval
  };
}
