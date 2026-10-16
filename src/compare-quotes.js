/**
 * CAD landed compare. Quotes only — never buys labels.
 * Stallion is omitted from ranking when STALLION_ENABLED is false.
 */
import { quoteCanadaPostUs } from './canada-post-quote.js';
import { CANADA_POST_US_SERVICE_CODES } from './canada-post-config.js';
import { QUOTE_TIMEOUT_MS, WEBHOOK_DEADLINE_MS, LABEL_RESERVE_MS } from './config.js';
import {
  isStallionLabelCarrierAllowed,
  isStallionLabelServiceAllowed,
  stallionEnabled,
  stallionScheduleEnabled,
} from './stallion-config.js';
import { quoteStallion } from './stallion-rate.js';
import { canadaPostPoBoxUnavailableMessage, shipmentGoesToPoBox } from './po-box.js';
import { quoteUpsRates } from './ups-rate.js';
import { combineUpsQuoteResults, pickCanadaPostZonosDuties } from './ups-quote.js';
import { isUpsQuoteService, upsStandardComparePad } from './ups-config.js';

/**
 * Stallion rates often need dotted HS (8425.49.00.00). Quote adapter only.
 * @param {Record<string, unknown>} shipment
 */
export function stallionHsDottedShipment(shipment) {
  const copy = structuredClone(shipment);
  for (const item of copy.items || []) {
    const d = String(item.hs_code || '').replace(/\D/g, '');
    if (d.length >= 10) {
      item.hs_code = `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}.${d.slice(8, 10)}`;
    }
  }
  return copy;
}

/**
 * @param {{ stallion: Record<string, unknown>, ups: Record<string, unknown>, canadaPost: Record<string, unknown> }} quotes
 * @param {{ postageOnly?: boolean, shopName?: unknown }} [options]
 */
export function rankCadLanded({ stallion, ups, canadaPost }, options = {}) {
  const postageOnly = options.postageOnly === true;
  const shopName =
    options.shopName != null && String(options.shopName).trim()
      ? String(options.shopName)
      : null;
  const ranked = [];

  for (const r of stallionEnabled() ? stallion?.rates || [] : []) {
    const postage = Number(r.base_rate);
    const landed = Number(r.landedTotal);
    const sortTotal = postageOnly ? postage : landed;
    if (!Number.isFinite(sortTotal)) continue;
    ranked.push({
      carrier: 'Stallion',
      service: r.service_name || r.service || null,
      serviceCode: r.service ?? null,
      lastMileCarrier: r.carrier ?? null,
      trackable: r.trackable === true,
      shipping: r.base_rate ?? null,
      // Keep duty/tax for audit even when sortTotal is postage-only.
      duty: r.duty ?? null,
      tax: r.tax ?? null,
      duty_tax: r.duty_tax ?? null,
      landedTotal: sortTotal,
      fullLandedTotal: Number.isFinite(landed) ? landed : null,
      landedCurrency: r.landedCurrency || 'CAD',
      duty_source: 'stallion',
      compareMode: postageOnly ? 'postage' : 'landed',
      printCost: Number(r.total ?? r.landedTotal),
      shopName,
    });
  }

  for (const r of ups?.rates || []) {
    const pad = upsStandardComparePad(r.serviceCode);
    const postageBase = Number(r.shipping);
    const landedBase = Number(r.landedTotal);
    const postage = Number.isFinite(postageBase) ? postageBase + pad : postageBase;
    const landed = Number.isFinite(landedBase) ? landedBase + pad : landedBase;
    const sortTotal = postageOnly ? postage : landed;
    if (!Number.isFinite(sortTotal)) continue;
    ranked.push({
      carrier: 'UPS',
      service: r.serviceName || r.serviceCode || null,
      serviceCode: r.serviceCode ?? null,
      lastMileCarrier: 'UPS',
      trackable: true,
      shipping: r.shipping ?? null,
      postagePad: pad || undefined,
      // Keep duty/fees for audit even when sortTotal is postage-only.
      duty: r.duty ?? null,
      brokerage: r.brokerage ?? null,
      importCharges: r.importCharges ?? null,
      dutyItems: Array.isArray(r.dutyItems) ? r.dutyItems : [],
      landedTotal: sortTotal,
      fullLandedTotal: Number.isFinite(Number(r.landedTotal))
        ? Number(r.landedTotal)
        : null,
      landedCurrency: r.landedCurrency || 'CAD',
      duty_source: r.duty_source || 'zonos',
      compareMode: postageOnly ? 'postage' : 'landed',
      printCost: Number(r.shipping),
      shopName,
    });
  }

  for (const r of canadaPost?.rates || []) {
    const postage = Number(r.shipping);
    const landed = Number(r.landedTotal);
    const sortTotal = postageOnly ? postage : landed;
    if (!Number.isFinite(sortTotal)) continue;
    ranked.push({
      carrier: 'Canada Post',
      service: r.serviceName || r.serviceCode || null,
      serviceCode: r.serviceCode ?? null,
      lastMileCarrier: 'Canada Post',
      trackable: true,
      shipping: r.shipping ?? null,
      // Keep duty/tax/fees for audit even when sortTotal is postage-only.
      duty: r.duty ?? null,
      taxes: r.taxes ?? null,
      fees: r.fees ?? r.clearanceFees ?? null,
      importCharges: r.importCharges ?? null,
      dutyItems: Array.isArray(r.dutyItems) ? r.dutyItems : [],
      feeItems: Array.isArray(r.feeItems) ? r.feeItems : [],
      landedTotal: sortTotal,
      fullLandedTotal: Number.isFinite(landed) ? landed : null,
      landedCurrency: r.landedCurrency || 'CAD',
      duty_source: r.duty_source || 'api',
      compareMode: postageOnly ? 'postage' : 'landed',
      printCost: Number(r.shipping),
      shopName,
    });
  }

  ranked.sort((a, b) => a.landedTotal - b.landedTotal);
  return ranked;
}

