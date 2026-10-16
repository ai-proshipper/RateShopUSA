import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

const start = '2026-05-01T00:00:00+00:00';
const end = '2026-06-01T00:00:00+00:00';

// Page through May labels
let offset = 0;
const pageSize = 200;
const all = [];
while (offset < 2000) {
  const rows = await sb(
    `/rest/v1/shipping_labels?select=tracking_number,carrier,service_level,label_shipping_cost,shipped_at,order_id,raw_payload&shipped_at=gte.${encodeURIComponent(start)}&shipped_at=lt.${encodeURIComponent(end)}&order=shipped_at.asc&limit=${pageSize}&offset=${offset}`,
  );
  if (!rows.length) break;
  all.push(...rows);
  if (rows.length < pageSize) break;
  offset += pageSize;
}
console.log('May labels total fetched:', all.length);

const withPayload = all.filter((l) => l.raw_payload != null).length;
const withPackage = all.filter((l) => l.raw_payload?.package).length;
console.log('withPayload', withPayload, 'withPackage', withPackage);

const needle = /SMI6010|SMI6011|SMI3000|SMI3011|SMI3020|SMI3017|VEN11|S6161|ETJ-|8425\.49|842549/i;
const hits = [];
for (const label of all) {
  const raw = label.raw_payload;
  if (!raw) continue;
  const txt = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (!needle.test(txt)) continue;
  const pkg = raw.package || raw.packages?.[0] || {};
  const items = pkg.line_items || raw.line_items || [];
  const li =
    items.find((x) => needle.test(JSON.stringify(x))) || items[0] || null;
  const orders = await sb(
    `/rest/v1/orders?select=order_number,partner_order_id&id=eq.${label.order_id}&limit=1`,
  );
  const orderNumber = orders?.[0]?.order_number || orders?.[0]?.partner_order_id;
  hits.push({
    shipped: String(label.shipped_at || '').slice(0, 10),
    orderNumber,
    amazonLike: /^\d{3}-\d{7}-\d{7}$/.test(String(orderNumber || '')),
    carrier: label.carrier,
    service: label.service_level,
    cost: label.label_shipping_cost,
    tracking: label.tracking_number,
    sku: li?.sku || null,
    hs: li?.tariff_code || null,
    customs: li?.product_customs_value || li?.customs_value || null,
    dims: pkg.length ? `${pkg.length}x${pkg.width}x${pkg.height}` : null,
    weightLbs: pkg.weight_in_oz ? Number(pkg.weight_in_oz) / 16 : null,
  });
}

console.log('friendly hits', hits.length);
hits.sort((a, b) => a.shipped.localeCompare(b.shipped));
console.log('\nAMAZON-LIKE');
console.log(JSON.stringify(hits.filter((h) => h.amazonLike), null, 2));
console.log('\nOTHER');
console.log(JSON.stringify(hits.filter((h) => !h.amazonLike).slice(0, 20), null, 2));

// Also: May shipping_labels joined via order_line_items SKU
console.log('\nVia order_line_items SKU in May...');
for (const sku of ['SMI6010', 'SMI3000', 'SMI3020', 'VEN11', 'S6161']) {
  const lines = await sb(
    `/rest/v1/order_line_items?select=sku,order_id,orders(order_number,partner_order_id)&sku=eq.${encodeURIComponent(sku)}&limit=100`,
  );
  let matched = 0;
  const samples = [];
  for (const line of lines || []) {
    const labs = await sb(
      `/rest/v1/shipping_labels?select=tracking_number,carrier,service_level,label_shipping_cost,shipped_at&order_id=eq.${line.order_id}&shipped_at=gte.${encodeURIComponent(start)}&shipped_at=lt.${encodeURIComponent(end)}&limit=3`,
    );
    if (!labs.length) continue;
    matched += labs.length;
    for (const lab of labs) {
      if (samples.length < 5) {
        samples.push({
          sku,
          order: line.orders?.order_number || line.orders?.partner_order_id,
          shipped: String(lab.shipped_at || '').slice(0, 10),
          carrier: lab.carrier,
          service: lab.service_level,
          cost: lab.label_shipping_cost,
          tracking: lab.tracking_number,
        });
      }
    }
  }
  console.log(sku, 'may labels', matched, JSON.stringify(samples));
}
