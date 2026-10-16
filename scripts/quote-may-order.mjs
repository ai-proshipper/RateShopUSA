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
const trackingHint = process.argv[3] || '1ZAC88906713596467';

const { accessToken, refreshToken } = await resolveShipHeroAccessToken();
const q = `query {
  orders(order_number: "${orderNumber.replace(/"/g, '\\"')}") {
    data(first: 1) {
      edges {
        node {
          order_number
          expected_weight_in_oz
          shipping_address {
            first_name last_name company address1 address2 city state state_code zip country phone
          }
          line_items(first: 50) {
            edges {
              node {
                sku quantity product_name customs_value price
                product {
                  customs_description tariff_code country_of_manufacture customs_value
                  warehouse_products { customs_value }
                }
              }
            }
          }
          shipments {
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
if (!order) {
  console.error('Order not found', orderNumber);
  process.exit(1);
}

const labels = (order.shipments || []).flatMap((s) => s.shipping_labels || []);
const label =
  labels.find((l) => l.tracking_number === trackingHint) ||
  labels.find((l) => String(l.carrier || '').toLowerCase().includes('ups')) ||
  labels[0];

function parseDim(raw) {
  const m = String(raw || '').match(/([\d.]+)/);
  return m ? Number(m[1]) : null;
}
function parseWeightLbs(raw, fallbackOz) {
  const text = String(raw || '');
  const m = text.match(/([\d.]+)/);
  if (m) {
    const n = Number(m[1]);
    if (text.toLowerCase().includes('oz')) return n / 16;
    return n;
  }
  const oz = Number(fallbackOz);
  return Number.isFinite(oz) && oz > 0 ? oz / 16 : null;
}
function warehouseCustoms(product) {
  for (const row of product?.warehouse_products || []) {
    const v = Number(row?.customs_value);
    if (Number.isFinite(v) && v > 0) return v;
  }
  const top = Number(product?.customs_value);
  return Number.isFinite(top) && top > 0 ? top : null;
}

const lines = (order.line_items?.edges || []).map((e) => e.node);
const itemNode =
  lines.find((l) => l.sku === 'SMI3000') ||
  lines.find((l) => String(l.sku || '').startsWith('SMI')) ||
  lines[0];
const customs =
  Number(itemNode.customs_value) > 0
    ? Number(itemNode.customs_value)
    : warehouseCustoms(itemNode.product);
const hsDigits = String(itemNode.product?.tariff_code || '8425490000').replace(/\D/g, '');
const hs =
  hsDigits.length >= 10
    ? `${hsDigits.slice(0, 4)}.${hsDigits.slice(4, 6)}.${hsDigits.slice(6, 8)}.${hsDigits.slice(8, 10)}`
    : '8425.49.00.00';

const dims = label?.dimensions || {};
const weightLbs = parseWeightLbs(dims.weight, order.expected_weight_in_oz);
const lengthIn = parseDim(dims.length) || 21.5;
const widthIn = parseDim(dims.width) || 18.25;
const heightIn = parseDim(dims.height) || 4.25;

const addr = order.shipping_address;
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
      name: label?.box_name || 'Package 1',
      weightLbs,
      lengthIn,
      widthIn,
      heightIn,
      package_contents: String(
        itemNode.product?.customs_description || itemNode.product_name || 'Merchandise',
      ).slice(0, 100),
    },
  ],
  items: [
    {
      title: String(itemNode.product_name || itemNode.sku).slice(0, 80),
      sku: itemNode.sku,
      quantity: Math.max(1, Number(itemNode.quantity) || 1),
      value: customs,
      currency: 'USD',
      hs_code: hs,
      country_of_origin: String(itemNode.product?.country_of_manufacture || 'CA')
        .slice(0, 2)
        .toUpperCase(),
      customs_description: String(
        itemNode.product?.customs_description || itemNode.product_name || 'Merchandise',
      ).slice(0, 100),
    },
  ],
};

const samplePath = resolve(
  root,
  'samples',
  `order-${orderNumber.replace(/[^\w.-]+/g, '_')}-may-invoice-check.json`,
);
writeFileSync(samplePath, JSON.stringify(shipment, null, 2));

const [stallion, ups, cp] = await Promise.all([
  quoteStallion(shipment),
  quoteUps(shipment),
  quoteCanadaPostUs(shipment),
]);

console.log(
  JSON.stringify(
    {
      orderNumber,
      shippedLabel: label
        ? {
            carrier: label.carrier,
            method: label.shipping_method,
            cost: label.cost,
            tracking: label.tracking_number,
          }
        : null,
      to: `${shipment.to.city}, ${shipment.to.state} ${shipment.to.postalCode}`,
      pkg: `${weightLbs} lb ${lengthIn}x${widthIn}x${heightIn}`,
      item: shipment.items[0],
      samplePath,
      mayCandidatesAlso: [
        {
          order: '112-1408947-9707436',
          shipped: '2026-05-19',
          sku: 'SMI3000',
          ups: '08 $28.79',
          tracking: '1ZAC88906713596467',
        },
        {
          order: '111-1453041-6057866',
          shipped: '2026-05-25',
          sku: 'SMI3000',
          ups: '08 $32.19',
          tracking: '1ZAC88906738178961',
        },
      ],
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
