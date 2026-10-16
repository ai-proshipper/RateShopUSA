/**
 * Find an older shipped US order with Stallion-friendly HS (8425.49 / lift-stand family),
 * then quote Stallion / UPS / CP+Zonos for invoice cross-check.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveShipHeroAccessToken,
  shipheroGraphqlRequest,
} from '../../ShippingTracking/scripts/lib/shiphero-auth.mjs';
import { quoteStallion } from '../src/stallion-rate.js';
import { quoteUps } from '../src/ups-quote.js';
import { quoteCanadaPostUs } from '../src/canada-post-quote.js';
import { QUOTE_TIMEOUT_MS } from '../src/config.js';
import { UPS_DISBURSEMENT_FEE_CAD, UPS_QUOTE_TIMEOUT_MS } from '../src/ups-config.js';
import { CANADA_POST_QUOTE_TIMEOUT_MS } from '../src/canada-post-config.js';

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

const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(
  /\/$/,
  '',
);
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_ANON_KEY;
const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Accept-Profile': 'shiphero',
};

async function sb(path) {
  const res = await fetch(`${url}${path}`, { headers });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) throw new Error(`SB ${res.status}: ${String(text).slice(0, 300)}`);
  return json;
}

function friendlyLine(li) {
  const sku = String(li?.sku || '').toUpperCase();
  const hs = String(li?.tariff_code || li?.hs_code || '');
  const digits = hs.replace(/\D/g, '');
  if (digits.startsWith('842549')) return true;
  if (/^SMI\d|^S\d{4}|^ETJ-|^LIFT-/i.test(sku)) return true;
  return false;
}

// Older than ~2 weeks ago so invoice is likely available
const before = '2026-07-30T00:00:00+00:00';
const labels = await sb(
  `/rest/v1/shipping_labels?select=id,tracking_number,carrier,service_level,label_shipping_cost,shipped_at,order_id,raw_payload&shipped_at=lt.${encodeURIComponent(before)}&or=(carrier.ilike.*ups*,carrier.ilike.*canada*,carrier.ilike.*cp*)&order=shipped_at.desc&limit=400`,
);

const hits = [];
for (const label of labels || []) {
  const pkg = label.raw_payload?.package;
  if (!pkg?.line_items?.length || !pkg.weight_in_oz || !pkg.length) continue;
  const li = pkg.line_items.find(friendlyLine) || null;
  if (!li) continue;
  const hs = String(li.tariff_code || '').replace(/\D/g, '');
  // Prefer exact known-good rates HS
  if (!hs.startsWith('842549')) continue;
  hits.push({ label, li, pkg });
}

console.log(`Older labels scanned: ${labels?.length || 0}; friendly 8425.49 hits: ${hits.length}`);
if (!hits.length) {
  console.error('No older friendly hits');
  process.exit(1);
}

// Show top candidates
for (const hit of hits.slice(0, 10)) {
  const orders = await sb(
    `/rest/v1/orders?select=order_number,partner_order_id&id=eq.${hit.label.order_id}&limit=1`,
  );
  const orderNumber = orders?.[0]?.order_number || orders?.[0]?.partner_order_id;
  console.log(
    `${hit.label.shipped_at?.slice(0, 10)}  ${orderNumber}  ${hit.label.carrier} ${hit.label.service_level} $${hit.label.label_shipping_cost}  sku=${hit.li.sku} hs=${hit.li.tariff_code} customs=${hit.li.product_customs_value || hit.li.customs_value} track=${hit.label.tracking_number}`,
  );
}

// Pick first with resolvable ShipHero address
const { accessToken, refreshToken } = await resolveShipHeroAccessToken();

async function fetchOrder(orderNumber) {
  const escaped = String(orderNumber).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const q = `query { orders(order_number: "${escaped}") { data(first:1){ edges{ node{
    order_number expected_weight_in_oz
    shipping_address { first_name last_name company address1 address2 city state state_code zip country phone }
    line_items(first:50){ edges{ node{ sku quantity product_name customs_value price
      product { customs_description tariff_code country_of_manufacture customs_value warehouse_products { customs_value } }
    }}}
    shipments { shipping_labels { tracking_number carrier shipping_method cost box_name dimensions { weight length width height } } }
  }}}}}`;
  const { json } = await shipheroGraphqlRequest(accessToken, q, { refreshToken });
  return json?.data?.orders?.data?.edges?.[0]?.node || null;
}

function warehouseCustoms(product) {
  for (const row of product?.warehouse_products || []) {
    const v = Number(row?.customs_value);
    if (Number.isFinite(v) && v > 0) return v;
  }
  const top = Number(product?.customs_value);
  return Number.isFinite(top) && top > 0 ? top : null;
}

let chosen = null;
let order = null;
let orderNumber = null;

for (const hit of hits.slice(0, 25)) {
  const orders = await sb(
    `/rest/v1/orders?select=order_number,partner_order_id&id=eq.${hit.label.order_id}&limit=1`,
  );
  orderNumber = orders?.[0]?.order_number || orders?.[0]?.partner_order_id;
  if (!orderNumber) continue;
  order = await fetchOrder(orderNumber);
  if (!order?.shipping_address?.zip && !order?.shipping_address?.address1) continue;
  // Prefer mid-size packages Stallion can actually rate
  const len = Number(hit.pkg.length);
  const weightLbs = Number(hit.pkg.weight_in_oz) / 16;
  if (len > 60 || weightLbs > 40) continue;
  chosen = hit;
  break;
}

if (!chosen || !order) {
  console.error('Could not resolve ShipHero address for candidates');
  process.exit(1);
}

const addr = order.shipping_address;
const labelSku = chosen.li.sku;
const lineNodes = (order.line_items?.edges || []).map((e) => e.node);
const match =
  lineNodes.find((n) => n.sku === labelSku) ||
  lineNodes.find((n) => String(n.sku || '').startsWith(String(labelSku).split('-')[0])) ||
  null;

const customsFromLabel =
  Number(chosen.li.product_customs_value) > 0
    ? Number(chosen.li.product_customs_value)
    : Number(chosen.li.customs_value) > 0
      ? Number(chosen.li.customs_value)
      : null;
const customsFromOrder = match
  ? Number(match.customs_value) > 0
    ? Number(match.customs_value)
    : warehouseCustoms(match.product)
  : null;
const customs = customsFromLabel || customsFromOrder;
const hs = '8425.49.00.00';
const origin = String(
  chosen.li.country_of_manufacture ||
    match?.product?.country_of_manufacture ||
    'CA',
)
  .slice(0, 2)
  .toUpperCase();

const shipment = {
  orderNumber,
  currency: 'CAD',
  region: 'ON',
  from: {
    name: 'KapscoMoto Warehouse',
    company: 'KapscoMoto',
    address1: '410 Finley Ave',
    city: 'Ajax',
    state: 'ON',
    postalCode: 'L1S 2E3',
    country: 'CA',
    phone: '9055550100',
  },
  to: {
    name: [addr.first_name, addr.last_name].filter(Boolean).join(' ') || 'Recipient',
    company: addr.company || undefined,
    address1: addr.address1 || '',
    address2: addr.address2 || undefined,
    city: addr.city || '',
    state: addr.state_code || addr.state || '',
    postalCode: String(addr.zip || '').split('-')[0],
    country: addr.country || 'US',
    phone: addr.phone || undefined,
    is_residential: !String(addr.company || '').trim(),
  },
  packages: [
    {
      name: chosen.pkg.box_name || chosen.pkg.name || 'Package 1',
      weightLbs: Number(chosen.pkg.weight_in_oz) / 16,
      lengthIn: Number(chosen.pkg.length),
      widthIn: Number(chosen.pkg.width),
      heightIn: Number(chosen.pkg.height),
      package_contents:
        chosen.li.customs_description || chosen.li.product_name || 'Merchandise',
    },
  ],
  items: [
    {
      title: chosen.li.product_name || labelSku,
      sku: labelSku,
      quantity: Math.max(1, Number(chosen.li.quantity) || 1),
      value: customs,
      currency: 'USD',
      hs_code: hs,
      country_of_origin: origin,
      customs_description:
        chosen.li.customs_description ||
        match?.product?.customs_description ||
        chosen.li.product_name ||
        'Merchandise',
    },
  ],
};

const samplePath = resolve(
  root,
  'samples',
  `order-${String(orderNumber).replace(/[^\w.-]+/g, '_')}-invoice-check.json`,
);
writeFileSync(samplePath, JSON.stringify(shipment, null, 2));

console.log('\n=== SELECTED FOR INVOICE CHECK ===');
console.log(`Order: ${orderNumber}`);
console.log(`Shipped: ${chosen.label.shipped_at}`);
console.log(
  `Label: ${chosen.label.carrier} ${chosen.label.service_level} $${chosen.label.label_shipping_cost} (${chosen.label.tracking_number})`,
);
console.log(
  `To: ${shipment.to.city}, ${shipment.to.state} ${shipment.to.postalCode}`,
);
console.log(
  `Pkg: ${shipment.packages[0].weightLbs} lb ${shipment.packages[0].lengthIn}x${shipment.packages[0].widthIn}x${shipment.packages[0].heightIn}`,
);
console.log(
  `Item: ${labelSku} customs $${customs} HS ${hs} origin ${origin}`,
);
console.log(`Saved: ${samplePath}`);

const [stallion, ups, cp] = await Promise.all([
  quoteStallion(shipment, QUOTE_TIMEOUT_MS),
  quoteUps(shipment, UPS_QUOTE_TIMEOUT_MS),
  quoteCanadaPostUs(shipment, CANADA_POST_QUOTE_TIMEOUT_MS),
]);

console.log('\n---------- STALLION ----------');
console.log(`Status: ${stallion.status}${stallion.message ? ` — ${stallion.message}` : ''}`);
for (const r of stallion.rates || []) {
  console.log(
    `${String(r.service_name || r.service).padEnd(32)} base $${r.base_rate} duty $${r.duty} total $${r.total}`,
  );
}
if (!stallion.rates?.length) console.log('No rates');

console.log('\n---------- UPS ----------');
for (const r of ups.rates || []) {
  console.log(
    `${String(r.serviceName).padEnd(32)} ship $${r.shipping} duty/tax $${r.dutyAndTax} disburse $${r.brokerage} landed $${r.landedTotal}`,
  );
}
console.log(
  `UPS LC duty/tax $${ups.landedCost?.totalDutyAndTax} (+$${UPS_DISBURSEMENT_FEE_CAD} disbursement)`,
);

console.log('\n---------- CANADA POST + ZONOS ----------');
for (const r of cp.rates || []) {
  console.log(
    `${String(r.serviceName || r.serviceCode).padEnd(36)} ship $${r.shipping} duty $${r.duty} fees $${r.fees} import $${r.importCharges} landed $${r.landedTotal}`,
  );
}
const z = (cp.rates || []).find((r) => Array.isArray(r.feeItems) && r.feeItems.length);
if (z?.feeItems) {
  console.log('Zonos fee lines:');
  for (const f of z.feeItems) console.log(`  ${f.description}: $${f.amount} (${f.formula || ''})`);
}
const dutyLines =
  z?.zonosRaw?.data?.landedCostCalculateWorkflow?.[0]?.dutiesTaxesFees || [];
if (dutyLines.length) {
  console.log('Zonos duty lines:');
  for (const d of dutyLines) {
    if (String(d?.type || '').toLowerCase().includes('fee')) continue;
    console.log(`  ${d.note || d.description || d.type}: $${d.amount} (${d.formula || ''})`);
  }
}

console.log('\n---------- DUTY COMPARISON ----------');
console.log(`Stallion: ${stallion.rates?.[0]?.duty ?? 'n/a'}`);
console.log(`UPS:      ${ups.landedCost?.totalDutyAndTax ?? 'n/a'}`);
console.log(`Zonos:    ${cp.rates?.find((r) => r.duty != null)?.duty ?? 'n/a'}`);