function isFiniteMoney(value) {
  if (value == null || value === '') return false;
  return Number.isFinite(Number(value));
}

/**
 * Amount charged at print: Stallion billed total; UPS/CP postage.
 * @param {Record<string, unknown> | null | undefined} row
 */
export function printCostForRow(row) {
  if (!row) return NaN;
  if (isFiniteMoney(row.printCost)) return Number(row.printCost);
  const carrier = String(row.carrier || '').toLowerCase();
  if (carrier === 'stallion') return Number(row.landedTotal);
  return Number(row.shipping);
}

/**
 * True if this ranked row is a service we are allowed to buy.
 * Stallion US Regional is buyable only when row.shopName is a Shopify store.
 * @param {Record<string, unknown> | null | undefined} row
 */
export function isBuyableWinner(row) {
  if (!row || !isFiniteMoney(row.landedTotal)) return false;
  const carrier = String(row.carrier || '').toLowerCase();
  if (carrier === 'stallion') {
    if (!stallionEnabled()) return false;
    if (row.trackable !== true) return false;
    if (!isStallionLabelServiceAllowed(String(row.serviceCode || ''))) return false;
    const allowOpts = { shopName: row.shopName };
    return (
      isStallionLabelCarrierAllowed(row.lastMileCarrier, allowOpts) ||
      isStallionLabelCarrierAllowed(row.service, allowOpts)
    );
  }
  if (carrier === 'ups') {
    return isUpsQuoteService(row.serviceCode);
  }
  if (carrier === 'canada post' || carrier === 'canadapost') {
    const code = String(row.serviceCode || '').toUpperCase();
    return CANADA_POST_US_SERVICE_CODES.includes(code);
  }
  return false;
}

/**
 * Cheapest CAD landed row that we can actually purchase.
 * Skips non-buyable rows (e.g. Stallion Regional on non-Shopify) and takes the next cheapest buyable.
 * @param {Array<Record<string, unknown>>} ranked
 */
export function pickBuyableWinner(ranked) {
  return (ranked || []).find((row) => isBuyableWinner(row)) || null;
}

/**
 * PO Box shipments may only buy Canada Post.
 * @param {Array<Record<string, unknown>>} ranked
 */
export function pickPoBoxWinner(ranked) {
  return (
    (ranked || []).find(
      (row) =>
        isBuyableWinner(row) && String(row.carrier || '').toLowerCase() === 'canada post',
    ) || null
  );
}

function hasLandedRate(rates) {
  return (rates || []).some((row) => isFiniteMoney(row?.landedTotal));
}

function hasShippingRate(rates) {
  return (rates || []).some(
    (row) => isFiniteMoney(row?.shipping) || isFiniteMoney(row?.base_rate),
  );
}

/**
 * True when Canada Post Zonos returned a CAD duty we can attach to UPS.
 * @param {Record<string, unknown> | null | undefined} canadaPost
 */
export function hasCanadaPostZonosDuties(canadaPost) {
  return pickCanadaPostZonosDuties(canadaPost).status === 'ok';
}

