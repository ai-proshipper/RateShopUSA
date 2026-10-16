/**
 * Lookup ShipHero order by UPS tracking, then quote Stallion / UPS / Canada Post+Zonos.
 * Rates only — no labels.
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
import { UPS_DISBURSEMENT_FEE_CAD, UPS_QUOTE_TIMEOUT_MS } from '../src/ups-config.js';
import { CANADA_POST_QUOTE_TIMEOUT_MS } from '../src/canada-post-config.js';
import { QUOTE_TIMEOUT_MS } from '../src/config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile(resolve(root, '..', 'ShippingTracking', '.env'));
loadEnvFile(resolve(root, '..', 'RateShopping', '.env'));
loadEnvFile(resolve(root, '.env'));

const tracking = String(process.argv[2] || '').trim();
if (!tracking) {
  console.error('Usage: node scripts/probe-tracking-all.mjs <tracking-number>');
  process.exit(2);
}

function esc(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function parseDim(raw, unitHint) {
  const text = String(raw || '').trim();
  const match = text.match(/([\d.]+)/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const lower = text.toLowerCase();
  if (unitHint === 'weight') {
    if (lower.includes('oz')) return { weightLbs: n / 16 };
    return { weightLbs: n };
  }
  return n;
}

function warehouseCustoms(product) {
  const rows = product?.warehouse_products || [];
  for (const row of rows) {
    const v = Number(row?.customs_value);
    if (Number.isFinite(v) && v > 0) return v;
  }
  const top = Number(product?.customs_value);
  if (Number.isFinite(top) && top > 0) return top;
  return null;
}

function normalizeHs(code) {
  return String(code || '').replace(/\D/g, '');
}

function formatHs(code) {
  const d = normalizeHs(code);
  if (d.length >= 10) {
    return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}.${d.slice(8, 10)}`;
  }
  return code || null;
}

function money(v) {
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

const TRACKING_QUERY = `
query {
  shipments(tracking_number: "${esc(tracking)}") {
    data(first: 5) {
      edges {
        node {
          id
          legacy_id
          created_date
          order_id
          shipping_labels {
            tracking_number
            carrier
            shipping_method
            cost
            box_name
            dimensions { weight length width height }
          }
        }
      }
    }
  }
}
`;

function orderQuery(orderId) {
  return `
query {
  order(id: "${esc(orderId)}") {
    data {
      id
      legacy_id
      order_number
      currency
      expected_weight_in_oz
      shipping_address {
        first_name
        last_name
        company
        address1
        address2
        city
        state
        state_code
        zip
        country
        phone
      }
      line_items(first: 50) {
        edges {
          node {
            sku
            quantity
            product_name
            price
            customs_value
            product {
              name
              customs_description
              tariff_code
              country_of_manufacture
              customs_value
              warehouse_products {
                warehouse_id
                customs_value
                value
                price
              }
            }
          }
        }
      }
      shipments {
        shipping_labels {
          tracking_number
          carrier
          shipping_method
          cost
          box_name
          dimensions { weight length width height }
        }
      }
    }
  }
}
`;
}

function buildShipment(order, label) {
  const addr = order.shipping_address || {};
  const name = [addr.first_name, addr.last_name].filter(Boolean).join(' ').trim();
  const dims = label?.dimensions || {};
  const weightFromLabel = parseDim(dims.weight, 'weight');
  const lengthIn = parseDim(dims.length);
  const widthIn = parseDim(dims.width);
  const heightIn = parseDim(dims.height);
  const expectedOz = Number(order.expected_weight_in_oz);

  const packageInfo = {
    name: label?.box_name || 'Package 1',
    weightLbs:
      weightFromLabel?.weightLbs ||
      (Number.isFinite(expectedOz) && expectedOz > 0 ? expectedOz / 16 : null),
    lengthIn,
    widthIn,
    heightIn,
    package_contents: 'Merchandise',
  };

  if (
    !packageInfo.weightLbs ||
    !packageInfo.lengthIn ||
    !packageInfo.widthIn ||
    !packageInfo.heightIn
  ) {
    throw new Error('Missing packed weight/dims on label');
  }

  const lineNodes = (order.line_items?.edges || []).map((e) => e.node).filter(Boolean);
  const items = [];
  for (const line of lineNodes) {
    const sku = String(line.sku || '').trim();
    const value =
      Number(line.customs_value) > 0
        ? Number(line.customs_value)
        : warehouseCustoms(line.product);
    if (!value) continue;
    const hs = normalizeHs(line.product?.tariff_code);
    const origin = String(line.product?.country_of_manufacture || '')
      .trim()
      .slice(0, 2)
      .toUpperCase();
    if (!hs || !origin) continue;
    items.push({
      title: line.product_name || line.product?.name || sku || 'Merchandise',
      sku: sku || undefined,
      quantity: Math.max(1, Number(line.quantity) || 1),
      value,
      currency: 'USD',
      hs_code: hs,
      country_of_origin: origin,
      customs_description:
        line.product?.customs_description ||
        line.product_name ||
        'Merchandise',
    });
  }

  const kitParents = items.filter((i) => String(i.sku || '').includes('+'));
  const selectedItems = kitParents.length ? kitParents : items;
  if (!selectedItems.length) {
    throw new Error('No line items with customs value, HS code, and origin');
  }

  packageInfo.package_contents =
    selectedItems.map((i) => i.customs_description).filter(Boolean)[0] ||
    'Merchandise';

  return {
    orderNumber: order.order_number,
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
      name: name || 'Recipient',
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
    packages: [packageInfo],
    items: selectedItems,
  };
}

const { accessToken, refreshToken } = await resolveShipHeroAccessToken();
const trackRes = await shipheroGraphqlRequest(accessToken, TRACKING_QUERY, {
  refreshToken,
});
const shipNode = trackRes.json?.data?.shipments?.data?.edges?.[0]?.node;
if (!shipNode) {
  console.error(JSON.stringify({ found: false, tracking }, null, 2));
  process.exit(1);
}

const label =
  (shipNode.shipping_labels || []).find((l) => l.tracking_number === tracking) ||
  shipNode.shipping_labels?.[0];

const orderId = shipNode.order_id;
if (!orderId) {
  console.error('Shipment found but missing order_id');
  console.error(JSON.stringify(shipNode, null, 2));
  process.exit(1);
}

const orderRes = await shipheroGraphqlRequest(accessToken, orderQuery(orderId), {
  refreshToken,
});
const order = orderRes.json?.data?.order?.data;
if (!order) {
  console.error('Order not found for', orderId);
  process.exit(1);
}

const shipment = buildShipment(order, label);
const samplePath = resolve(
  root,
  'samples',
  `order-${String(order.order_number).replace(/[^\w.-]+/g, '_')}.json`,
);
writeFileSync(samplePath, JSON.stringify(shipment, null, 2));

const stallionShipment = structuredClone(shipment);
for (const item of stallionShipment.items) {
  item.hs_code = formatHs(item.hs_code);
}

console.log(`Tracking: ${tracking}`);
console.log(`Order: ${order.order_number} (${orderId})`);
console.log(
  `Ship: ${shipment.from.city}, ${shipment.from.state} → ${shipment.to.city}, ${shipment.to.state} ${shipment.to.postalCode}`,
);
console.log(
  `Package: ${shipment.packages[0].weightLbs} lb, ${shipment.packages[0].lengthIn}x${shipment.packages[0].widthIn}x${shipment.packages[0].heightIn} in`,
);
for (const item of shipment.items) {
  console.log(
    `Item: ${item.sku} qty ${item.quantity} customs $${item.value} HS ${item.hs_code} origin ${item.country_of_origin}`,
  );
}
if (label) {
  console.log(
    `Existing label: ${label.carrier} method ${label.shipping_method} cost $${label.cost}`,
  );
}
console.log(`Saved: ${samplePath}`);
console.log(`UPS disbursement flat: $${UPS_DISBURSEMENT_FEE_CAD.toFixed(2)}`);

const [stallion, ups, canadaPost] = await Promise.all([
  quoteStallion(stallionShipment, QUOTE_TIMEOUT_MS),
  quoteUps(shipment, UPS_QUOTE_TIMEOUT_MS),
  quoteCanadaPostUs(shipment, CANADA_POST_QUOTE_TIMEOUT_MS),
]);

console.log('\n========== STALLION ==========');
console.log(`Status: ${stallion.status}${stallion.message ? ` — ${stallion.message}` : ''}`);
if (stallion.rates?.length) {
  for (const r of stallion.rates) {
    console.log(
      `${String(r.service_name || r.service).padEnd(28)} total $${r.total}  duty $${r.duty}  duty_tax $${r.duty_tax}  tax $${r.tax}  ${r.currency}`,
    );
  }
} else {
  console.log('No rates');
}

console.log('\n========== UPS ==========');
console.log(`Status: ${ups.status}`);
if (ups.landedCost?.error) console.log(`Landed Cost: ${ups.landedCost.error}`);
if (ups.rates?.length) {
  for (const r of ups.rates) {
    console.log(
      `${String(r.serviceName).padEnd(28)} ship $${r.shipping}  duty/tax $${r.dutyAndTax}  disburse $${r.brokerage}  landed $${r.landedTotal}`,
    );
  }
}
if (ups.landedCost?.status === 'ok' || ups.landedCost?.status === 'partial') {
  const lc = ups.landedCost;
  console.log(
    `UPS LC: duties $${lc.totalDuties} duty/tax $${lc.totalDutyAndTax} listBrokerage $${lc.totalBrokerageFees}`,
  );
  if (lc.brokerageFeeItems?.length) {
    console.log(
      'List fees: ' +
        lc.brokerageFeeItems.map((f) => `${f.name} $${f.amount}`).join(', '),
    );
  }
  if (lc.items?.length) {
    for (const it of lc.items) {
      console.log(
        `  item ${it.commodityId} HS ${it.hsCode} duty $${it.duty} duty+tax $${it.dutyAndTax}`,
      );
    }
  }
}

console.log('\n========== CANADA POST + ZONOS ==========');
console.log(
  `Status: ${canadaPost.status}${canadaPost.ratingError ? ` — ${canadaPost.ratingError}` : ''}`,
);
if (canadaPost.rates?.length) {
  for (const r of canadaPost.rates) {
    console.log(
      `${String(r.serviceName || r.serviceCode).padEnd(36)} ship $${r.shipping}  duty $${r.duty}  taxes $${r.taxes}  fees $${r.fees}  import $${r.importCharges}  landed $${r.landedTotal}${r.landedError ? `  ERR ${r.landedError}` : ''}`,
    );
  }
  const withDuty = canadaPost.rates.find((r) => r.duty != null);
  if (withDuty?.feeItems?.length) {
    console.log('Zonos fee items (first service with duty):');
    for (const f of withDuty.feeItems) {
      console.log(`  ${f.description || f.type}: $${f.amount} (${f.formula || ''})`);
    }
  }
  const zRaw = withDuty?.zonosRaw;
  const wf = zRaw?.data?.landedCostCalculateWorkflow;
  const landed = Array.isArray(wf) ? wf[0] : null;
  const duties = landed?.dutiesTaxesFees || [];
  if (duties.length) {
    console.log('Zonos duty/tax lines:');
    for (const d of duties) {
      if (String(d?.type || '').toLowerCase().includes('fee')) continue;
      console.log(
        `  ${d.note || d.description || d.type}: $${d.amount} (${d.formula || ''})`,
      );
    }
  }
} else {
  console.log('No rates');
}

console.log('\n========== DUTY COMPARISON ==========');
const stallionDuty = money(stallion.rates?.[0]?.duty);
const upsDuty = money(ups.landedCost?.totalDutyAndTax);
const zonosDuty = money(canadaPost.rates?.find((r) => r.duty != null)?.duty);
console.log(
  `Stallion duty:     ${stallionDuty == null ? 'n/a' : '$' + stallionDuty.toFixed(2)}`,
);
console.log(
  `UPS duty/tax:      ${upsDuty == null ? 'n/a' : '$' + upsDuty.toFixed(2)}  (brokerage ignored; +$${UPS_DISBURSEMENT_FEE_CAD} flat)`,
);
console.log(
  `Zonos (via CP):    ${zonosDuty == null ? 'n/a' : '$' + zonosDuty.toFixed(2)}`,
);
