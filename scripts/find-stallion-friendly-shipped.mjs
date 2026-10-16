/**
 * Find a shipped US order whose SKU/HS is Stallion rates-friendly.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quoteStallion } from '../src/stallion-rate.js';
import { stallionBaseUrl, stallionToken } from '../src/config.js';

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

if (!url || !key) {
  console.error('Missing Supabase credentials');
  process.exit(2);
}

const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Accept-Profile': 'shiphero',
};

// Friendly SKUs / HS prefixes we already know work on Stallion rates
const FRIENDLY_SKUS = new Set(
  [
    'SMI6010',
    'ETJ-35W',
    'ETJ-35B',
    'T46B',
    'T45B',
    'T45A',
    'T44Z',
    'T44I',
  ].map((s) => s.toUpperCase()),
);
const FRIENDLY_HS_PREFIXES = ['842549', '630612', '8425.49', '6306.12'];

function normalizeHs(hs) {
  return String(hs || '').replace(/\D/g, '');
}

function isFriendly({ sku, hs }) {
  if (sku && FRIENDLY_SKUS.has(String(sku).toUpperCase())) return true;
  const digits = normalizeHs(hs);
  return (
    digits.startsWith('842549') ||
    digits.startsWith('630612') ||
    FRIENDLY_HS_PREFIXES.some((p) => String(hs || '').startsWith(p))
  );
}

async function sb(path) {
  const res = await fetch(`${url}${path}`, { headers });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

// Pull recent US UPS/CP labels and inspect raw package line items
const labels = await sb(
  '/rest/v1/shipping_labels?select=id,tracking_number,carrier,service_level,label_shipping_cost,shipped_at,order_id,raw_payload&or=(carrier.ilike.*ups*,carrier.ilike.*canada*,carrier.ilike.*cp*)&order=shipped_at.desc.nullslast&limit=200',
);

const hits = [];
for (const label of labels || []) {
  const pkg = label.raw_payload?.package || label.raw_payload?.packages?.[0];
  const to =
    label.raw_payload?.to_address ||
    label.raw_payload?.shipping_address ||
    label.raw_payload?.ship_to;
  const country = String(
    to?.country || to?.country_code || pkg?.country || '',
  ).toUpperCase();
  // Prefer US destinations; if country missing, still inspect
  if (country && country !== 'US' && country !== 'USA') continue;

  const lineItems = pkg?.line_items || label.raw_payload?.line_items || [];
  for (const li of lineItems) {
    const sku = li.sku || li.product_sku;
    const hs = li.tariff_code || li.hs_code || li.hts_code;
    if (!isFriendly({ sku, hs })) continue;
    hits.push({
      tracking: label.tracking_number,
      carrier: label.carrier,
      service: label.service_level,
      cost: label.label_shipping_cost,
      shipped_at: label.shipped_at,
      order_id: label.order_id,
      sku,
      hs,
      customs:
        Number(li.product_customs_value) > 0
          ? Number(li.product_customs_value)
          : Number(li.customs_value) > 0
            ? Number(li.customs_value)
            : Number(li.product_value) || null,
      origin: li.country_of_manufacture || li.country_of_origin || null,
      weight_oz: pkg?.weight_in_oz,
      dims: pkg
        ? `${pkg.length}x${pkg.width}x${pkg.height}`
        : null,
      to_city: to?.city,
      to_state: to?.state_code || to?.state,
      to_zip: to?.zip || to?.postal_code,
      country: country || 'US?',
    });
  }
}

console.log(`Scanned ${labels?.length || 0} labels; friendly hits: ${hits.length}`);
console.log(JSON.stringify(hits.slice(0, 20), null, 2));

if (!hits.length) {
  // Fallback: search Stallion-friendly SKUs via order_line_items join if available
  console.log('\nNo raw_payload hits. Trying order_line_items by SKU...');
  for (const sku of FRIENDLY_SKUS) {
    const rows = await sb(
      `/rest/v1/order_line_items?select=sku,quantity,order_id,orders(order_number,partner_order_id)&sku=eq.${encodeURIComponent(sku)}&limit=5`,
    ).catch((e) => {
      console.log('line_items query fail', e.message);
      return [];
    });
    if (rows?.length) {
      console.log(sku, JSON.stringify(rows, null, 2));
    }
  }
  process.exit(1);
}

// Resolve order numbers for top hits and try Stallion quote on first success
const tried = [];
for (const hit of hits.slice(0, 15)) {
  const orders = await sb(
    `/rest/v1/orders?select=id,order_number,partner_order_id,shiphero_id&id=eq.${hit.order_id}&limit=1`,
  );
  const order = orders?.[0];
  const orderNumber = order?.order_number || order?.partner_order_id;
  if (!orderNumber) continue;

  // Build minimal shipment from raw payload on matching label
  const label = (labels || []).find((l) => l.tracking_number === hit.tracking);
  const pkg = label?.raw_payload?.package || {};
  const to =
    label?.raw_payload?.to_address ||
    label?.raw_payload?.shipping_address ||
    {};
  const li =
    (pkg.line_items || []).find((x) => x.sku === hit.sku) ||
    (pkg.line_items || [])[0];
  if (!li || !pkg.length || !pkg.weight_in_oz) {
    tried.push({ orderNumber, tracking: hit.tracking, skip: 'missing dims/item' });
    continue;
  }

  // Prefer Stallion catalog HS when available
  let hs = hit.hs;
  let ddp = null;
  try {
    const res = await fetch(
      `${stallionBaseUrl()}/products/${encodeURIComponent(hit.sku)}`,
      {
        headers: {
          Authorization: `Bearer ${stallionToken()}`,
          Accept: 'application/json',
        },
      },
    );
    const json = await res.json();
    if (res.ok && json?.data?.hs_code) {
      hs = json.data.hs_code;
      ddp = json.data.ddp_status;
    }
  } catch {
    // keep shipHero hs
  }

  const customs =
    Number(li.product_customs_value) > 0
      ? Number(li.product_customs_value)
      : Number(li.customs_value) > 0
        ? Number(li.customs_value)
        : Number(li.product_value) || hit.customs || 0;

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
      name: to.name || 'Recipient',
      address1: to.address1 || to.address_1 || '',
      city: to.city || '',
      state: to.state_code || to.state || '',
      postalCode: String(to.zip || to.postal_code || '').split('-')[0],
      country: 'US',
      phone: to.phone || undefined,
      is_residential: true,
    },
    packages: [
      {
        name: pkg.box_name || pkg.name || 'Package 1',
        weightLbs: Number(pkg.weight_in_oz) / 16,
        lengthIn: Number(pkg.length),
        widthIn: Number(pkg.width),
        heightIn: Number(pkg.height),
        package_contents: li.customs_description || li.product_name || 'Merchandise',
      },
    ],
    items: [
      {
        title: li.product_name || hit.sku,
        sku: hit.sku,
        quantity: Math.max(1, Number(li.quantity) || 1),
        value: customs,
        currency: 'USD',
        hs_code: hs,
        country_of_origin: String(
          li.country_of_manufacture || hit.origin || 'CA',
        )
          .slice(0, 2)
          .toUpperCase(),
        customs_description:
          li.customs_description || li.product_name || 'Merchandise',
      },
    ],
  };

  const q = await quoteStallion(shipment);
  const summary = {
    orderNumber,
    tracking: hit.tracking,
    shippedVia: `${hit.carrier} ${hit.service} $${hit.cost}`,
    sku: hit.sku,
    hs,
    ddp,
    package: `${shipment.packages[0].weightLbs}lb ${shipment.packages[0].lengthIn}x${shipment.packages[0].widthIn}x${shipment.packages[0].heightIn}`,
    to: `${shipment.to.city}, ${shipment.to.state} ${shipment.to.postalCode}`,
    status: q.status,
    message: q.message || null,
    rates: (q.rates || []).map((r) => ({
      service: r.service_name || r.service,
      carrier: r.carrier,
      base: r.base_rate,
      duty: r.duty,
      total: r.total,
      currency: r.currency,
    })),
  };
  tried.push(summary);
  console.log('\nTRY', JSON.stringify(summary, null, 2));
  if (q.rates?.length) {
    console.log('\nFOUND usable Stallion quote on shipped order', orderNumber);
    break;
  }
}

console.log('\n=== TRIED SUMMARY ===');
console.log(
  JSON.stringify(
    tried.map((t) => ({
      orderNumber: t.orderNumber,
      tracking: t.tracking,
      sku: t.sku,
      status: t.status,
      rates: t.rates?.length || 0,
      message: t.message || t.skip || null,
    })),
    null,
    2,
  ),
);