/**
 * First Stallion rate with a finite CAD duty (duty is the same across services).
 * @param {Record<string, unknown> | null | undefined} stallion
 * @returns {number|null}
 */
export function pickStallionDuty(stallion) {
  for (const row of stallion?.rates || []) {
    if (isFiniteMoney(row?.duty)) return Number(row.duty);
  }
  return null;
}

/**
 * Formula A: |a − b| / min(a, b) > 50%.
 * Either duty 0 and the other > 0 → diverge. Both 0 → do not diverge.
 * Missing / non-finite → do not apply (false).
 * @param {unknown} stallionDuty
 * @param {unknown} zonosDuty
 */
export function dutiesDivergeOver50(stallionDuty, zonosDuty) {
  if (!isFiniteMoney(stallionDuty) || !isFiniteMoney(zonosDuty)) return false;
  const a = Number(stallionDuty);
  const b = Number(zonosDuty);
  if (a < 0 || b < 0) return false;
  if (a === 0 && b === 0) return false;
  if (a === 0 || b === 0) return true;
  return Math.abs(a - b) / Math.min(a, b) > 0.5;
}

/**
 * Rank postage (not landed) when Zonos duties are missing or broken,
 * or when Stallion and Zonos duties diverge by more than 50% (formula A).
 * @param {Record<string, unknown>} comparison
 */
export function shouldComparePostage(comparison) {
  if (comparison?.compareMode === 'postage') return true;
  if (comparison?.compareMode === 'landed') return false;
  if (hasCanadaPostZonosDuties(comparison?.canadaPost)) return false;
  return (
    hasShippingRate(comparison?.ups?.rates) ||
    hasShippingRate(comparison?.canadaPost?.rates)
  );
}

