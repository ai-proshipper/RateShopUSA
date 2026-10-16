/**
 * Stallion weekly schedule: Mon 05:00–11:30 America/Toronto,
 * Tuesday after Ontario holiday Mondays.
 */
import assert from 'node:assert/strict';
import {
  isOntarioHolidayMonday,
  isStallionScheduleWindow,
  mondayObservance,
  nthMonday,
  ontarioHolidayMondays,
  stallionActiveYmd,
  torontoParts,
  victoriaDayMonday,
} from '../src/stallion-schedule.js';
import { stallionEnabled } from '../src/stallion-config.js';

assert.equal(nthMonday(2026, 2, 3), '2026-02-16'); // Family Day
assert.equal(nthMonday(2026, 9, 1), '2026-09-07'); // Labour Day
assert.equal(nthMonday(2026, 10, 2), '2026-10-12'); // Thanksgiving
assert.equal(victoriaDayMonday(2026), '2026-05-18');
assert.equal(mondayObservance(2026, 7, 1), null); // Wed — not a Monday key
assert.equal(mondayObservance(2027, 7, 1), null); // Thu
assert.equal(mondayObservance(2028, 7, 1), '2028-07-03'); // Sat → Mon
assert.equal(mondayObservance(2024, 1, 1), '2024-01-01'); // Mon New Year's
assert.equal(mondayObservance(2023, 1, 1), '2023-01-02'); // Sun → Mon
assert.ok(ontarioHolidayMondays(2026).has('2026-09-07'));
assert.ok(isOntarioHolidayMonday('2026-09-07'));
assert.equal(isOntarioHolidayMonday('2026-09-14'), false);

// Ordinary Monday 10:00 EDT — inside window
assert.equal(
  isStallionScheduleWindow(new Date('2026-09-14T10:00:00-04:00')),
  true,
);
// Same Monday 05:00 — window opens
assert.equal(
  isStallionScheduleWindow(new Date('2026-09-14T05:00:00-04:00')),
  true,
);
// Same Monday 04:59 — before window
assert.equal(
  isStallionScheduleWindow(new Date('2026-09-14T04:59:00-04:00')),
  false,
);
// 11:30 — off
assert.equal(
  isStallionScheduleWindow(new Date('2026-09-14T11:30:00-04:00')),
  false,
);
// 11:29 — still on
assert.equal(
  isStallionScheduleWindow(new Date('2026-09-14T11:29:00-04:00')),
  true,
);
// Tuesday after ordinary Monday — off
assert.equal(
  isStallionScheduleWindow(new Date('2026-09-15T10:00:00-04:00')),
  false,
);

// Labour Day Monday 2026 — off all day; Tuesday is the window
assert.equal(
  isStallionScheduleWindow(new Date('2026-09-07T10:00:00-04:00')),
  false,
);
assert.equal(
  isStallionScheduleWindow(new Date('2026-09-08T05:00:00-04:00')),
  true,
);
assert.equal(
  isStallionScheduleWindow(new Date('2026-09-08T11:29:00-04:00')),
  true,
);
assert.equal(
  isStallionScheduleWindow(new Date('2026-09-08T11:30:00-04:00')),
  false,
);

const labourWeek = torontoParts(new Date('2026-09-07T12:00:00-04:00'));
assert.equal(stallionActiveYmd(labourWeek), '2026-09-08');
const normalWeek = torontoParts(new Date('2026-09-14T12:00:00-04:00'));
assert.equal(stallionActiveYmd(normalWeek), '2026-09-14');

const prevEnabled = process.env.STALLION_ENABLED;
const prevSchedule = process.env.STALLION_SCHEDULE;

process.env.STALLION_ENABLED = 'false';
process.env.STALLION_SCHEDULE = 'true';
assert.equal(stallionEnabled(), false);

process.env.STALLION_ENABLED = 'true';
process.env.STALLION_SCHEDULE = 'true';
assert.equal(stallionEnabled(new Date('2026-09-14T05:00:00-04:00')), true);
assert.equal(stallionEnabled(new Date('2026-09-14T04:59:00-04:00')), false);

process.env.STALLION_TEST_WINDOW_START = '2026-09-11T16:30:00-04:00';
process.env.STALLION_TEST_WINDOW_END = '2026-09-11T18:00:00-04:00';
assert.equal(stallionEnabled(new Date('2026-09-11T16:29:00-04:00')), false);
assert.equal(stallionEnabled(new Date('2026-09-11T16:30:00-04:00')), true);
assert.equal(stallionEnabled(new Date('2026-09-11T17:59:00-04:00')), true);
assert.equal(stallionEnabled(new Date('2026-09-11T18:00:00-04:00')), false);
delete process.env.STALLION_TEST_WINDOW_START;
delete process.env.STALLION_TEST_WINDOW_END;

if (prevEnabled == null) delete process.env.STALLION_ENABLED;
else process.env.STALLION_ENABLED = prevEnabled;
if (prevSchedule == null) delete process.env.STALLION_SCHEDULE;
else process.env.STALLION_SCHEDULE = prevSchedule;

console.log('stallion-schedule tests passed');
