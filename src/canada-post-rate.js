import { canadaPostAuthHeaders, clearCanadaPostTokenCache } from './canada-post-auth.js';
import {
  assertCanadaPostQuoteCredentials,
  assertCanadaPostQuoteOnlyUrl,
  CANADA_POST_PRICES_MAX_ROUNDS,
  CANADA_POST_PRICES_ROUND_MS,
  CANADA_POST_QUOTE_TIMEOUT_MS,
  canadaPostContractId,
  canadaPostCustomerNumber,
  canadaPostPickupPostal,
  canadaPostPricesUrl,
  canadaPostServiceCodes,
  canadaPostServiceDisplayName,
  normalizePostal,
} from './canada-post-config.js';
import {
  CANADA_POST_HTTP_FAMILY,
  canadaPostFetchRace,
  invalidateCanadaPostIpv4,
  isCanadaPostHangError,
  resetCanadaPostHttpAgent,
} from './canada-post-http.js';
import {
  CANADA_POST_US_OVERSIZE_NO_SERVICE_MSG,
  canadaPostUsParcelExceedsShoppedServices,
  canadaPostUsParcelMetricsFromPackage,
  packageWeightKg,
} from './canada-post-us-limits.js';

function inchesToCm1(inches) {
  return Math.round(Number(inches) * 2.54 * 10) / 10;
}

function usZip(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length >= 9) return `${digits.slice(0, 5)}-${digits.slice(5, 9)}`;
  return digits.slice(0, 5);
}

/**
 * Build Get Rates body for US destination services.
 * @param {Record<string, unknown>} shipment
 */
export function buildCanadaPostUsRateBody(shipment) {
  const pkg = shipment.packages?.[0];
  if (!pkg) throw new Error('Canada Post quote requires at least one package');

  const origin =
    normalizePostal(shipment.from?.postalCode || shipment.from?.postal_code) ||
    canadaPostPickupPostal();
  const dest = usZip(shipment.to?.postalCode || shipment.to?.postal_code || shipment.to?.zip);
  if (!dest || dest.length < 5) {
    throw new Error('Canada Post US quote requires a 5-digit destination ZIP');
  }

  const weight = packageWeightKg(pkg);
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new Error('Canada Post quote requires a positive package weight');
  }

  /** @type {Record<string, unknown>} */
  const parcelCharacteristics = { weight };

  const metrics = canadaPostUsParcelMetricsFromPackage(pkg);
  if (metrics) {
    // Length = longest side (Canada Post convention).
    parcelCharacteristics.dimensions = {
      length: metrics.lengthCm,
      width: metrics.widthCm,
      height: metrics.heightCm,
    };
  } else {
    const length = Number(pkg.lengthIn ?? pkg.length);
    const width = Number(pkg.widthIn ?? pkg.width);
    const height = Number(pkg.heightIn ?? pkg.height);
    if ([length, width, height].every((v) => Number.isFinite(v) && v > 0)) {
      parcelCharacteristics.dimensions = {
        length: inchesToCm1(length),
        width: inchesToCm1(width),
        height: inchesToCm1(height),
      };
    }
  }

  /** @type {Record<string, unknown>} */
  const body = {
    quoteType: 'commercial',
    services: canadaPostServiceCodes(),
    originPostalCode: origin,
    destination: {
      unitedStates: { zipCode: dest },
    },
    parcelCharacteristics,
  };

  const customer = canadaPostCustomerNumber();
  const contract = canadaPostContractId();
  if (customer) body.customerNumber = customer;
  if (contract) body.contractId = contract;

  return body;
}

/**
 * @param {unknown} data
 * @param {string[]} [allow]
 */
