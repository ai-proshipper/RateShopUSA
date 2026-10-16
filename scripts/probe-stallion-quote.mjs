/**
 * Stallion PRODUCTION rates probe.
 * RATE-ONLY — calls POST /rates exclusively. Never creates shipments or labels.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stallionBaseUrl, stallionToken, QUOTE_TIMEOUT_MS } from '../src/config.js';
import { quoteStallion } from '../src/stallion-rate.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const envText = readFileSync(resolve(root, '.env'), 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (!m) continue;
  const key = m[1].trim();
  const val = m[2].trim();
  if (!(key in process.env)) process.env[key] = val;
}

if (!stallionToken()) {
  console.error('REFUSING: set STALLION_TOKEN or StallionAPI in .env');
  process.exit(2);
}

const base = stallionBaseUrl();
if (!base.includes('ship.stallion.ca') && !base.includes('sandbox.stallion.ca')) {
  console.error(`REFUSING unexpected Stallion base URL: ${base}`);
  process.exit(2);
}

const samplePath = resolve(root, 'samples', 'us-shipment.json');
const shipment = JSON.parse(readFileSync(samplePath, 'utf8'));

const timeoutMs = QUOTE_TIMEOUT_MS;
console.log('=== STALLION RATE-ONLY PROBE (NO LABELS / NO SHIPMENTS) ===');
console.log(`POST ${base}/rates  (timeout ${timeoutMs}ms)`);
console.log(
  `Ship to: ${shipment.to.city}, ${shipment.to.state} ${shipment.to.postalCode} ${shipment.to.country}`,
);

const quote = await quoteStallion(shipment, timeoutMs);

if (quote.status === 'ok' && quote.rates.length) {
  console.log('\nService                          Carrier      Total     Duty      Currency');
  console.log('-'.repeat(78));
  for (const r of quote.rates) {
    const service = String(r.service_name || r.service || '').padEnd(32).slice(0, 32);
    const carrier = String(r.carrier || '').padEnd(12).slice(0, 12);
    const total = String(r.total ?? '').padStart(8);
    const duty = String(r.duty ?? '—').padStart(8);
    console.log(`${service} ${carrier} ${total}  ${duty}  ${r.currency || ''}`);
  }
} else if (quote.status === 'ok') {
  console.log('\nNo rates returned in data[].');
} else {
  console.error(`\nERROR: ${quote.message}`);
}

console.log('\nJSON:\n' + JSON.stringify(quote, null, 2));
process.exitCode = quote.status === 'ok' ? 0 : 1;
