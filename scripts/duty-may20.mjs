import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quoteStallion } from '../src/stallion-rate.js';
import { quoteUpsLandedCost, buildUpsLandedCostBody, normalizeUpsLandedCost } from '../src/ups-landed-cost.js';
import { upsQuoteHeaders } from '../src/ups-auth.js';
import {
  assertUpsQuoteCredentials,
  upsAccountNumber,
  upsLandedCostUrl,
  UPS_DISBURSEMENT_FEE_CAD,
} from '../src/ups-config.js';
import { quoteZonosLandedCost } from '../src/zonos-landed-cost.js';

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

const dayStart = '2026-05-20T00:00:00+00:00';
const dayEnd = '2026-05-21T00:00:00+00:00';

const labels = await sb(
  `/rest/v1/shipping_labels?select=tracking_number,carrier,service_level,label_shipping_cost,shipped_at,order_id&shipped_at=gte.${encodeURIComponent(dayStart)}&shipped_at=lt.${encodeURIComponent(dayEnd)}&order=shipped_at.asc&limit=500`,
);
console.log(`Labels on 2026-05-20: ${labels.length}`);

const friendlySkus = ['SMI6010', 'SMI6011', 'SMI3000', 'SMI3011', 'SMI3020', 'SMI3017', 'VEN11', 'S6161', 'ETJ-35W'];
const may20 = [];
for (const label of labels) {
  const lines = await sb(
    `/rest/v1/order_line_items?select=sku,orders(order_number,partner_order_id)&order_id=eq.${label.order_id}&limit=20`,
  );
  const hit = (lines || []).find((l) =>
    friendlySkus.some((s) => String(l.sku || '').toUpperCase().startsWith(s.toUpperCase())),
  );
  if (!hit) continue;
  may20.push({
    shipped: label.shipped_at,
    orderNumber: hit.orders?.order_number || hit.orders?.partner_order_id,
    sku: hit.sku,
    carrier: label.carrier,
    service: label.service_level,
    cost: label.label_shipping_cost,
    tracking: label.tracking_number,
  });
}
console.log('Friendly SKU shipments on May 20:');
console.log(JSON.stringify(may20, null, 2));

// Duty probe for SMI3000 @ $10.08 with shipDate 2026-05-20
const shipment = {
  orderNumber: 'MAY20-DUTY-CHECK',
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
    name: 'Invoice Check',
    address1: '1 Harborside Dr',
    city: 'Boston',
    state: 'MA',
    postalCode: '02128',
    country: 'US',
    phone: '6175550100',
    is_residential: true,
  },
  packages: [
    {
      name: 'SMI3000',
      weightLbs: 11.3,
      lengthIn: 21.5,
      widthIn: 18.25,
      heightIn: 4.25,
      package_contents: 'Iron Motorcycle Lift Stands',
    },
  ],
  items: [
    {
      title: 'Iron Motorcycle Lift Stands',
      sku: 'SMI3000',
      quantity: 1,
      value: 10.08,
      currency: 'USD',
      hs_code: '8425.49.00.00',
      country_of_origin: 'CA',
      customs_description: 'Iron Motorcycle Lift Stands',
    },
  ],
};

async function upsDutyOnDate(shipDate) {
  assertUpsQuoteCredentials();
  const body = buildUpsLandedCostBody(shipment);
  body.shipment.shipDate = shipDate;
  const hdrs = {
    ...(await upsQuoteHeaders(10000)),
    AccountNumber: upsAccountNumber(),
  };
  const res = await fetch(upsLandedCostUrl(), {
    method: 'POST',
    headers: hdrs,
    body: JSON.stringify(body),
  });
  const raw = await res.json();
  if (!res.ok) return { error: JSON.stringify(raw).slice(0, 400) };
  const n = normalizeUpsLandedCost(raw);
  return {
    shipDate,
    totalDuties: n.totalDuties,
    totalDutyAndTax: n.totalDutyAndTax,
    listBrokerage: n.totalBrokerageFees,
    items: n.items,
    feeItems: n.brokerageFeeItems,
  };
}

const [stallion, zonos, upsMay20, upsToday] = await Promise.all([
  quoteStallion(shipment),
  quoteZonosLandedCost(shipment, {
    shipping: 28.79,
    currency: 'CAD',
    serviceCode: 'USA.EP',
    serviceName: 'Expedited Parcel USA',
  }),
  upsDutyOnDate('2026-05-20'),
  upsDutyOnDate('2026-08-12'),
]);

// Also try SMI6010 standard customs if useful
const smi6010 = structuredClone(shipment);
smi6010.orderNumber = 'MAY20-SMI6010';
smi6010.items[0] = {
  title: 'Iron Motorcycle Lift Stands',
  sku: 'SMI6010',
  quantity: 1,
  value: 18.88,
  currency: 'USD',
  hs_code: '8425.49.00.00',
  country_of_origin: 'CA',
  customs_description: 'Iron Motorcycle Lift Stands',
};
smi6010.packages[0] = {
  name: 'SMI6010',
  weightLbs: 19,
  lengthIn: 21,
  widthIn: 18.25,
  heightIn: 4,
  package_contents: 'Iron Motorcycle Lift Stands',
};

async function upsDutyShipment(s, shipDate) {
  assertUpsQuoteCredentials();
  const body = buildUpsLandedCostBody(s);
  body.shipment.shipDate = shipDate;
  const hdrs = {
    ...(await upsQuoteHeaders(10000)),
    AccountNumber: upsAccountNumber(),
  };
  const res = await fetch(upsLandedCostUrl(), {
    method: 'POST',
    headers: hdrs,
    body: JSON.stringify(body),
  });
  const raw = await res.json();
  if (!res.ok) return { error: JSON.stringify(raw).slice(0, 300) };
  const n = normalizeUpsLandedCost(raw);
  return { shipDate, totalDutyAndTax: n.totalDutyAndTax, totalDuties: n.totalDuties };
}

const [stallion6010, zonos6010, ups6010May20] = await Promise.all([
  quoteStallion(smi6010),
  quoteZonosLandedCost(smi6010, {
    shipping: 36.73,
    currency: 'CAD',
    serviceCode: 'USA.EP',
    serviceName: 'Expedited Parcel USA',
  }),
  upsDutyShipment(smi6010, '2026-05-20'),
]);

console.log('\n=== DUTY AS OF 2026-05-20 ===');
console.log('\nSMI3000 customs $10.08 HS 8425.49.00.00');
console.log(
  JSON.stringify(
    {
      stallion: stallion.rates?.[0]?.duty ?? stallion.message ?? null,
      ups_shipDate_2026_05_20: upsMay20,
      ups_shipDate_today: upsToday,
      ups_disbursement_flat: UPS_DISBURSEMENT_FEE_CAD,
      zonos: {
        duties: zonos.duties,
        fees: zonos.clearanceFees ?? zonos.fees,
        importCharges: zonos.importCharges,
        dutyItems: zonos.dutyItems,
        feeItems: zonos.clearanceFeeItems || zonos.feeItems,
      },
    },
    null,
    2,
  ),
);

console.log('\nSMI6010 customs $18.88 HS 8425.49.00.00');
console.log(
  JSON.stringify(
    {
      stallion: stallion6010.rates?.[0]?.duty ?? stallion6010.message ?? null,
      ups_shipDate_2026_05_20: ups6010May20,
      zonos: {
        duties: zonos6010.duties,
        fees: zonos6010.clearanceFees ?? zonos6010.fees,
        importCharges: zonos6010.importCharges,
        dutyItems: zonos6010.dutyItems,
      },
    },
    null,
    2,
  ),
);
