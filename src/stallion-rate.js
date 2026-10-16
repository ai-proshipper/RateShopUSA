import { assertStallionRateEnv, QUOTE_TIMEOUT_MS, stallionBaseUrl, stallionToken } from './config.js';
import {
  amountToCad,
  isCad,
  resolveDeclaredCurrency,
  usdToCadRate,
} from './currency.js';

/**
 * @param {Record<string, unknown> | null | undefined} addr
 */
function mapAddress(addr) {
  const a = addr || {};
  return {
    name: String(a.name || a.company || a.company_name || 'Recipient').trim(),
    company: String(a.company || a.company_name || '').trim() || null,
    address1: String(a.address1 || a.address_1 || '').trim(),
    address2: String(a.address2 || a.address_2 || '').trim() || null,
    city: String(a.city || '').trim(),
    province_code: String(a.state || a.province_code || a.province || '').trim(),
    postal_code: String(a.postalCode || a.postal_code || a.zip || '').trim(),
    country_code: String(a.country || a.country_code || 'US').trim().slice(0, 2).toUpperCase(),
    email: a.email ? String(a.email).trim() : null,
    phone: a.phone ? String(a.phone).trim() : null,
    is_residential: a.is_residential ?? a.residential ?? true,
  };
}

/**
 * Map CAD-style package (weightOz / lengthIn) to Stallion packages[].
 * @param {Record<string, unknown>} pkg
 */
function mapPackage(pkg) {
  const p = pkg || {};
  let weight;
  let weight_unit;

  if (p.weight != null && p.weight_unit) {
    weight = Number(p.weight);
    weight_unit = String(p.weight_unit);
  } else if (p.weightOz != null) {
    weight = Math.max(0.1, Math.round((Number(p.weightOz) / 16) * 100) / 100);
    weight_unit = 'lbs';
  } else if (p.weightLbs != null) {
    weight = Number(p.weightLbs);
    weight_unit = 'lbs';
  } else {
    throw new Error('Package requires weightOz, weightLbs, or weight + weight_unit');
  }

  /** @type {Record<string, unknown>} */
  const out = {
    weight,
    weight_unit,
    package_contents: p.package_contents || p.name || p.contents || null,
  };

  const length = p.lengthIn ?? p.length;
  const width = p.widthIn ?? p.width;
  const height = p.heightIn ?? p.height;
  if (length != null && width != null && height != null) {
    out.length = Number(length);
    out.width = Number(width);
    out.height = Number(height);
    out.size_unit = p.size_unit || (p.lengthIn != null ? 'in' : 'in');
  }

  return out;
}

function formatStallionHs(hs) {
  const raw = String(hs || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 10) {
    return `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6, 8)}.${digits.slice(8, 10)}`;
  }
  return raw || null;
}

/**
 * Stallion create/rate rejects one-word descriptions (SKU-only like "VEN11").
 * They then synthesize "[qty]SKU" and fail: must contain at least 2 words.
 * @param {Record<string, unknown>} item
 */
export function stallionItemDescription(item) {
  const i = item || {};
  const sku = String(i.sku || '').trim();
  const raw = String(
    i.customs_description || i.description || i.title || i.name || sku || 'Merchandise',
  )
    .trim()
    .replace(/^\[\d+\]\s*/, '');
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return raw;
  if (sku && raw.toLowerCase() !== sku.toLowerCase()) {
    const withSku = `${raw} ${sku}`.trim();
    if (withSku.split(/\s+/).filter(Boolean).length >= 2) return withSku;
  }
  if (sku) return `Merchandise ${sku}`;
  return `${raw || 'Merchandise'} item`;
}

/**
 * Read-only Stallion catalog lookup. Never creates products or labels.
 * @param {string} sku
 * @param {number} [timeoutMs]
 */
