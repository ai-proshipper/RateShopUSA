/**
 * Stallion weekly window: Mon 05:00–11:30 America/Toronto.
 * When that Monday is an Ontario long-weekend holiday, the window moves to Tuesday.
 */

export const STALLION_TZ = 'America/Toronto';
export const STALLION_WINDOW_START_MINUTES = 5 * 60; // 05:00
export const STALLION_WINDOW_END_MINUTES = 11 * 60 + 30; // 11:30 (exclusive)

/**
 * @param {Date} [now]
 * @returns {{ year: number, month: number, day: number, weekday: string, hour: number, minute: number, minutesOfDay: number, ymd: string }}
 */
export function torontoParts(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: STALLION_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return {
    year,
    month,
    day,
    weekday: String(parts.weekday || ''),
    hour,
    minute,
    minutesOfDay: hour * 60 + minute,
    ymd: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

/** @param {number} year @param {number} month 1-12 @param {number} day */
export function ymdKey(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Weekday for a civil Y-M-D in America/Toronto (0=Sun … 6=Sat). */
export function torontoWeekday(year, month, day) {
  // Noon UTC is always the same civil date in Toronto for these calendar purposes.
  const probe = new Date(Date.UTC(year, month - 1, day, 17, 0, 0));
  const wd = torontoParts(probe).weekday;
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd] ?? -1;
}

/** nth Monday of month (n starts at 1). */
export function nthMonday(year, month, n) {
  const firstWd = torontoWeekday(year, month, 1);
  const firstMonday = 1 + ((1 - firstWd + 7) % 7);
  const day = firstMonday + (n - 1) * 7;
  return ymdKey(year, month, day);
}

/** Monday on or before May 24 (Victoria Day). */
export function victoriaDayMonday(year) {
  const wd = torontoWeekday(year, 5, 24);
  const day = 24 - ((wd + 6) % 7);
  return ymdKey(year, 5, day);
}

/**
 * If holiday falls on Sat/Sun, Ontario-style Monday observance.
 * If it falls on Monday, that Monday. Otherwise no Monday key.
 */
export function mondayObservance(year, month, day) {
  const wd = torontoWeekday(year, month, day);
  if (wd === 1) return ymdKey(year, month, day);
  if (wd === 0) {
    // Sunday → Monday
    const d = new Date(Date.UTC(year, month - 1, day + 1));
    return ymdKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  if (wd === 6) {
    // Saturday → Monday
    const d = new Date(Date.UTC(year, month - 1, day + 2));
    return ymdKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  return null;
}

/**
 * Ontario Monday holidays that create a long weekend (warehouse closed Monday).
 * @param {number} year
 * @returns {Set<string>} YYYY-MM-DD keys
 */
export function ontarioHolidayMondays(year) {
  const set = new Set();
  const add = (key) => {
    if (key) set.add(key);
  };

  add(mondayObservance(year, 1, 1)); // New Year's
  add(nthMonday(year, 2, 3)); // Family Day
  add(victoriaDayMonday(year)); // Victoria Day
  add(mondayObservance(year, 7, 1)); // Canada Day
  add(nthMonday(year, 8, 1)); // Civic Holiday (Ontario)
  add(nthMonday(year, 9, 1)); // Labour Day
  add(nthMonday(year, 10, 2)); // Thanksgiving
  add(mondayObservance(year, 12, 25)); // Christmas
  add(mondayObservance(year, 12, 26)); // Boxing Day

  return set;
}

export function isOntarioHolidayMonday(ymd) {
  const year = Number(String(ymd).slice(0, 4));
  if (!Number.isFinite(year)) return false;
  return ontarioHolidayMondays(year).has(ymd);
}

/**
 * Monday of the Toronto week containing `parts`, as YYYY-MM-DD.
 * @param {{ year: number, month: number, day: number, weekday: string }} parts
 */
export function mondayOfTorontoWeek(parts) {
  const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const wd = wdMap[parts.weekday];
  if (wd == null) return parts.ymd;
  const offset = wd === 0 ? -6 : 1 - wd;
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offset));
  return ymdKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * Civil date when Stallion should run this week (Monday, or Tuesday if Monday is a holiday).
 * @param {{ year: number, month: number, day: number, weekday: string, ymd: string }} parts
 */
export function stallionActiveYmd(parts) {
  const monday = mondayOfTorontoWeek(parts);
  if (isOntarioHolidayMonday(monday)) {
    const [y, m, d] = monday.split('-').map(Number);
    const tue = new Date(Date.UTC(y, m - 1, d + 1));
    return ymdKey(tue.getUTCFullYear(), tue.getUTCMonth() + 1, tue.getUTCDate());
  }
  return monday;
}

/**
 * One-shot override: STALLION_TEST_WINDOW_START / STALLION_TEST_WINDOW_END
 * (ISO timestamps). When set, Stallion is also on in that half-open interval.
 * @param {Date} [now]
 */
export function isStallionTestWindow(now = new Date()) {
  const startRaw = process.env.STALLION_TEST_WINDOW_START?.trim();
  const endRaw = process.env.STALLION_TEST_WINDOW_END?.trim();
  if (!startRaw || !endRaw) return false;
  const start = Date.parse(startRaw);
  const end = Date.parse(endRaw);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
  const t = now.getTime();
  return t >= start && t < end;
}

/**
 * True during Mon 05:00–11:30 America/Toronto (Tue after holiday Monday),
 * or inside an optional one-shot STALLION_TEST_WINDOW_* override.
 * @param {Date} [now]
 */
export function isStallionScheduleWindow(now = new Date()) {
  if (isStallionTestWindow(now)) return true;
  const parts = torontoParts(now);
  if (parts.ymd !== stallionActiveYmd(parts)) return false;
  return (
    parts.minutesOfDay >= STALLION_WINDOW_START_MINUTES &&
    parts.minutesOfDay < STALLION_WINDOW_END_MINUTES
  );
}
