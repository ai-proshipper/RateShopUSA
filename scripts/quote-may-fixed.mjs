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

const orderNumber = process.argv[2] || '112-1408947-9707436';
const { accessToken, refreshToken } = await resolveShipHeroAccessToken();
const q = `query {
  orders(order_number: "${orderNumber}") {
    data(first: 1) {
      edges {
        node {
          order_number
          expected_weight_in_oz
          shipping_address {
            first_name last_name company address1 address2 city state state_code zip country phone
          }
          line_items(first: 20) {
            edges {
              node {
                sku quantity product_name customs_value
                product {
                  customs_description tariff_code country_of_manufacture customs_value
                  warehouse_products { customs_value }
                }
              }
            }
          }
          shipments {
            address { name address1 address2 city state country zip phone }
            shipping_labels {
              tracking_number carrier shipping_method cost box_name
              dimensions { weight length width height }
            }
          }
        }
      }
    }
  }
}`;
const { json } = await shipheroGraphqlRequest(accessToken, q, { refreshToken });
const order = json?.data?.orders?.data?.edges?.[0]?.node;
console.log('RAW_ADDRESS', JSON.stringify({
  shipping_address: order?.shipping_address,
  shipment0: order?.shipments?.[0]?.address,
  labels: order?.shipments?.[0]?.shipping_labels,
}, null, 2));

const shipAddr = order.shipments?.[0]?.address;
const billAddr = order.shipping_address;
const addr = {
  name:
    shipAddr?.name ||
    [billAddr?.first_name, billAddr?.last_name].filter(Boolean).join(' ') ||
    'Recipient',
  address1: shipAddr?.address1 || billAddr?.address1 || '',
  city: shipAddr?.city || billAddr?.city || '',
  state: shipAddr?.state || billAddr?.state_code || billAddr?.state || '',
  postalCode: String(shipAddr?.zip || billAddr?.zip || '')
    .replace(/\s+/g, '')
    .split('-')[0],
  country: shipAddr?.country || billAddr?.country || 'US',
  phone: shipAddr?.phone || billAddr?.phone || undefined,
};

// Fix truncated zips if needed by leaving as-is; validate length
if (addr.country === 'US' && addr.postalCode && addr.postalCode.length < 5) {
  // try padded from raw
  const rawZip = String(shipAddr?.zip || billAddr?.zip || '');
  console.log('WARN short zip raw=', rawZip, 'parsed=', addr.postalCode);
}

const label =
  (order.shipments || [])
    .flatMap((s) => s.shipping_labels || [])
    .find((l) => String(l.carrier || '').toLowerCase().includes('ups')) ||
  order.shipments?.[0]?.shipping_labels?.[0];

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
  return oz > 0 ? oz / 16 : null;
}
function warehouseCustoms(product) {
  for (const row of product?.warehouse_products || []) {
    const v = Number(row?.customs_value);
    if (v > 0) return v;
  }
  const top = Number(product?.customs_value);
  return top > 0 ? top : null;
}

const line = (order.line_items?.edges || []).map((e) => e.node).find((n) => n.sku === 'SMI3000') ||
  order.line_items?.edges?.[0]?.node;
const customs =
  Number(line.customs_value) > 0
    ? Number(line.customs_value)
    : warehouseCustoms(line.product) || 10.08;

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
  to: {
    name: addr.name,
    address1: addr.address1,
    city: addr.city,
    state: addr.state,
    postalCode: addr.postalCode,
    country: 'US',
    phone: addr.phone,
    is_residential: true,
  },
  packages: [
    {
      name: label?.box_name || 'Package 1',
      weightLbs: weightLbs(dims.weight, order.expected_weight_in_oz) || 11.3,
      lengthIn: parseNum(dims.length) || 21.5,
      widthIn: parseNum(dims.width) || 18.25,
      heightIn: parseNum(dims.height) || 4.25,
      package_contents: 'Iron Motorcycle Lift Stands',
    },
  ],
  items: [
    {
      title: 'Iron Motorcycle Lift Stands',
      sku: line.sku || 'SMI3000',
      quantity: 1,
      value: customs,
      currency: 'USD',
      hs_code: '8425.49.00.00',
      country_of_origin: 'CA',
      customs_description: 'Iron Motorcycle Lift Stands',
    },
  ],
};

console.log('USING_TO', shipment.to);
writeFileSync(
  resolve(root, 'samples', `order-${orderNumber}-may-invoice-check.json`),
  JSON.stringify(shipment, null, 2),
);

const [stallion, ups, cp] = await Promise.all([
  quoteStallion(shipment),
  quoteUps(shipment),
  quoteCanadaPostUs(shipment),
]);

console.log(
  JSON.stringify(
    {
      orderNumber,
      label: label
        ? {
            carrier: label.carrier,
            method: label.shipping_method,
            cost: label.cost,
            tracking: label.tracking_number,
          }
        : null,
      to: `${shipment.to.city}, ${shipment.to.state} ${shipment.to.postalCode}`,
      pkg: `${shipment.packages[0].weightLbs} lb ${shipment.packages[0].lengthIn}x${shipment.packages[0].widthIn}x${shipment.packages[0].heightIn}`,
      item: shipment.items[0],
      duties: {
        stallion: stallion.rates?.[0]?.duty ?? null,
        ups: ups.landedCost?.totalDutyAndTax ?? null,
        zonos: cp.rates?.find((r) => r.duty != null)?.duty ?? null,
        upsDisbursement: UPS_DISBURSEMENT_FEE_CAD,
      },
      stallionStatus: stallion.status,
      stallionError: stallion.message || null,
      stallion: (stallion.rates || []).map((r) => ({
        service: r.service_name,
        base: r.base_rate,
        duty: r.duty,
        total: r.total,
      })),
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
