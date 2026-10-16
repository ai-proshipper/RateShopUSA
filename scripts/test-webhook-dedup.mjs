/**
 * Sequential reprint after a success must buy again (ShipHero void + print).
 * Overlapping requests still share one in-flight purchase.
 */
process.env.WEBHOOK_DEDUP_TTL_MS = '0';

import assert from 'node:assert/strict';
import {
  clearWebhookDedup,
  orderDedupKey,
  withOrderDedup,
} from '../src/webhook-dedup.js';

clearWebhookDedup();

assert.equal(
  orderDedupKey({ order_id: '880787604', packages: [{ weight_in_oz: 624 }] }),
  '880787604:624',
);

let runs = 0;
const success = { code: '200', label: 'old-pdf', tracking_number: '1ZOLD' };

const first = await withOrderDedup('880787604:624', async () => {
  runs += 1;
  return { ...success, tracking_number: `run-${runs}` };
});
assert.equal(first.tracking_number, 'run-1');
assert.equal(runs, 1);

const second = await withOrderDedup('880787604:624', async () => {
  runs += 1;
  return { ...success, tracking_number: `run-${runs}` };
});
assert.equal(second.tracking_number, 'run-2');
assert.equal(runs, 2);

let overlapRuns = 0;
let release;
const gate = new Promise((resolve) => {
  release = resolve;
});
const overlap = withOrderDedup('overlap:1', async () => {
  overlapRuns += 1;
  await gate;
  return { code: '200', label: 'pdf', tracking_number: 'shared' };
});
const waiter = withOrderDedup('overlap:1', async () => {
  overlapRuns += 1;
  return { code: '200', label: 'pdf', tracking_number: 'should-not-run' };
});
release();
const [a, b] = await Promise.all([overlap, waiter]);
assert.equal(a.tracking_number, 'shared');
assert.equal(b.tracking_number, 'shared');
assert.equal(overlapRuns, 1);

clearWebhookDedup();
console.log('usa webhook-dedup tests passed');
