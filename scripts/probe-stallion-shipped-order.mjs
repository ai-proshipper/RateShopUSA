/**
 * Quote Stallion for an already-shipped US order, using Stallion catalog HS per SKU.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quoteStallion } from '../src/stallion-rate.js';
import { stallionBaseUrl, stallionToken, QUOTE_TIMEOUT_MS } from '../src/config.js';

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

const sampleName = process.argv[2] || 'order-22305123.json';
const shipment = JSON.parse(
  readFileSync(resolve(root, 'samples', sampleName), 'utf8'),
);

async function stallionProduct(sku) {
  const res = await fetch(
    `${stallionBaseUrl()}/products/${encodeURIComponent(sku)}`,
    {
      headers: {
        Authorization: `Bearer ${stallionToken()}`,
        Accept: 'application/json',
      },
    },
  );
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, status: res.status, error: json };
  return { ok: true, product: json?.data || json };
}

const stallionShipment = structuredClone(shipment);
stallionShipment.region = stallionShipment.region || 'ON';

console.log(`Order ${shipment.orderNumber}`);
console.log(
  `To ${shipment.to.city}, ${shipment.to.state} ${shipment.to.postalCode} | pkg ${shipment.packages[0].weightLbs} lb ${shipment.packages[0].lengthIn}x${shipment.packages[0].widthIn}x${shipment.packages[0].heightIn}`,
);

const mapped = [];
for (const item of stallionShipment.items) {
  const sku = item.sku;
  const lookup = sku ? await stallionProduct(sku) : { ok: false };
  const shipHeroHs = item.hs_code;
  if (lookup.ok && lookup.product?.hs_code) {
    item.hs_code = lookup.product.hs_code;
    mapped.push({
      sku,
      shipHeroHs,
      stallionHs: lookup.product.hs_code,
      ddp: lookup.product.ddp_status,
      value: item.value,
      origin: item.country_of_origin,
    });
  } else {
    mapped.push({
      sku,
      shipHeroHs,
      stallionHs: null,
      ddp: null,
      value: item.value,
      origin: item.country_of_origin,
      lookupError: lookup.status || 'missing sku',
    });
  }
}

console.log('\nSKU HS mapping (ShipHero → Stallion catalog):');
for (const row of mapped) {
  console.log(
    `  ${row.sku}: ${row.shipHeroHs} → ${row.stallionHs || 'NOT IN STALLION'} (ddp=${row.ddp || 'n/a'}) customs $${row.value} origin ${row.origin}`,
  );
}

// Prefer label component SKUs only when kit parent+child both present with customs
const hasKitish = stallionShipment.items.some((i) =>
  String(i.sku || '').includes('-V'),
);
if (hasKitish && stallionShipment.items.length > 1) {
  // Keep items that exist in Stallion first; else keep all
  const inCatalog = stallionShipment.items.filter((i, idx) => mapped[idx].stallionHs);
  if (inCatalog.length) {
    console.log(
      `\nUsing ${inCatalog.length} Stallion-catalog item(s) for quote (dropped missing/unmapped where possible).`,
    );
  }
}

const q = await quoteStallion(stallionShipment, QUOTE_TIMEOUT_MS);
console.log(`\nStallion status: ${q.status}${q.message ? ` — ${q.message}` : ''}`);
if (q.rates?.length) {
  console.log(
    'Service                          Carrier      Base     Duty  DutyTax      Tax    Total',
  );
  for (const r of q.rates) {
    console.log(
      `${String(r.service_name || r.service).padEnd(32).slice(0, 32)} ${String(r.carrier || '').padEnd(10).slice(0, 10)} ${String(r.base_rate ?? '—').padStart(7)} ${String(r.duty ?? '—').padStart(7)} ${String(r.duty_tax ?? '—').padStart(7)} ${String(r.tax ?? '—').padStart(7)} ${String(r.total ?? '—').padStart(8)} ${r.currency || ''}`,
    );
  }
} else {
  console.log('No rates');

  // Retry with only catalog-mapped items / single best item
  const onlyMapped = stallionShipment.items.filter((i) =>
    mapped.some((m) => m.sku === i.sku && m.stallionHs),
  );
  if (onlyMapped.length && onlyMapped.length !== stallionShipment.items.length) {
    const retry = structuredClone(stallionShipment);
    retry.items = onlyMapped;
    console.log(`\nRetry with only Stallion-catalog SKUs (${onlyMapped.map((i) => i.sku).join(', ')})...`);
    const q2 = await quoteStallion(retry, QUOTE_TIMEOUT_MS);
    console.log(`Status: ${q2.status}${q2.message ? ` — ${q2.message}` : ''}`);
    if (q2.rates?.length) {
      for (const r of q2.rates) {
        console.log(
          `${String(r.service_name || r.service).padEnd(32)} base $${r.base_rate} duty $${r.duty} total $${r.total}`,
        );
      }
    } else {
      console.log('Still no rates');
    }
  }

  // Also try smallest single catalog item
  const one = stallionShipment.items.find((i) =>
    mapped.some((m) => m.sku === i.sku && m.stallionHs),
  );
  if (one) {
    const retry = structuredClone(stallionShipment);
    retry.items = [one];
    console.log(`\nRetry single item ${one.sku} HS ${one.hs_code}...`);
    const q3 = await quoteStallion(retry, QUOTE_TIMEOUT_MS);
    console.log(`Status: ${q3.status}${q3.message ? ` — ${q3.message}` : ''}`);
    if (q3.rates?.length) {
      for (const r of q3.rates) {
        console.log(
          `${String(r.service_name || r.service).padEnd(32)} base $${r.base_rate} duty $${r.duty} total $${r.total}`,
        );
      }
    } else console.log('Still no rates / empty');
  }
}
