/**
 * List HS codes present on Stallion catalog products (account tariff/classification set).
 * Read-only GET /products — no labels/shipments.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const token = stallionToken();
if (!token) {
  console.error('Missing STALLION_TOKEN / StallionAPI');
  process.exit(2);
}

const base = stallionBaseUrl();
const hsMap = new Map(); // hs -> { count, skus: [], statuses: Set }
let page = 1;
let totalFetched = 0;
let withHs = 0;

async function fetchPage(pageNum) {
  const urls = [
    `${base}/products?page=${pageNum}&per_page=100`,
    `${base}/products?page=${pageNum}&limit=100`,
  ];
  for (const url of urls) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    if (res.ok) return { url, json, status: res.status };
    if (pageNum === 1) {
      console.log('try', url, res.status, text.slice(0, 200));
    }
  }
  return null;
}

while (page <= 50) {
  const result = await fetchPage(page);
  if (!result) {
    console.error('Failed to list products');
    process.exit(1);
  }
  const rows = result.json?.data || result.json?.products || [];
  if (!Array.isArray(rows) || rows.length === 0) break;

  for (const p of rows) {
    totalFetched += 1;
    const hsRaw =
      p.hs_code ||
      p.hts_code ||
      p.tariff_code ||
      p.customs?.hs_code ||
      p.classification?.hs_code ||
      null;
    const hs = hsRaw ? String(hsRaw).trim() : '';
    if (!hs) continue;
    withHs += 1;
    const sku = p.sku || p.id || '?';
    const status =
      p.ddp_status ||
      p.classification_status ||
      p.classification?.status ||
      p.status ||
      null;
    if (!hsMap.has(hs)) {
      hsMap.set(hs, { count: 0, skus: [], statuses: new Set() });
    }
    const entry = hsMap.get(hs);
    entry.count += 1;
    if (entry.skus.length < 5) entry.skus.push(sku);
    if (status) entry.statuses.add(String(status));
  }

  const meta = result.json?.meta || {};
  const lastPage = meta.last_page || meta.total_pages;
  if (lastPage && page >= lastPage) break;
  if (rows.length < 50) break;
  page += 1;
}

console.log(`Products fetched: ${totalFetched}`);
console.log(`Products with HS: ${withHs}`);
console.log(`Unique HS codes: ${hsMap.size}`);
console.log('\nHS code                         Count  Statuses                 Sample SKUs');
console.log('-'.repeat(100));

const sorted = [...hsMap.entries()].sort((a, b) => b[1].count - a[1].count);
for (const [hs, info] of sorted) {
  const statuses = [...info.statuses].join(',') || '—';
  console.log(
    `${String(hs).padEnd(32)} ${String(info.count).padStart(5)}  ${statuses.padEnd(24).slice(0, 24)} ${info.skus.join(', ')}`,
  );
}

if (sorted.length === 0) {
  console.log('\nNo HS codes on catalog products.');
  console.log(
    'Stallion does not expose a public full HTS database dump — only validation against their internal tariff DB.',
  );
}
