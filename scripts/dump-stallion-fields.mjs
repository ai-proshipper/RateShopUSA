import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

function loadEnv(p) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

loadEnv(resolve('.env'));

const { quoteStallion } = await import('../src/stallion-rate.js');
const s = JSON.parse(
  readFileSync(
    './samples/order-111-8209310-3352207-may20-invoice-check.json',
    'utf8',
  ),
);
const q = await quoteStallion(s);
const top = q.raw;
console.log('TOP KEYS:', Object.keys(top || {}));
console.log('status/message:', { status: q.status, message: q.message, rateCount: q.rates?.length });
const r = top?.data?.[0];
console.log('RATE KEYS:', Object.keys(r || {}));
console.log(JSON.stringify(r, null, 2));
if (top?.data?.length > 1) {
  console.log('\nALL RATE SERVICES:');
  for (const rate of top.data) {
    console.log(
      JSON.stringify({
        carrier: rate.carrier,
        service_name: rate.service_name,
        service_code: rate.service_code,
        base_rate: rate.base_rate,
        duty: rate.duty,
        duty_tax: rate.duty_tax,
        tax: rate.tax,
        total: rate.total,
        currency: rate.currency,
      }),
    );
  }
}