export async function fetchStallionProduct(sku, timeoutMs = QUOTE_TIMEOUT_MS) {
  const code = String(sku || '').trim();
  if (!code) return { ok: false, status: 0, product: null };
  const url = `${stallionBaseUrl()}/products/${encodeURIComponent(code)}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${stallionToken()}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, status: res.status, product: null };
    return { ok: true, status: res.status, product: json?.data || json };
  } catch {
    return { ok: false, status: 0, product: null };
  }
}

/**
 * Replace ShipHero product fields with Stallion catalog (HS, origin, value, currency).
 * SKUs not in the catalog (aliases) are dropped.
 * Catalog customs stay in catalog currency (USD) — same as ShipHero. Ranked totals are CAD.
 * Diagnostic only — quoteStallion / labels use tote shipment.items, not this rewrite.
 * @param {Record<string, unknown>} shipment
 * @param {number} [timeoutMs]
 */
export async function applyStallionCatalog(
  shipment,
  timeoutMs = QUOTE_TIMEOUT_MS,
) {
  const skipped = [];
  const items = [];
  const seen = new Set();

  for (const item of shipment?.items || []) {
    const sku = String(item.sku || '').trim();
    if (!sku) {
      skipped.push({ sku: null, reason: 'missing sku' });
      continue;
    }
    if (seen.has(sku)) {
      skipped.push({ sku, reason: 'duplicate sku' });
      continue;
    }

    const lookup = await fetchStallionProduct(sku, timeoutMs);
    if (!lookup.ok || !lookup.product) {
      skipped.push({ sku, reason: 'not in Stallion catalog' });
      continue;
    }

    const product = lookup.product;
    const hs = formatStallionHs(product.hs_code);
    const origin = String(product.country_of_origin || '')
      .trim()
      .slice(0, 2)
      .toUpperCase();
    const value = Number(product.value);
    if (!hs) {
      skipped.push({ sku, reason: 'catalog missing hs_code' });
      continue;
    }
    if (!origin) {
      skipped.push({ sku, reason: 'catalog missing country_of_origin' });
      continue;
    }
    if (!Number.isFinite(value) || value < 0) {
      skipped.push({ sku, reason: 'catalog missing value' });
      continue;
    }

    const catalogCurrency = String(product.currency || 'USD').toUpperCase();

    seen.add(sku);
    items.push({
      title: product.title || product.name || sku,
      sku: product.sku || sku,
      quantity: Math.max(1, Number(item.quantity) || 1),
      value,
      currency: catalogCurrency,
      hs_code: hs,
      country_of_origin: origin,
      customs_description:
        product.customs_description || product.description || sku,
      ddp_status: product.ddp_status || null,
      catalogValue: value,
      catalogCurrency,
    });
  }

  return {
    shipment: { ...shipment, items },
    skipped,
  };
}

/**
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown>} shipment
 */
function mapItem(item, shipment) {
  const i = item || {};
  const description = stallionItemDescription(i);
  return {
    title: String(i.title || i.name || description).trim(),
    description,
    customs_description: description,
    quantity: Math.max(1, Number(i.quantity) || 1),
    value: Number(i.value ?? i.customs_value ?? 0),
    currency: resolveDeclaredCurrency(i, shipment),
    country_of_origin: i.country_of_origin
      ? String(i.country_of_origin).slice(0, 2).toUpperCase()
      : null,
    hs_code: formatStallionHs(i.hs_code || i.hsCode),
    sku: i.sku ? String(i.sku) : null,
  };
}

/**
 * Build Stallion POST /rates body from a shipment-shaped object.
 * @param {Record<string, unknown>} shipment
 */
export function buildStallionRateBody(shipment) {
  const s = shipment || {};
  const to = s.to || s.to_address;
  if (!to) throw new Error('Shipment requires to / to_address');

  const packages = Array.isArray(s.packages) ? s.packages : [];
  if (!packages.length) throw new Error('Shipment requires at least one package');

  /** @type {Record<string, unknown>} */
  const body = {
    to_address: mapAddress(/** @type {Record<string, unknown>} */ (to)),
    packages: packages.map((p) => mapPackage(/** @type {Record<string, unknown>} */ (p))),
  };

  // Optional: only send from_address when explicitly requested.
  // Default is the Stallion account ship-from (usually required for real rates).
  if (s.include_from_address || s.includeFromAddress) {
    const from = s.from || s.from_address;
    if (from) {
      body.from_address = mapAddress(/** @type {Record<string, unknown>} */ (from));
    }
  }

  const items = Array.isArray(s.items) ? s.items : [];
  if (items.length) {
    body.items = items.map((i) =>
      mapItem(/** @type {Record<string, unknown>} */ (i), s),
    );
  }

  if (s.orderNumber || s.order_id) {
    body.order_id = String(s.orderNumber || s.order_id);
  }

  if (s.region) {
    body.region = String(s.region).toUpperCase();
  }

  return body;
}

/**
 * Normalize one Stallion rate row into CAD for compare.
 * @param {Record<string, unknown>} rate
 * @param {number|null} [usdCad]
 */
export function normalizeStallionRate(rate, usdCad = null) {
  const r = rate || {};
  const currency = r.currency == null ? null : String(r.currency).toUpperCase();
  const toCad = (value) => amountToCad(value, currency || 'CAD', usdCad);
  const totalCad = toCad(r.total);
  const cadUsable = totalCad != null;
  return {
    service: r.service ?? null,
    carrier: r.carrier ?? null,
    service_name: r.service_name ?? null,
    base_rate: toCad(r.base_rate),
    subtotal: toCad(r.subtotal),
    duty: toCad(r.duty),
    duty_tax: toCad(r.duty_tax),
    tax: toCad(r.tax),
    total: totalCad,
    currency: cadUsable ? 'CAD' : currency,
    sourceCurrency: currency,
    estimated_delivery_days: r.estimated_delivery_days ?? null,
    trackable: r.trackable ?? null,
    landedTotal: cadUsable ? totalCad : null,
    landedCurrency: cadUsable ? 'CAD' : null,
    landedError: cadUsable
      ? null
      : currency && !isCad(currency)
        ? `Cannot combine ${currency} shipping with CAD comparison`
        : null,
  };
}

/**
 * SAFETY: this module may only call Stallion POST /rates.
 * It must never hit /labels, /shipments, or any mutating purchase path.
 * @param {string} url
 */
function assertRatesOnlyUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid Stallion rates URL: ${url}`);
  }
  if (!parsed.pathname.endsWith('/rates')) {
    throw new Error(`REFUSING non-rates Stallion URL: ${url}`);
  }
  const blocked = ['/labels', '/shipments', '/orders', '/pickups', '/batches'];
  if (blocked.some((p) => parsed.pathname.includes(p))) {
    throw new Error(`REFUSING forbidden Stallion path: ${url}`);
  }
}

