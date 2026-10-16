/**
 * ShipHero Generate Label Webhook response helpers.
 * Same JSON contract as CAD Rate Shop so a future dest-country router can dispatch in-process.
 * @see https://developer.shiphero.com/webhooks/generate-label-webhook/
 */

import {
  LABEL_COST_TOO_HIGH_MSG,
  LANDED_COST_TOO_HIGH_MSG,
  MAX_LABEL_COST,
  MAX_LANDED_COST,
} from './config.js';

const LABEL_URL_PATTERN = /\.(pdf|png)(\?|$)/i;
const MAX_TRACKING_LEN = 45;
const MAX_URL_LEN = 255;

/**
 * @param {unknown} cost
 * @param {number} [maxCost=MAX_LABEL_COST]
 */
export function assertLabelCostAllowed(cost, maxCost = MAX_LABEL_COST) {
  const number = Number(cost);
  const cap = Number(maxCost);
  const limit = Number.isFinite(cap) ? cap : MAX_LABEL_COST;
  if (Number.isFinite(number) && number > limit) {
    throw new Error(LABEL_COST_TOO_HIGH_MSG);
  }
}

/**
 * @param {unknown} landed
 */
export function assertLandedCostAllowed(landed) {
  const number = Number(landed);
  if (Number.isFinite(number) && number > MAX_LANDED_COST) {
    throw new Error(LANDED_COST_TOO_HIGH_MSG);
  }
}

/** @param {string} message */
export function shipHeroErrorResponse(message, code = '500') {
  return { code: String(code), error: message };
}

/**
 * @param {Record<string, unknown>} response
 * @param {{ maxLabelCost?: number }} [opts]
 * @returns {Record<string, string>}
 */
export function normalizeShipHeroLabelResponse(response, opts = {}) {
  const label = String(response.label || '');
  if (!label) {
    throw new Error('Label URL is required in ShipHero webhook response');
  }
  if (!LABEL_URL_PATTERN.test(label)) {
    throw new Error('Label URL must end with .pdf or .png');
  }
  if (label.length > MAX_URL_LEN) {
    throw new Error(`Label URL exceeds ShipHero limit (${MAX_URL_LEN} chars)`);
  }

  const tracking = String(response.tracking_number || '');
  let trackingUrl = String(response.tracking_url || '');
  if (trackingUrl.length > MAX_URL_LEN) {
    console.warn(
      `[shiphero-response] tracking_url is ${trackingUrl.length} chars (>${MAX_URL_LEN}) — omitting`,
    );
    trackingUrl = '';
  }
  if (trackingUrl && !tracking) {
    console.warn('[shiphero-response] tracking_url without tracking_number — omitting tracking_url');
    trackingUrl = '';
  }

  const customs = response.customs_info != null ? String(response.customs_info) : '';
  if (customs && !LABEL_URL_PATTERN.test(customs) && customs.length > 0) {
    throw new Error('customs_info must be a .pdf or .png URL when provided');
  }
  if (customs.length > MAX_URL_LEN) {
    throw new Error(`customs_info exceeds ShipHero limit (${MAX_URL_LEN} chars)`);
  }

  const costRaw = response.cost != null ? response.cost : '0.00';
  const costNum = Number(costRaw);
  const cost = Number.isFinite(costNum) ? costNum.toFixed(2) : '0.00';
  assertLabelCostAllowed(cost, opts.maxLabelCost);

  return {
    code: '200',
    shipping_method: String(response.shipping_method || 'API Shipping').slice(0, 45),
    shipping_carrier: String(response.shipping_carrier || 'api').slice(0, 45),
    tracking_number: tracking.slice(0, MAX_TRACKING_LEN),
    cost,
    label,
    tracking_url: trackingUrl,
    customs_info: customs,
  };
}
