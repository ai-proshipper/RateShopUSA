import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveShipHeroAccessToken,
  shipheroGraphqlRequest,
} from '../../ShippingTracking/scripts/lib/shiphero-auth.mjs';
import { quoteUps } from '../src/ups-quote.js';
import {
  UPS_DISBURSEMENT_FEE_CAD,
  UPS_QUOTE_TIMEOUT_MS,
} from '../src/ups-config.js';

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

const orderNumber = String(process.argv[2] || '')
  .trim()
  .replace(/^#/, '');
if (!orderNumber) {
  console.error('Usage: node scripts/probe-ups-order.mjs <order-number>');
  process.exit(2);
}

const escaped = orderNumber.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const QUERY = `
query {
  orders(order_number: "${escaped}") {
    data(first: 1) {
      edges {
        node {
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
            address {
              name
              address1
              address2
              city
              state
              country
              zip
              phone
            }
            shipping_labels {
              box_name
              cost
              carrier
              shipping_method
              tracking_number
              dimensions {
                weight
                length
                width
                height
              }
            }
          }
        }
      }
    }
  }
}
`;

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

function buildShipment(order) {
  const addr = order.shipping_address || {};
  const name = [addr.first_name, addr.last_name].filter(Boolean).join(' ').trim();
  const label = order.shipments?.[0]?.shipping_labels?.[0] || null;
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

  if (!packageInfo.weightLbs || !packageInfo.lengthIn || !packageInfo.widthIn || !packageInfo.heightIn) {
    throw new Error(
      'Order is missing packed weight/dims (need a ShipHero label or packed dims)',
    );
  }

  const lineNodes = (order.line_items?.edges || []).map((e) => e.node).filter(Boolean);
  const items = [];
  for (const line of lineNodes) {
    const sku = String(line.sku || '').trim();
    // Prefer sellable/parent lines with positive warehouse customs.
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

  // If kit parent + components both have customs, keep only highest-value line
  // when SKUs look like kit expansions (parent contains '+').
  const kitParents = items.filter((i) => String(i.sku || '').includes('+'));
  const selectedItems = kitParents.length ? kitParents : items;
  if (!selectedItems.length) {
    throw new Error('No line items with customs value, HS code, and origin');
  }

  packageInfo.package_contents = selectedItems
    .map((i) => i.customs_description)
    .filter(Boolean)[0] || 'Merchandise';

  return {
    orderNumber: order.order_number || orderNumber,
    currency: 'CAD',
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
      name: name || order.shipments?.[0]?.address?.name || 'Recipient',
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
    _shipheroLabel: label
      ? {
          carrier: label.carrier,
          method: label.shipping_method,
          cost: label.cost,
          tracking: label.tracking_number,
        }
      : null,
  };
}

const { accessToken, refreshToken } = await resolveShipHeroAccessToken();
const { json } = await shipheroGraphqlRequest(accessToken, QUERY, {
  refreshToken,
});
const order = json?.data?.orders?.data?.edges?.[0]?.node;
if (!order) {
  console.error(JSON.stringify({ found: false, orderNumber }, null, 2));
  process.exit(1);
}

const shipment = buildShipment(order);
const samplePath = resolve(
  root,
  'samples',
  `order-${orderNumber.replace(/[^\w.-]+/g, '_')}.json`,
);
const { _shipheroLabel, ...shipmentOut } = shipment;
writeFileSync(samplePath, JSON.stringify(shipmentOut, null, 2));

console.log(`Order ${shipment.orderNumber}`);
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
if (_shipheroLabel) {
  console.log(
    `Existing label: ${_shipheroLabel.carrier} method ${_shipheroLabel.method} cost $${_shipheroLabel.cost} (${_shipheroLabel.tracking})`,
  );
}

const result = await quoteUps(shipmentOut, UPS_QUOTE_TIMEOUT_MS);
console.log('\nService                         Shipping      Duty  Disburse   Import     Landed');
console.log('-'.repeat(90));
for (const rate of result.rates) {
  const service = String(rate.serviceName).padEnd(31).slice(0, 31);
  const shipping = `$${rate.shipping.toFixed(2)}`.padStart(9);
  const duty =
    rate.duty == null ? '—'.padStart(9) : `$${rate.duty.toFixed(2)}`.padStart(9);
  const fee =
    rate.brokerage == null ? '—'.padStart(9) : `$${rate.brokerage.toFixed(2)}`.padStart(9);
  const imports =
    rate.importCharges == null
      ? '—'.padStart(9)
      : `$${rate.importCharges.toFixed(2)}`.padStart(9);
  const landed =
    rate.landedTotal == null
      ? '—'.padStart(9)
      : `$${rate.landedTotal.toFixed(2)}`.padStart(9);
  console.log(`${service} ${shipping} ${duty} ${fee} ${imports} ${landed}`);
}
console.log(`\nStatus: ${result.status}`);
if (result.zonosDuty?.status !== 'ok') {
  console.warn(
    `Zonos duties ${result.zonosDuty?.status || 'unavailable'}: ` +
      `${result.zonosDuty?.error || 'Canada Post Zonos duties unavailable'}`,
  );
} else {
  const zd = result.zonosDuty;
  const quoted = result.rates.find((rate) => rate.importCharges != null);
  console.log(
    `Quote import charges: Zonos duties $${zd.duties.toFixed(2)} ` +
      `(CP ${zd.sourceService || 'rate'}) ` +
      `+ disbursement $${UPS_DISBURSEMENT_FEE_CAD.toFixed(2)}` +
      (quoted
        ? ` = $${quoted.importCharges.toFixed(2)} ${quoted.landedCurrency}`
        : ''),
  );
}
console.log(`Saved sample: ${samplePath}`);
