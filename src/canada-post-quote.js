import { CANADA_POST_QUOTE_TIMEOUT_MS } from './canada-post-config.js';
import { quoteCanadaPostUsRates } from './canada-post-rate.js';
import { quoteZonosLandedCost } from './zonos-landed-cost.js';

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Combine CP shipping rates with per-service Zonos import charges.
 * @param {{ status: string, rates?: any[], error?: string|null, raw?: unknown }} rating
 * @param {Array<Record<string, unknown>>} landedByService
 */
export function combineCanadaPostQuoteResults(rating, landedByService) {
  const rates = (rating.rates || []).map((rate, index) => {
    const landed = landedByService[index] || {
      status: 'unavailable',
      importCharges: null,
      error: 'Missing Zonos result',
    };
    const landedUsable =
      landed.status === 'ok' &&
      String(landed.currency || 'CAD').toUpperCase() === 'CAD' &&
      Number.isFinite(landed.importCharges);
    const currencyCompatible = rate.currency === 'CAD';
    const landedTotal =
      landedUsable && currencyCompatible
        ? roundMoney(rate.shipping + landed.importCharges)
        : null;

    return {
      ...rate,
      duty: landedUsable ? landed.duties : null,
      taxes: landedUsable ? landed.taxes : null,
      fees: landedUsable ? landed.clearanceFees ?? landed.fees : null,
      clearanceFees: landedUsable ? landed.clearanceFees ?? landed.fees : null,
      guaranteeFee: landedUsable ? landed.guaranteeFee || 0 : null,
      importCharges: landedUsable ? landed.importCharges : null,
      dutyItems: landedUsable ? landed.dutyItems || [] : [],
      taxItems: landedUsable ? landed.taxItems || [] : [],
      feeItems: landedUsable ? landed.feeItems || [] : [],
      landedTotal,
      landedCurrency: landedTotal == null ? null : 'CAD',
      duty_source: landedUsable ? 'api' : 'unavailable',
      landedError: landedUsable
        ? null
        : !currencyCompatible && landed.status === 'ok'
          ? `Cannot combine ${rate.currency} shipping with CAD import charges`
          : landed.error || null,
      zonosRaw: landed.raw || null,
      zonosRequest: landed.request || null,
    };
  });

  const anyLanded = rates.some((r) => r.duty_source === 'api');
  const zonosError = anyLanded
    ? null
    : rates.map((r) => r.landedError).find(Boolean) || null;
  return {
    carrier: 'Canada Post',
    status:
      rating.status === 'ok'
        ? anyLanded
          ? 'ok'
          : 'shipping_only'
        : rating.status,
    rates,
    ratingError: rating.error || null,
    zonosError,
    raw: {
      rating: rating.raw || null,
      zonos: rates.map((r) => r.zonosRaw),
    },
  };
}

/**
 * Canada Post US rates + Zonos duty/tax/fees per service.
 * UPS ranking reuses this Zonos duty. Does not call a separate UPS Zonos quote.
 * @param {Record<string, unknown>} shipment
 * @param {number} [timeoutMs]
 */
export async function quoteCanadaPostUs(
  shipment,
  timeoutMs = CANADA_POST_QUOTE_TIMEOUT_MS,
) {
  const budget = Math.max(1500, Number(timeoutMs) || CANADA_POST_QUOTE_TIMEOUT_MS);
  const started = Date.now();
  const rating = await quoteCanadaPostUsRates(shipment, budget);
  if (!rating.rates?.length) {
    return {
      carrier: 'Canada Post',
      status: rating.status,
      rates: [],
      ratingError: rating.error || null,
      zonosError: null,
      raw: { rating: rating.raw || null, zonos: [] },
    };
  }

  const zonosBudget = Math.max(1500, budget - (Date.now() - started));
  const landedResults = await Promise.all(
    rating.rates.map((rate) =>
      quoteZonosLandedCost(
        shipment,
        {
          shipping: rate.shipping,
          currency: rate.currency,
          serviceCode: rate.serviceCode,
          serviceName: rate.serviceName,
        },
        zonosBudget,
      ),
    ),
  );

  return combineCanadaPostQuoteResults(rating, landedResults);
}
