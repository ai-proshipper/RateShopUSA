import { isCad } from './currency.js';
import { quoteUpsRates } from './ups-rate.js';
import {
  UPS_DISBURSEMENT_FEE_CAD,
  UPS_QUOTE_TIMEOUT_MS,
} from './ups-config.js';

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function emptyZonosDuty(error) {
  return {
    status: 'unavailable',
    currency: 'CAD',
    duties: null,
    dutyItems: [],
    feeItems: [],
    sourceService: null,
    error: error || 'Zonos duties unavailable',
  };
}

/**
 * UPS ranking uses Zonos duty amount only — never Zonos taxes or Zonos fees.
 * @param {Record<string, unknown> | null | undefined} landed
 */
export function pickZonosDutiesFromLanded(landed) {
  if (
    landed?.status === 'ok' &&
    isCad(landed.currency) &&
    Number.isFinite(Number(landed.duties))
  ) {
    return {
      status: 'ok',
      currency: String(landed.currency || 'CAD').toUpperCase(),
      duties: Number(landed.duties),
      dutyItems: Array.isArray(landed.dutyItems) ? landed.dutyItems : [],
      feeItems: Array.isArray(landed.feeItems) ? landed.feeItems : [],
      sourceService: landed.sourceService || null,
      error: null,
    };
  }
  return emptyZonosDuty(landed?.error || 'Zonos duties unavailable');
}

/**
 * First CP rate with Zonos duties. Live UPS ranking uses this — no UPS Zonos call.
 * @param {{ rates?: Array<Record<string, unknown>>, ratingError?: string|null, zonosError?: string|null } | null | undefined} cpQuote
 */
export function pickCanadaPostZonosDuties(cpQuote) {
  const rate = (cpQuote?.rates || []).find(
    (row) =>
      row.duty_source === 'api' && Number.isFinite(Number(row.duty)),
  );
  if (!rate) {
    return emptyZonosDuty(
      cpQuote?.zonosError ||
        cpQuote?.ratingError ||
        'Canada Post Zonos duties unavailable',
    );
  }
  return pickZonosDutiesFromLanded({
    status: 'ok',
    currency: rate.landedCurrency || 'CAD',
    duties: Number(rate.duty),
    dutyItems: rate.dutyItems,
    feeItems: rate.feeItems,
    sourceService: rate.serviceCode || null,
    error: null,
  });
}

/**
 * UPS shipping + Zonos duties from Canada Post + UPS $4.80 disbursement.
 * Does not add Zonos taxes or Zonos fees. Does not call Zonos.
 * @param {{ status: string, rates?: any[], error?: string|null, raw?: unknown }} rating
 * @param {{ status: string, currency?: string, duties?: number|null, error?: string|null, sourceService?: string|null }} zonosDuty
 */
export function combineUpsQuoteResults(rating, zonosDuty) {
  const dutyUsable =
    zonosDuty?.status === 'ok' &&
    isCad(zonosDuty.currency) &&
    Number.isFinite(zonosDuty.duties);

  const disbursement = dutyUsable ? UPS_DISBURSEMENT_FEE_CAD : null;
  const importCharges = dutyUsable
    ? roundMoney(Number(zonosDuty.duties) + UPS_DISBURSEMENT_FEE_CAD)
    : null;

  const rates = (rating.rates || []).map((rate) => {
    const currencyCompatible = isCad(rate.currency);
    const landedTotal =
      dutyUsable && currencyCompatible
        ? roundMoney(rate.shipping + importCharges)
        : null;
    return {
      ...rate,
      duty: dutyUsable ? Number(zonosDuty.duties) : null,
      brokerage: disbursement,
      importCharges: dutyUsable && currencyCompatible ? importCharges : null,
      dutyItems: dutyUsable ? zonosDuty.dutyItems || [] : [],
      landedTotal,
      landedCurrency: landedTotal == null ? null : 'CAD',
      duty_source: dutyUsable ? 'zonos' : 'unavailable',
      landedError:
        !currencyCompatible && dutyUsable
          ? `Cannot combine ${rate.currency} shipping with CAD import charges`
          : zonosDuty?.error || null,
    };
  });

  return {
    carrier: 'UPS',
    status:
      rating.status === 'ok'
        ? dutyUsable
          ? 'ok'
          : 'shipping_only'
        : rating.status,
    rates,
    zonosDuty,
    ratingError: rating.error || null,
    raw: {
      rating: rating.raw || null,
      zonosDuty,
    },
  };
}

/**
 * UPS postage only. Pass Canada Post Zonos via options.zonosDuty for landed totals.
 * @param {Record<string, unknown>} shipment
 * @param {number} [timeoutMs]
 * @param {{ zonosDuty?: Record<string, unknown> }} [options]
 */
export async function quoteUps(
  shipment,
  timeoutMs = UPS_QUOTE_TIMEOUT_MS,
  options = {},
) {
  const rating = await quoteUpsRates(shipment, timeoutMs);
  const zonosDuty =
    options.zonosDuty || emptyZonosDuty('Canada Post Zonos duties unavailable');
  return combineUpsQuoteResults(rating, zonosDuty);
}
