import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveShipHeroAccessToken,
  shipheroGraphqlRequest,
} from '../../ShippingTracking/scripts/lib/shiphero-auth.mjs';
import { quoteStallion } from '../src/stallion-rate.js';
import { buildUpsLandedCostBody, normalizeUpsLandedCost } from '../src/ups-landed-cost.js';
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

const orderNumber = '111-8209310-3352207';
const { accessToken, refreshToken } = await resolveShipHeroAccessToken();
const q = `query { orders(order_number: "${orderNumber}") { data(first:1){ edges{ node{
  order_number expected_weight_in_oz
  line_items(first:20){ edges{ node{ sku quantity product_name customs_value
    product { customs_description tariff_code country_of_manufacture customs_value warehouse_products { customs_value } }
  }}}
  shipments { shipping_labels { tracking_number carrier shipping_method cost box_name dimensions { weight length width height } } }
}}}}}`;
const { json } = await shipheroGraphqlRequest(accessToken, q, { refreshToken });
const order = json?.data?.orders?.data?.edges?.[0]?.node;
const label = (order?.shipments || [])
  .flatMap((s) => s.shipping_labels || [])
  .find((l) => l.tracking_number === '1ZAC88906733682611') ||
  order?.shipments?.[0]?.shipping_labels?.[0];

function warehouseCustoms(product) {
  for (const row of product?.warehouse_products || []) {
    const v = Number(row?.customs_value);
    if (v > 0) return v;
  }
  const top = Number(product?.customs_value);
  return top > 0 ? top : null;
}
function parseNum(raw) {
  const m = String(raw || '').match(/([\d.]+)/);
  return m ? Number(m[1]) : null;
}
function weightLbs(raw, fallbackOz) {
  const text = String(raw || '');
  const m = text.match(/([\d.]+)/);
  if (m) {
    const n = Number(m[1]);
    return text.toLowerCase().includes('oz') ? n / 16 : n;
  }
  const oz = Number(fallbackOz);
  return oz > 0 ? oz / 16 : 19;
}

const line =
  (order?.line_items?.edges || []).map((e) => e.node).find((n) => n.sku === 'SMI6010') ||
  order?.line_items?.edges?.[0]?.node;
const customs =
  Number(line?.customs_value) > 0
    ? Number(line.customs_value)
    : warehouseCustoms(line?.product) || 18.88;
const dims = label?.dimensions || {};

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
  // May addresses scrubbed — placeholder for rates; duty is the invoice check target
  to: {
    name: 'Invoice Check',
    address1: '1 Harborside Dr',
    city: 'Boston',
    state: 'MA',
    postalCode: '02128',
    country: 'US',
    is_residential: true,
  },
  packages: [
    {
      name: label?.box_name || 'SMI6010',
      weightLbs: weightLbs(dims.weight, order?.expected_weight_in_oz),
      lengthIn: parseNum(dims.length) || 21,
      widthIn: parseNum(dims.width) || 18.25,
      heightIn: parseNum(dims.height) || 4,
      package_contents: 'Iron Motorcycle Lift Stands',
    },
  ],
  items: [
    {
      title: 'Iron Motorcycle Lift Stands',
      sku: 'SMI6010',
      quantity: 1,
      value: customs,
      currency: 'USD',
      hs_code: '8425.49.00.00',
      country_of_origin: 'CA',
      customs_description: 'Iron Motorcycle Lift Stands',
    },
  ],
};

writeFileSync(
  resolve(root, 'samples', `order-${orderNumber}-may20-invoice-check.json`),
  JSON.stringify(shipment, null, 2),
);

async function upsOnDate(shipDate) {
  assertUpsQuoteCredentials();
  const body = buildUpsLandedCostBody(shipment);
  body.shipment.shipDate = shipDate;
  const headers = {
    ...(await upsQuoteHeaders(10000)),
    AccountNumber: upsAccountNumber(),
  };
  const res = await fetch(upsLandedCostUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const raw = await res.json();
  if (!res.ok) return { error: JSON.stringify(raw).slice(0, 300) };
  const n = normalizeUpsLandedCost(raw);
  return {
    shipDate,
    totalDuties: n.totalDuties,
    totalDutyAndTax: n.totalDutyAndTax,
    items: n.items,
  };
}

const [stallion, zonos, upsMay20, upsToday] = await Promise.all([
  quoteStallion(shipment),
  quoteZonosLandedCost(shipment, {
    shipping: Number(label?.cost) || 38.53,
    currency: 'CAD',
    serviceCode: 'USA.EP',
    serviceName: 'Expedited Parcel USA',
  }),
  upsOnDate('2026-05-20'),
  upsOnDate('2026-08-12'),
]);

console.log(
  JSON.stringify(
    {
      orderNumber,
      shipped: '2026-05-20',
      label: {
        carrier: label?.carrier,
        method: label?.shipping_method,
        cost: label?.cost,
        tracking: label?.tracking_number,
      },
      item: shipment.items[0],
      pkg: shipment.packages[0],
      note: 'ShipHero May address scrubbed; placeholder Boston MA used for quoting',
      duties: {
        stallion: stallion.rates?.[0]?.duty ?? null,
        ups_on_2026_05_20: upsMay20.totalDutyAndTax ?? upsMay20.error,
        ups_on_today: upsToday.totalDutyAndTax ?? upsToday.error,
        zonos: zonos.duties,
        upsDisbursementFlat: UPS_DISBURSEMENT_FEE_CAD,
      },
      upsMay20Detail: upsMay20,
      zonosDetail: {
        duties: zonos.duties,
        fees: zonos.clearanceFees ?? zonos.fees,
        importCharges: zonos.importCharges,
        dutyItems: zonos.dutyItems,
        feeItems: zonos.clearanceFeeItems || zonos.feeItems,
      },
      stallionRates: (stallion.rates || []).map((r) => ({
        service: r.service_name,
        base: r.base_rate,
        duty: r.duty,
        total: r.total,
      })),
    },
    null,
    2,
  ),
);