/**
 * Quote Stallion rates only (POST /rates). Never creates shipments or labels.
 * @param {Record<string, unknown>} shipment
 * @param {number} [timeoutMs]
 */
export async function quoteStallion(shipment, timeoutMs = QUOTE_TIMEOUT_MS) {
  try {
    assertStallionRateEnv();
  } catch (err) {
    return {
      status: 'error',
      carrier: 'Stallion',
      message: err instanceof Error ? err.message : String(err),
      rates: [],
      raw: null,
    };
  }

  const usdCad = await usdToCadRate();
  const items = Array.isArray(shipment?.items) ? shipment.items : [];
  if (!items.length) {
    return {
      status: 'error',
      carrier: 'Stallion',
      message: 'Shipment needs items',
      rates: [],
      raw: null,
    };
  }

  let body;
  try {
    body = buildStallionRateBody(shipment);
  } catch (err) {
    return {
      status: 'error',
      carrier: 'Stallion',
      message: err instanceof Error ? err.message : String(err),
      rates: [],
      raw: null,
    };
  }

  const url = `${stallionBaseUrl()}/rates`;
  try {
    assertRatesOnlyUrl(url);
  } catch (err) {
    return {
      status: 'error',
      carrier: 'Stallion',
      message: err instanceof Error ? err.message : String(err),
      rates: [],
      raw: null,
    };
  }

  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Stallion rates timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    const res = await Promise.race([
      fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${stallionToken()}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
      timeoutPromise,
    ]);
    const raw = await res.json().catch(() => null);

    if (!res.ok) {
      const errObj = raw?.error;
      const message =
        (errObj && (errObj.message || errObj.code)) ||
        `Stallion rates HTTP ${res.status}`;
      return {
        status: 'error',
        carrier: 'Stallion',
        message: String(message),
        httpStatus: res.status,
        rates: [],
        request: body,
        raw,
      };
    }

    const rows = Array.isArray(raw?.data) ? raw.data : [];
    const rates = rows.map((r) => normalizeStallionRate(r, usdCad));

    return {
      status: 'ok',
      carrier: 'Stallion',
      rates,
      request: body,
      fxUsdCad: usdCad,
      raw,
    };
  } catch (err) {
    return {
      status: 'error',
      carrier: 'Stallion',
      message: err instanceof Error ? err.message : String(err),
      rates: [],
      request: body,
      raw: null,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
