/** @returns {number} */
export function nowMs() {
  return Date.now();
}

/** @param {number} startMs */
export function elapsedMs(startMs) {
  return Date.now() - startMs;
}

/**
 * @param {Record<string, number|string|undefined>} timings
 */
export function logTimings(label, timings) {
  const parts = Object.entries(timings)
    .filter(([, ms]) => ms != null && ms !== '')
    .map(([key, ms]) => `${key}=${ms}${typeof ms === 'number' ? 'ms' : ''}`);
  console.log(`[timing] ${label}: ${parts.join(' · ')}`);
}
