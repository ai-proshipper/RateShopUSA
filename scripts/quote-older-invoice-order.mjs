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

const tracking = process.argv[2] || '1ZAC88906723210621';
const labels = await sb(
  `/rest/v1/shipping_labels?select=*&tracking_number=eq.${tracking}&limit=1`,
);
const label = labels[0];
if (!label) {
  console.error('label not found');
  process.exit(1);
}
const orders = await sb(
  `/rest/v1/orders?select=order_number,partner_order_id&id=eq.${label.order_id}&limit=1`,
);
const orderNumber = orders[0]?.order_number || orders[0]?.partner_order_id;

const { accessToken, refreshToken } = await resolveShipHeroAccessToken();
const q = `query { orders(order_number: "${String(orderNumber).replace(/"/g, '\\"')}") { data(first:1){ edges{ node{
  order_number
  shipping_address { first_name last_name company address1 address2 city state state_code zip country phone }
}}}}}`;
const { json } = await shipheroGraphqlRequest(accessToken, q, { refreshToken });
const node = json?.data?.orders?.data?.edges?.[0]?.node;
const addr = node?.shipping_address;
if (!addr?.zip) {
  console.error('no address', orderNumber);
  process.exit(1);
}
const pkg = label.raw_payload.package;
const li =
  (pkg.line_items || []).find((x) => x.sku === 'SMI6010' || x.sku === 'SMI6011') ||
  pkg.line_items[0];

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
      name: pkg.box_name || 'Package 1',
      weightLbs: Number(pkg.weight_in_oz) / 16,
      lengthIn: Number(pkg.length),
      widthIn: Number(pkg.width),
      heightIn: Number(pkg.height),
      package_contents: 'Iron Motorcycle Lift Stands',
    },
  ],
  items: [
    {
      title: 'Iron Motorcycle Lift Stands',
      sku: li.sku,
      quantity: 1,
      value: Number(li.product_customs_value || li.customs_value || 18.88),
      currency: 'USD',
      hs_code: '8425.49.00.00',
      country_of_origin: 'CA',
      customs_description: 'Iron Motorcycle Lift Stands',
    },
  ],
};

const samplePath = resolve(
  root,
  'samples',
  `order-${String(orderNumber).replace(/[^\w.-]+/g, '_')}-invoice-check.json`,
);
writeFileSync(samplePath, JSON.stringify(shipment, null, 2));

const [stallion, ups, cp] = await Promise.all([
  quoteStallion(shipment),
  quoteUps(shipment),
  quoteCanadaPostUs(shipment),
]);

const result = {
  orderNumber,
  shipped_at: label.shipped_at,
  tracking,
  label: {
    carrier: label.carrier,
    service: label.service_level,
    cost: label.label_shipping_cost,
  },
  to: `${shipment.to.city}, ${shipment.to.state} ${shipment.to.postalCode}`,
  pkg: `${shipment.packages[0].weightLbs} lb ${shipment.packages[0].lengthIn}x${shipment.packages[0].widthIn}x${shipment.packages[0].heightIn}`,
  item: shipment.items[0],
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
  stallionStatus: stallion.status,
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
};
console.log(JSON.stringify(result, null, 2));

// June-or-earlier list
const older = await sb(
  '/rest/v1/shipping_labels?select=tracking_number,carrier,service_level,label_shipping_cost,shipped_at,order_id,raw_payload&shipped_at=lt.2026-07-01T00:00:00%2B00:00&raw_payload=not.is.null&order=shipped_at.desc&limit=800',
);
const june = [];
for (const l of older || []) {
  const txt = JSON.stringify(l.raw_payload || {});
  if (!/SMI6010|8425\.49\.00\.00|8425490000/i.test(txt)) continue;
  const p = l.raw_payload?.package;
  if (!p?.line_items) continue;
  const item =
    p.line_items.find(
      (x) =>
        String(x.sku || '').includes('SMI') ||
        String(x.tariff_code || '').includes('8425'),
    ) || p.line_items[0];
  const o = await sb(
    `/rest/v1/orders?select=order_number&id=eq.${l.order_id}&limit=1`,
  );
  june.push({
    shipped: l.shipped_at?.slice(0, 10),
    order: o[0]?.order_number,
    carrier: l.carrier,
    service: l.service_level,
    cost: l.label_shipping_cost,
    tracking: l.tracking_number,
    sku: item?.sku,
    hs: item?.tariff_code,
  });
  if (june.length >= 10) break;
}
console.log('OLDER_CANDIDATES');
console.log(JSON.stringify(june, null, 2));