function firstDetail(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function carrierNoRateDetail(name, comparison) {
  const key = String(name || '').toLowerCase();
  if (key === 'stallion') {
    const s = comparison?.stallion;
    return firstDetail(
      s?.message,
      s?.error,
      s?.status !== 'ok' ? s?.status : '',
      'no landed rates',
    );
  }
  if (key === 'ups') {
    const u = comparison?.ups;
    const landedErr = (u?.rates || []).find((row) => row?.landedError)?.landedError;
    return firstDetail(
      u?.error,
      u?.ratingError,
      u?.zonosDuty?.error,
      landedErr,
      u?.status && u.status !== 'ok' ? u.status : '',
      'no landed rates',
    );
  }
  if (key === 'canada post') {
    const c = comparison?.canadaPost;
    return firstDetail(
      c?.ratingError,
      c?.zonosError,
      c?.error,
      c?.status !== 'ok' ? c?.status : '',
      'no landed rates',
    );
  }
  return 'no rates';
}

const CP_NO_SERVICE_RE =
  /\bno service\b|\bno rates?\b|\bno quotes?\b|not available for this destination|service(?:s)? (?:is|are) not (?:available|offered)|requested service|exceeds canada post usa size\/weight limits/i;
const CP_HANG_RE =
  /timeout|timed out|aborted|AbortError|TimeoutError|budget exhausted|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR/i;

/**
 * True when Canada Post answered and has no product for this destination.
 * Hangs / aborts / OAuth failures are not no-service — those still abort the shop.
 * @param {Record<string, unknown>} comparison
 */
export function isCanadaPostNoService(comparison) {
  const c = comparison?.canadaPost;
  if (!c || hasLandedRate(c.rates)) return false;
  const status = String(c.status || '');
  const err = String(c.ratingError || c.error || '');
  if (CP_HANG_RE.test(err) || CP_HANG_RE.test(status)) return false;
  if (status === 'no_rate') return true;
  return CP_NO_SERVICE_RE.test(err);
}

/**
 * True when Canada Post failed with a hang / abort / timeout (not a no-service answer).
 * @param {Record<string, unknown>} comparison
 */
export function isCanadaPostQuoteTimeout(comparison) {
  const c = comparison?.canadaPost;
  if (!c) return false;
  if (hasShippingRate(c.rates) || hasLandedRate(c.rates)) return false;
  const status = String(c.status || '');
  const err = String(c.ratingError || c.error || '');
  return CP_HANG_RE.test(err) || CP_HANG_RE.test(status);
}

/**
 * UPS postage without a CAD landed total (e.g. Zonos duty failed) is not a rate.
 * @param {Record<string, unknown> | null | undefined} comparison
 */
export function hasUpsLandedRate(comparison) {
  return hasLandedRate(comparison?.ups?.rates);
}

/**
 * UPS must return a shoppable rate (landed, or postage when Zonos is down).
 * Canada Post must too, unless it confirmed no service.
 * Stallion is optional: empty/failed Stallion quotes do not abort print.
 * PO Box destinations skip UPS — Canada Post is required and never ignored.
 * @param {Record<string, unknown>} comparison
 * @param {{ ignoreCanadaPost?: boolean, postageOnly?: boolean, poBox?: boolean }} [options]
 * @returns {string[]}
 */
export function usaCarriersMissingLandedRates(comparison, options = {}) {
  const postageOnly =
    options.postageOnly === true || shouldComparePostage(comparison);
  const poBox = options.poBox === true || comparison?.poBox === true;
  const missing = [];
  if (!poBox) {
    if (postageOnly) {
      if (!hasShippingRate(comparison?.ups?.rates)) missing.push('UPS');
    } else if (!hasUpsLandedRate(comparison)) {
      missing.push('UPS');
    }
  }
  const ignoreCanadaPost = poBox
    ? false
    : options.ignoreCanadaPost === true || isCanadaPostNoService(comparison);
  if (!ignoreCanadaPost) {
    if (postageOnly) {
      if (!hasShippingRate(comparison?.canadaPost?.rates)) missing.push('Canada Post');
    } else if (!hasLandedRate(comparison?.canadaPost?.rates)) {
      missing.push('Canada Post');
    }
  }
  return missing;
}

export const CANADA_POST_QUOTE_TIMEOUT_MSG = 'Canada post timedout. TRY AGAIN!';

/**
 * Abort print when UPS has no CAD landed rate, or Canada Post has no rate.
 * UPS is never skipped, except PO Box shipments (Canada Post only).
 * Canada Post no-service is skipped. Stallion failures do not abort.
 * The packer "timedout" string is only used for real CP hangs/timeouts.
 * @param {Record<string, unknown>} comparison
 * @param {Array<Record<string, unknown>>} ranked
 */
export function usaIncompleteShopError(comparison, ranked, options = {}) {
  const missing = usaCarriersMissingLandedRates(comparison, options);
  if (
    missing.length === 1 &&
    missing[0] === 'Canada Post' &&
    isCanadaPostQuoteTimeout(comparison)
  ) {
    return CANADA_POST_QUOTE_TIMEOUT_MSG;
  }
  if (options.poBox === true || comparison?.poBox === true) {
    return canadaPostPoBoxUnavailableMessage(comparison?.canadaPost);
  }
  const missingBit = missing
    .map((name) => `${name} (${carrierNoRateDetail(name, comparison)})`)
    .join('; ');
  const wouldWin = pickBuyableWinner(ranked);
  let winBit = 'No remaining carrier had a buyable winning rate.';
  if (wouldWin) {
    const method = String(wouldWin.service || wouldWin.serviceCode || 'unknown method');
    const landed = Number(wouldWin.landedTotal).toFixed(2);
    const print = Number(wouldWin.printCost);
    const printBit = Number.isFinite(print) ? ` (print CAD ${print.toFixed(2)})` : '';
    winBit = `${wouldWin.carrier} ${method} would have won at CAD ${landed} landed${printBit}.`;
  }
  return `US Rate Shop aborted: ${missingBit} did not return a rate. ${winBit}`;
}

function cheapestRankedByCarrier(ranked, carrierName) {
  const needle = String(carrierName || '').toLowerCase();
  const rows = (ranked || []).filter(
    (row) => String(row.carrier || '').toLowerCase() === needle,
  );
  if (!rows.length) return null;
  return rows.reduce((best, row) => {
    const a = Number(row.shipping ?? row.landedTotal);
    const b = Number(best.shipping ?? best.landedTotal);
    return a < b ? row : best;
  });
}

/**
 * UPS / Stallion postage (base) for audit. Canada Post is excluded.
 * @param {Array<Record<string, unknown>>} [ranked]
 */
export function postageCompareFromRanked(ranked) {
  return {
    ups: cheapestRankedByCarrier(ranked, 'UPS'),
    stallion: cheapestRankedByCarrier(ranked, 'Stallion'),
  };
}

/**
 * Packer-facing CP timeout. CP cannot win. Postage lives on the audit snapshot.
 * @param {number} [_priorTimeouts]
 * @param {Record<string, unknown> | null | undefined} [_winner]
 */
export function usaCanadaPostTimeoutShopError(_priorTimeouts, _winner) {
  return CANADA_POST_QUOTE_TIMEOUT_MSG;
}

const PO_BOX_SKIP = {
  status: 'skipped',
  rates: [],
  message: 'PO Box — Canada Post only',
};

/**
 * Quote Stallion, UPS postage, and Canada Post postage + Zonos.
 * UPS reuses Canada Post Zonos duties. If Zonos is missing or broken, rank postage.
 * PO Box destinations quote Canada Post only.
 * Does not import label modules and does not purchase postage.
 * All shopped carriers share one budget so the print path stays inside 18s.
 * @param {Record<string, unknown>} shipment
 * @param {number} [timeoutMs]
 */
export async function compareQuotes(shipment, timeoutMs) {
  const budget = Math.max(
    1500,
    Math.min(
      Number(timeoutMs) || QUOTE_TIMEOUT_MS,
      WEBHOOK_DEADLINE_MS - LABEL_RESERVE_MS,
    ),
  );
  const poBox = shipmentGoesToPoBox(shipment);

  const stallionQuote = poBox
    ? Promise.resolve({ ...PO_BOX_SKIP, carrier: 'Stallion' })
    : stallionEnabled()
      ? quoteStallion(shipment, budget)
      : Promise.resolve({
          status: 'skipped',
          carrier: 'Stallion',
          rates: [],
          message: stallionScheduleEnabled()
            ? 'Stallion outside weekly window (Mon/Tue 05:00–11:30 America/Toronto)'
            : 'Stallion is disabled (STALLION_ENABLED=false)',
        });
  if (poBox) {
    const orderRef = shipment?.orderNumber || shipment?.orderId || 'unknown';
    console.log(`[usa-rate-shop] PO Box dest → Canada Post only order=${orderRef}`);
  } else if (!stallionEnabled()) {
    console.log(
      stallionScheduleEnabled()
        ? '[usa-rate-shop] Stallion skipped (outside Mon/Tue 05:00–11:30 America/Toronto window)'
        : '[usa-rate-shop] Stallion skipped (STALLION_ENABLED=false)',
    );
  }

  const [stallionResult, upsResult, cpResult] = await Promise.allSettled([
    stallionQuote,
    poBox ? Promise.resolve({ ...PO_BOX_SKIP, carrier: 'UPS' }) : quoteUpsRates(shipment, budget),
    quoteCanadaPostUs(shipment, budget),
  ]);

  const stallion =
    stallionResult.status === 'fulfilled'
      ? stallionResult.value
      : {
          status: 'error',
          carrier: 'Stallion',
          rates: [],
          message: String(stallionResult.reason),
        };
  const canadaPost =
    cpResult.status === 'fulfilled'
      ? cpResult.value
      : {
          carrier: 'Canada Post',
          status: 'error',
          rates: [],
          ratingError: String(cpResult.reason),
        };
  const upsRating =
    upsResult.status === 'fulfilled'
      ? upsResult.value
      : {
          status: 'error',
          rates: [],
          error: String(upsResult.reason),
        };
  const zonosDuty = pickCanadaPostZonosDuties(canadaPost);
  const stallionDuty = pickStallionDuty(stallion);
  const zonosUnavailable = zonosDuty.status !== 'ok';
  const dutyDelta =
    !zonosUnavailable &&
    stallionEnabled() &&
    dutiesDivergeOver50(stallionDuty, zonosDuty.duties);
  const postageOnly = zonosUnavailable || dutyDelta;
  /** @type {'zonos_unavailable' | 'duty_delta' | null} */
  const compareReason = zonosUnavailable
    ? 'zonos_unavailable'
    : dutyDelta
      ? 'duty_delta'
      : null;
  const cpTimedOut = isCanadaPostQuoteTimeout({ canadaPost });
  if (zonosUnavailable) {
    console.warn(
      `[usa-rate-shop] Zonos duties unavailable (${zonosDuty.error || canadaPost.zonosError || canadaPost.status}) — ranking by postage`,
    );
  } else if (dutyDelta) {
    console.warn(
      `[usa-rate-shop] Stallion duty CAD ${Number(stallionDuty).toFixed(2)} vs Zonos CAD ${Number(zonosDuty.duties).toFixed(2)} diverge >50% — ranking by postage`,
    );
  }
  const ups = combineUpsQuoteResults(upsRating, zonosDuty);
  const ranked = rankCadLanded(
    {
      stallion,
      ups,
      canadaPost: cpTimedOut ? { ...canadaPost, rates: [] } : canadaPost,
    },
    { postageOnly, shopName: shipment?.shopName },
  );

  return {
    stallion,
    ups,
    canadaPost,
    poBox,
    compareMode: postageOnly ? 'postage' : 'landed',
    compareReason,
    ranked,
  };
}