export function normalizeCanadaPostUsRates(data, allow = canadaPostServiceCodes()) {
  const list = Array.isArray(data) ? data : [];
  return list
    .map((q) => {
      const code = String(q?.serviceCode || '').toUpperCase();
      const shipping = Number(q?.priceDetails?.due);
      if (!allow.includes(code) || !Number.isFinite(shipping)) return null;
      const transit = q?.serviceStandard?.expectedTransitTime;
      return {
        serviceCode: code,
        serviceName: q?.serviceName || canadaPostServiceDisplayName(code),
        shipping,
        currency: 'CAD',
        transitDays:
          transit == null || !Number.isFinite(Number(transit)) ? null : Number(transit),
        raw: q,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.shipping - b.shipping);
}

const CP_HANG_MESSAGE_RE =
  /timeout|timed out|aborted|AbortError|TimeoutError|budget exhausted|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR/i;

function isHangMessage(message) {
  return CP_HANG_MESSAGE_RE.test(String(message || ''));
}

/**
 * Quote errored and parcel exceeds USA.EP / USA.XP limits → treat as no-service
 * so the shop prints the next cheapest carrier. Hangs/timeouts are not skipped.
 * @param {string} message
 * @param {Record<string, unknown>} shipment
 */
export function canadaPostUsShouldSkipOversizeError(message, shipment) {
  if (!message || isHangMessage(message)) return false;
  const metrics = canadaPostUsParcelMetricsFromPackage(shipment?.packages?.[0]);
  return canadaPostUsParcelExceedsShoppedServices(canadaPostServiceCodes(), metrics);
}

function oversizeNoServiceResult(request = null, raw = null) {
  return {
    status: 'no_rate',
    rates: [],
    request,
    raw,
    error: CANADA_POST_US_OVERSIZE_NO_SERVICE_MSG,
  };
}

/**
 * Quote Canada Post US rates only (POST /prices). Never creates labels.
 * Always calls Canada Post. If the quote errors and the parcel exceeds USA.EP /
 * USA.XP limits, returns no-service so the shop can print the next cheapest.
 * Hangs / timeouts are not converted to no-service.
 * @param {Record<string, unknown>} shipment
 * @param {number} [timeoutMs]
 */
export async function quoteCanadaPostUsRates(
  shipment,
  timeoutMs = CANADA_POST_QUOTE_TIMEOUT_MS,
) {
  try {
    assertCanadaPostQuoteCredentials();
    const url = canadaPostPricesUrl();
    assertCanadaPostQuoteOnlyUrl(url, 'rating');
    const body = buildCanadaPostUsRateBody(shipment);
    const dest = String(body.destination?.unitedStates?.zipCode || '');

    const budgetMs = Math.max(1500, Number(timeoutMs) || CANADA_POST_QUOTE_TIMEOUT_MS);
    const started = Date.now();
    /** @type {Record<string, string>} */
    let headers = await canadaPostAuthHeaders(budgetMs);

    const remaining = () => Math.max(0, budgetMs - (Date.now() - started));
    let authRetried = false;

    for (;;) {
      const pricesStart = Date.now();
      /** @type {Response | undefined} */
      let response;
      /** @type {unknown} */
      let lastErr;
      let attempt = 1;
      for (attempt = 1; attempt <= CANADA_POST_PRICES_MAX_ROUNDS; attempt += 1) {
        const left = remaining();
        if (left < 800) {
          if (lastErr) throw lastErr;
          throw new Error(`Canada Post quote budget exhausted (${budgetMs}ms)`);
        }
        const roundMs = Math.min(CANADA_POST_PRICES_ROUND_MS, left);
        try {
          response = await canadaPostFetchRace(
            url,
            {
              method: 'POST',
              headers,
              body: JSON.stringify(body),
            },
            roundMs,
          );
          break;
        } catch (err) {
          lastErr = err;
          const name = err instanceof Error ? err.name : 'Error';
          invalidateCanadaPostIpv4(new URL(url).hostname);
          resetCanadaPostHttpAgent();
          if (!isCanadaPostHangError(err) || attempt >= CANADA_POST_PRICES_MAX_ROUNDS) throw err;
          console.warn(
            `[canada-post-usa] quote retry after ${name} round=${attempt}/${CANADA_POST_PRICES_MAX_ROUNDS} ` +
              `roundMs=${roundMs} leftMs=${remaining()} dest=${dest} family=${CANADA_POST_HTTP_FAMILY} pinned=ipv4`,
          );
        }
      }
      if (!response) {
        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr || 'Canada Post quote failed'));
      }
      const pricesMs = Date.now() - pricesStart;

      const text = await response.text();

      if (response.status === 401 && !authRetried && remaining() >= 1200) {
        authRetried = true;
        clearCanadaPostTokenCache();
        resetCanadaPostHttpAgent();
        console.warn(
          `[canada-post-usa] quote HTTP 401 — refreshing OAuth and retrying dest=${dest} ` +
            `body=${text.slice(0, 120).replace(/\s+/g, ' ')}`,
        );
        headers = await canadaPostAuthHeaders(remaining(), { forceRefresh: true });
        continue;
      }

      let raw;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error(`Canada Post rates returned non-JSON (HTTP ${response.status})`);
      }

      if (!response.ok) {
        const message =
          raw?.errorDescription ||
          raw?.errorMessage ||
          raw?.detail ||
          raw?.title ||
          raw?.errors?.[0]?.message ||
          raw?.message ||
          `Canada Post rates HTTP ${response.status}`;
        const msg = String(message);
        if (canadaPostUsShouldSkipOversizeError(msg, shipment)) {
          console.warn(
            `[canada-post-usa] quote error on oversize parcel — treating as no service: ${msg}`,
          );
          return oversizeNoServiceResult(body, raw);
        }
        throw new Error(msg);
      }

      const rates = normalizeCanadaPostUsRates(raw);
      const servicePrices = rates.map((r) => `${r.serviceCode}=$${r.shipping}`).join(' ');
      console.log(
        `[canada-post-usa] quote ok prices=${pricesMs}ms attempt=${attempt} dest=${dest} ` +
          `family=${CANADA_POST_HTTP_FAMILY} pinned=ipv4 services=${servicePrices || '(none)'}`,
      );
      return {
        status: rates.length ? 'ok' : 'no_rate',
        rates,
        request: body,
        raw,
        error: rates.length ? null : `No rates for ${canadaPostServiceCodes().join(', ')}`,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (canadaPostUsShouldSkipOversizeError(message, shipment)) {
      console.warn(
        `[canada-post-usa] quote error on oversize parcel — treating as no service: ${message}`,
      );
      return oversizeNoServiceResult();
    }
    return {
      status: 'error',
      rates: [],
      error: message,
      raw: null,
    };
  }
}
