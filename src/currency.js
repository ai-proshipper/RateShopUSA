/**
 * Declared-value currency for quotes and labels.
 * Honor item, then shipment, then CAD. Never default to USD.
 * CAD landed compare: convert USD → CAD; never mix USD totals into CAD ranking.
 */

const FX_CACHE_MS = 60 * 60 * 1000;
let usdCadCache = { rate: null, at: 0 };

export function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Customs values from ShipHero are USD.
 * Postage / ranked landed totals are CAD.
 * Do not inherit shipment.currency (order/postage CAD) as the customs currency.
 */
export function resolveDeclaredCurrency(item, shipment) {
  return String(
    item?.currency || shipment?.customsCurrency || 'USD',
  ).toUpperCase();
}

/**
 * @param {unknown} code
 */
export function isCad(code) {
  return String(code || '').toUpperCase() === 'CAD';
}

/**
 * @param {unknown} code
 */
export function isUsd(code) {
  return String(code || '').toUpperCase() === 'USD';
}

/**
 * USD→CAD rate: env USD_TO_CAD_RATE, else Bank of Canada (cached 1h).
 * @returns {Promise<number|null>}
 */
export async function usdToCadRate() {
  const fromEnv = Number(process.env.USD_TO_CAD_RATE);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  if (usdCadCache.rate && Date.now() - usdCadCache.at < FX_CACHE_MS) {
    return usdCadCache.rate;
  }
  try {
    const res = await fetch(
      'https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1',
      { signal: AbortSignal.timeout(5000) },
    );
    const json = await res.json().catch(() => null);
    const rate = Number(json?.observations?.[0]?.FXUSDCAD?.v);
    if (Number.isFinite(rate) && rate > 0) {
      usdCadCache = { rate, at: Date.now() };
      return rate;
    }
  } catch {
    // fall through
  }
  return usdCadCache.rate || null;
}

/**
 * Convert an amount into CAD. Returns null if currency cannot be converted.
 * @param {unknown} amount
 * @param {unknown} currency
 * @param {number|null} [usdCad]
 */
export function amountToCad(amount, currency, usdCad = null) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  if (isCad(currency) || !currency) return roundMoney(n);
  if (isUsd(currency)) {
    if (!Number.isFinite(Number(usdCad)) || Number(usdCad) <= 0) return null;
    return roundMoney(n * Number(usdCad));
  }
  return null;
}

/**
 * @param {Array<Record<string, unknown>> | null | undefined} items
 * @param {Record<string, unknown> | null | undefined} shipment
 */
export function assertSingleDeclaredCurrency(items, shipment) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    throw new Error('Declared currency requires at least one customs item');
  }
  const currencies = new Set(
    list.map((item) => resolveDeclaredCurrency(item, shipment)),
  );
  if (currencies.size !== 1) {
    throw new Error('All customs items must use one declared currency');
  }
  return [...currencies][0];
}
