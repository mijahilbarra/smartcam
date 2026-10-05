/**
 * Format timestamp into local Spanish readable format (America/Lima)
 */
export function formatDateTime(timestampOrIso, epoch) {
  let date;
  if (epoch) {
    date = new Date(epoch);
  } else if (timestampOrIso?.toDate) {
    date = timestampOrIso.toDate();
  } else if (typeof timestampOrIso === "string") {
    date = new Date(timestampOrIso);
  } else if (timestampOrIso instanceof Date) {
    date = timestampOrIso;
  } else {
    date = new Date();
  }

  return new Intl.DateTimeFormat("es-PE", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "America/Lima"
  }).format(date);
}

/**
 * Checks if a given time is within working hours in America/Lima
 */
export function checkIsWithinWorkingHours(startStr = "11:00", endStr = "23:00", nowInput = null) {
  const now = nowInput || new Date();
  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Lima",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  });

  const parts = timeFormatter.formatToParts(now);
  const hour = parseInt(parts.find(p => p.type === "hour")?.value || "0", 10);
  const min = parseInt(parts.find(p => p.type === "minute")?.value || "0", 10);
  const currentTotalMin = hour * 60 + min;

  const parseMinutes = (str) => {
    if (!str) return 0;
    const [h, m] = str.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };

  const startTotalMin = parseMinutes(startStr);
  const endTotalMin = parseMinutes(endStr);

  let isWithin = false;
  if (startTotalMin <= endTotalMin) {
    isWithin = currentTotalMin >= startTotalMin && currentTotalMin < endTotalMin;
  } else {
    // Overnight window (e.g. 20:00 to 04:00)
    isWithin = currentTotalMin >= startTotalMin || currentTotalMin < endTotalMin;
  }

  return {
    isWithin,
    currentFormatted: `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`,
    windowFormatted: `${startStr} - ${endStr}`
  };
}
