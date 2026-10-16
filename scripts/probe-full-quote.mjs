/**
 * Full 3-carrier quote for samples/us-shipment.json (known-good Stallion HS).
 * Rates only — no labels. Uses compareQuotes (does not buy postage).
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareQuotes } from '../src/compare-quotes.js';
import { UPS_DISBURSEMENT_FEE_CAD } from '../src/ups-config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
loadEnv(resolve(root, '.env'));
loadEnv(resolve(root, '..', 'ShippingTracking', '.env'));

const shipment = JSON.parse(
  readFileSync(resolve(root, 'samples', 'us-shipment.json'), 'utf8'),
);

console.log('=== FULL 3-CARRIER QUOTE (rates only, no labels) ===');
console.log(
  `Order ${shipment.orderNumber}: ${shipment.to.city}, ${shipment.to.state} ${shipment.to.postalCode}`,
);
console.log(
  `Package ${shipment.packages[0].weightLbs} lb ${shipment.packages[0].lengthIn}x${shipment.packages[0].widthIn}x${shipment.packages[0].heightIn}`,
);
for (const i of shipment.items) {
  console.log(
    `Item ${i.sku} customs $${i.value} HS ${i.hs_code} origin ${i.country_of_origin}`,
  );
}
console.log(`UPS disbursement flat: $${UPS_DISBURSEMENT_FEE_CAD}`);

const { stallion, ups, canadaPost: cp, ranked } = await compareQuotes(shipment);

console.log('\n---------- STALLION ----------');
console.log(`Status: ${stallion.status}${stallion.message ? ` — ${stallion.message}` : ''}`);
if (stallion.rates?.length) {
  console.log(
    'Service                          Carrier      Base     Duty  DutyTax      Tax    Total',
  );
  for (const r of stallion.rates) {
    console.log(
      `${String(r.service_name || r.service).padEnd(32).slice(0, 32)} ${String(r.carrier || '').padEnd(10).slice(0, 10)} ${String(r.base_rate ?? '—').padStart(7)} ${String(r.duty ?? '—').padStart(7)} ${String(r.duty_tax ?? '—').padStart(7)} ${String(r.tax ?? '—').padStart(7)} ${String(r.total ?? '—').padStart(8)} ${r.currency || ''}`,
    );
  }
} else console.log('No rates');

console.log('\n---------- UPS ----------');
console.log(`Status: ${ups.status}`);
if (ups.zonosDuty?.error && ups.zonosDuty.status !== 'ok') {
  console.log(`Zonos duties: ${ups.zonosDuty.error}`);
}
if (ups.rates?.length) {
  console.log(
    'Service                          Shipping     Duty  Disburse   Import   Landed',
  );
  for (const r of ups.rates) {
    console.log(
      `${String(r.serviceName).padEnd(32).slice(0, 32)} ${fmt(r.shipping)} ${fmt(r.duty)} ${fmt(r.brokerage)} ${fmt(r.importCharges)} ${fmt(r.landedTotal)}`,
    );
  }
}
if (ups.zonosDuty?.status === 'ok') {
  console.log(
    `UPS uses Canada Post Zonos duties $${ups.zonosDuty.duties} (${ups.zonosDuty.sourceService || 'zonos'}) + $${UPS_DISBURSEMENT_FEE_CAD} disbursement`,
  );
}

console.log('\n---------- CANADA POST + ZONOS ----------');
console.log(`Status: ${cp.status}${cp.ratingError ? ` — ${cp.ratingError}` : ''}`);
if (cp.rates?.length) {
  console.log(
    'Service                               Shipping     Duty   Taxes    Fees   Import   Landed',
  );
  for (const r of cp.rates) {
    console.log(
      `${String(r.serviceName || r.serviceCode).padEnd(36).slice(0, 36)} ${fmt(r.shipping)} ${fmt(r.duty)} ${fmt(r.taxes)} ${fmt(r.fees)} ${fmt(r.importCharges)} ${fmt(r.landedTotal)}${r.landedError ? ' ERR ' + r.landedError : ''}`,
    );
  }
  const z = cp.rates.find((r) => r.duty != null);
  const lines = z?.zonosRaw?.data?.landedCostCalculateWorkflow?.[0]?.dutiesTaxesFees || [];
  if (lines.length) {
    console.log('Zonos duty/tax lines:');
    for (const d of lines) {
      if (String(d?.type || '').toLowerCase().includes('fee')) continue;
      console.log(`  ${d.note || d.description || d.type}: $${d.amount} (${d.formula || ''})`);
    }
  }
} else console.log('No rates');

console.log('\n---------- DUTY / RANKED CAD LANDED ----------');
const stallionDuty = stallion.rates?.[0]?.duty;
const upsDuty = ups.rates?.find((r) => r.duty != null)?.duty;
const zonosDuty = cp.rates?.find((r) => r.duty != null)?.duty;
console.log(`Stallion duty:  ${money(stallionDuty)}`);
console.log(`UPS (Zonos) duty: ${money(upsDuty)} (+$${UPS_DISBURSEMENT_FEE_CAD} disbursement)`);
console.log(`Zonos duty:     ${money(zonosDuty)}`);

if (ranked.length) {
  console.log('\nRanked CAD landed (no label purchase):');
  for (const c of ranked.slice(0, 8)) {
    console.log(
      `  $${Number(c.landedTotal).toFixed(2).padStart(7)}  ${String(c.carrier).padEnd(11)} ${c.service} (duty $${Number(c.duty || 0).toFixed(2)})`,
    );
  }
} else {
  console.log('No CAD landed totals to rank');
}

function fmt(v) {
  return v == null || !Number.isFinite(Number(v))
    ? '—'.padStart(8)
    : `$${Number(v).toFixed(2)}`.padStart(8);
}
function money(v) {
  return v == null || !Number.isFinite(Number(v)) ? 'n/a' : `$${Number(v).toFixed(2)}`;
}
