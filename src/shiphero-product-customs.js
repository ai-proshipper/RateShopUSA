/**
 * Fill US tote item customs_description from ShipHero product catalog
 * when the Generate Label webhook line is SKU-only / one word.
 * Fail-open: missing token or GraphQL errors leave the shipment unchanged.
 */
import { getShipHeroAccessToken, shipHeroAuthConfigured } from './config.js';

const SHIPHERO_URL = 'https://public-api.shiphero.com/graphql';

export function shipHeroProductLookupMs() {
  const n = Number(process.env.SHIPHERO_PRODUCT_LOOKUP_MS);
  return Number.isFinite(n) && n > 0 ? n : 1500;
}

function graphqlEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * True when the webhook line would send Stallion a SKU-like one-word description.
 * @param {Record<string, unknown> | null | undefined} item
 */
export function itemNeedsShipHeroCustomsDescription(item) {
  const sku = String(item?.sku || '').trim();
  if (!sku) return false;
  const desc = String(item?.customs_description || item?.title || '')
    .trim()
    .replace(/^\[\d+\]\s*/, '');
  if (!desc) return true;
  if (desc.toLowerCase() === sku.toLowerCase()) return true;
  return desc.split(/\s+/).filter(Boolean).length < 2;
}

function catalogDescriptionUsable(raw, sku) {
  const desc = String(raw || '').trim();
  if (!desc) return '';
  if (desc.toLowerCase() === String(sku || '').trim().toLowerCase()) return '';
  if (desc.split(/\s+/).filter(Boolean).length < 2) return '';
  return desc;
}

function buildProductsQuery(skus) {
  const fields =
    'data(first: 1) { edges { node { sku name customs_description } } }';
  const parts = skus.map(
    (sku, i) => `p${i}: products(sku: "${graphqlEscape(sku)}") { ${fields} }`,
  );
  return `query UsaProductCustoms {\n${parts.join('\n')}\n}`;
}

function mapProductCustoms(unique, dataRaw) {
  /** @type {Map<string, { sku: string, name?: string, customs_description?: string }>} */
  const out = new Map();
  const data = dataRaw && typeof dataRaw === 'object' ? dataRaw : {};
  for (let i = 0; i < unique.length; i += 1) {
    const sku = unique[i];
    const node = data[`p${i}`]?.data?.edges?.[0]?.node;
    if (!node || typeof node !== 'object') continue;
    out.set(sku.toUpperCase(), {
      sku: String(node.sku || sku),
      name: node.name != null ? String(node.name) : undefined,
      customs_description:
        node.customs_description != null ? String(node.customs_description) : undefined,
    });
  }
  return out;
}

/**
 * @param {string[]} skus
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, token?: string }} [runtime]
 * @returns {Promise<Map<string, { sku: string, name?: string, customs_description?: string }>>}
 */
export async function fetchShipHeroProductCustoms(skus, runtime = {}) {
  const unique = [...new Set((skus || []).map((s) => String(s || '').trim()).filter(Boolean))];
  if (!unique.length) return new Map();

  const fetchImpl = runtime.fetchImpl || fetch;
  const timeoutMs = runtime.timeoutMs || shipHeroProductLookupMs();
  let token = runtime.token;
  if (!token) {
    if (!shipHeroAuthConfigured()) return new Map();
    try {
      token = await getShipHeroAccessToken({
        fetchImpl: runtime.authFetchImpl || fetch,
        timeoutMs,
      });
    } catch {
      return new Map();
    }
  }

  async function post(bearer) {
    const res = await fetchImpl(SHIPHERO_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ query: buildProductsQuery(unique) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json().catch(() => null);
    return { res, json };
  }

  let { res, json } = await post(token);
  if (res.status === 401 && !runtime.token && shipHeroAuthConfigured()) {
    token = await getShipHeroAccessToken({
      fetchImpl: runtime.authFetchImpl || fetch,
      timeoutMs,
      force: true,
    });
    ({ res, json } = await post(token));
  }
  if (!res.ok) {
    throw new Error(`ShipHero products HTTP ${res.status}`);
  }
  if (json?.errors?.length) {
    throw new Error(String(json.errors[0]?.message || 'ShipHero products GraphQL error'));
  }
  return mapProductCustoms(unique, json?.data);
}

/**
 * Overlay ShipHero product customs_description onto weak webhook lines.
 * @param {Record<string, unknown>} shipment
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, token?: string }} [runtime]
 */
export async function enrichUsaShipmentCustomsFromShipHero(shipment, runtime = {}) {
  const items = Array.isArray(shipment?.items) ? shipment.items : [];
  const need = items.filter((item) => itemNeedsShipHeroCustomsDescription(item));
  if (!need.length) return shipment;
  if (!(runtime.token || shipHeroAuthConfigured())) return shipment;

  try {
    const catalog = await fetchShipHeroProductCustoms(
      need.map((item) => String(item.sku)),
      runtime,
    );
    for (const item of need) {
      const sku = String(item.sku || '').trim();
      const row = catalog.get(sku.toUpperCase());
      const desc = catalogDescriptionUsable(row?.customs_description, sku);
      if (!desc) continue;
      item.customs_description = desc;
      const title = String(item.title || '').trim();
      if (!title || itemNeedsShipHeroCustomsDescription({ sku, title, customs_description: title })) {
        item.title = desc;
      }
      console.log(`[usa-rate-shop] ShipHero customs_description sku=${sku} "${desc}"`);
    }
  } catch (err) {
    console.warn(
      `[usa-rate-shop] ShipHero product customs lookup failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return shipment;
}
