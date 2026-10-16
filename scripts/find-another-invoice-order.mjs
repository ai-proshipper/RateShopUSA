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
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// Pull a wider window of older UPS labels with package payloads
const labels = await sb(
  '/rest/v1/shipping_labels?select=tracking_number,carrier,service_level,label_shipping_cost,shipped_at,order_id,raw_payload&carrier=ilike.*ups*&shipped_at=lt.2026-07-25T00:00:00%2B00:00&raw_payload=not.is.null&order=shipped_at.desc&limit=1000',
);

const skipOrders = new Set([
  '112-9710328-1797066',
  '113-5118688-9016239',
  '114-8880236-4707409',
  '114-6923494-2927463',
]);

const candidates = [];
for (const label of labels || []) {
  const pkg = label.raw_payload?.package;
  if (!pkg?.line_items?.length || !pkg.weight_in_oz || !pkg.length) continue;
  if (Number(pkg.length) > 55 || Number(pkg.weight_in_oz) / 16 > 35) continue;
  const li = pkg.line_items.find((x) =>
    String(x.tariff_code || '').replace(/\D/g, '').startsWith('842549'),
  );
  if (!li) continue;

  const orders = await sb(
    `/rest/v1/orders?select=order_number,partner_order_id&id=eq.${label.order_id}&limit=1`,
  );
  const orderNumber = orders?.[0]?.order_number || orders?.[0]?.partner_order_id;
  if (!orderNumber || skipOrders.has(String(orderNumber))) continue;
  // Prefer Amazon-looking order numbers for easier invoice search
  const amazonLike = /^\d{3}-\d{7}-\d{7}$/.test(String(orderNumber));
  candidates.push({
    amazonLike,
    shipped: label.shipped_at,
    orderNumber,
    tracking: label.tracking_number,
    carrier: label.carrier,
    service: label.service_level,
    cost: label.label_shipping_cost,
    sku: li.sku,
    hs: li.tariff_code,
    customs: li.product_customs_value || li.customs_value,
    dims: `${pkg.length}x${pkg.width}x${pkg.height}`,
    weightLbs: Number(pkg.weight_in_oz) / 16,
    label,
    pkg,
    li,
  });
}

candidates.sort((a, b) => {
  if (a.amazonLike !== b.amazonLike) return a.amazonLike ? -1 : 1;
  return String(a.shipped).localeCompare(String(b.shipped)); // older first among equals
});

console.log('CANDIDATES (oldest Amazon-like first):');
for (const c of candidates.slice(0, 15)) {
  console.log(
    `${String(c.shipped).slice(0, 10)}  ${c.orderNumber}  ${c.service} $${c.cost}  ${c.sku} customs=${c.customs}  ${c.tracking}`,
  );
}

if (!candidates.length) {
  console.error('No candidates');
  process.exit(1);
}

const pick = candidates.find((c) => c.amazonLike) || candidates[0];
const { accessToken, refreshToken } = await resolveShipHeroAccessToken();
const q = `query { orders(order_number: "${String(pick.orderNumber).replace(/"/g, '\\"')}") { data(first:1){ edges{ node{
  order_number
  shipping_address { first_name last_name company address1 address2 city state state_code zip country phone }
}}}}}`;
const { json } = await shipheroGraphqlRequest(accessToken, q, { refreshToken });
const addr = json?.data?.orders?.data?.edges?.[0]?.node?.shipping_address;
if (!addr?.zip) {
  console.error('Could not load address for', pick.orderNumber);
  process.exit(1);
}

const shipment = {
  orderNumber: pick.orderNumber,
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
    address1: addr.address1 || '',
    city: addr.city || '',
    state: addr.state_code || addr.state || '',
    postalCode: String(addr.zip || '').split('-')[0],
    country: addr.country || 'US',
    phone: addr.phone || undefined,
    is_residential: true,
  },
  packages: [
    {
      name: pick.pkg.box_name || 'Package 1',
      weightLbs: Number(pick.pkg.weight_in_oz) / 16,
      lengthIn: Number(pick.pkg.length),
      widthIn: Number(pick.pkg.width),
      heightIn: Number(pick.pkg.height),
      package_contents: String(pick.li.customs_description || pick.li.product_name || 'Merchandise').slice(0, 100),
    },
  ],
  items: [
    {
      title: String(pick.li.product_name || pick.sku).slice(0, 80),
      sku: pick.sku,
      quantity: Math.max(1, Number(pick.li.quantity) || 1),
      value: Number(pick.customs),
      currency: 'USD',
      hs_code: '8425.49.00.00',
      country_of_origin: String(pick.li.country_of_manufacture || 'CA').slice(0, 2).toUpperCase(),
      customs_description: String(
        pick.li.customs_description || pick.li.product_name || 'Merchandise',
      ).slice(0, 100),
    },
  ],
};

const samplePath = resolve(
  root,
  'samples',
  `order-${String(pick.orderNumber).replace(/[^\w.-]+/g, '_')}-invoice-check.json`,
);
writeFileSync(samplePath, JSON.stringify(shipment, null, 2));

const [stallion, ups, cp] = await Promise.all([
  quoteStallion(shipment),
  quoteUps(shipment),
  quoteCanadaPostUs(shipment),
]);

console.log('\nSELECTED');
console.log(
  JSON.stringify(
    {
      orderNumber: pick.orderNumber,
      shipped_at: pick.shipped,
      tracking: pick.tracking,
      labelCost: pick.cost,
      service: pick.service,
      to: `${shipment.to.city}, ${shipment.to.state} ${shipment.to.postalCode}`,
      pkg: `${shipment.packages[0].weightLbs} lb ${shipment.packages[0].lengthIn}x${shipment.packages[0].widthIn}x${shipment.packages[0].heightIn}`,
      sku: pick.sku,
      customs: pick.customs,
      hs: '8425.49.00.00',
      samplePath,
      duties: {
        stallion: stallion.rates?.[0]?.duty ?? null,
        ups: ups.landedCost?.totalDutyAndTax ?? null,
        zonos: cp.rates?.find((r) => r.duty != null)?.duty ?? null,
        upsDisbursement: UPS_DISBURSEMENT_FEE_CAD,
      },
      stallion: (stallion.rates || []).map((r) => ({
        service: r.service_name,
        base: r.base_rate,
        duty: r.duty,
        total: r.total,
      })),
      stallionError: stallion.message || null,
      ups: (ups.rates || []).map((r) => ({
        service: r.serviceName,
        ship: r.shipping,
        dutyTax: r.dutyAndTax,
        disburse: r.brokerage,
        landed: r.landedTotal,
      })),
      cp: (cp.rates || []).map((r) => ({
        service: r.serviceName,
        ship: r.shipping,
        duty: r.duty,
        fees: r.fees,
        import: r.importCharges,
        landed: r.landedTotal,
      })),
    },
    null,
    2,
  ),
);
