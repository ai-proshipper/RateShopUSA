import { upsQuoteHeaders } from './ups-auth.js';
import {
  assertUpsQuoteCredentials,
  assertUpsQuoteOnlyUrl,
  UPS_QUOTE_TIMEOUT_MS,
  isUpsQuoteService,
  upsAccountNumber,
  upsPostalCode,
  upsRatingUrl,
  upsServiceName,
} from './ups-config.js';

function party(address, includeAccount = false) {
  const source = address || {};
  const lines = [source.address1, source.address2]
    .map((line) => String(line || '').trim())
    .filter(Boolean);
  const countryCode = String(source.country || source.country_code || 'CA')
    .slice(0, 2)
    .toUpperCase();
  const mapped = {
    Name: String(source.name || source.company || 'Shipper').slice(0, 35),
    Address: {
      AddressLine: lines.length ? lines : ['N/A'],
      City: String(source.city || '').slice(0, 30),
      StateProvinceCode: String(source.state || source.province || '').slice(
        0,
        5,
      ),
      PostalCode: upsPostalCode(
        source.postalCode || source.postal_code || source.zip,
        countryCode,
      ),
      CountryCode: countryCode,
    },
  };

  if (
    source.is_residential === true ||
    source.residential === true ||
    !String(source.company || '').trim()
  ) {
    mapped.Address.ResidentialAddressIndicator = 'Y';
  }
  if (source.phone) {
    mapped.Phone = {
      Number: String(source.phone).replace(/[^\d+]/g, '').slice(0, 15),
    };
  }
  if (includeAccount) {
    mapped.ShipperNumber = upsAccountNumber();
  }
  return mapped;
}

function packageWeightLbs(pkg) {
  if (pkg.weightLbs != null) return Number(pkg.weightLbs);
  if (pkg.weightOz != null) return Number(pkg.weightOz) / 16;
  if (pkg.weight != null && String(pkg.weight_unit).toLowerCase() === 'lbs') {
    return Number(pkg.weight);
  }
  throw new Error('UPS Rating requires package weight in pounds or ounces');
}

function mapPackage(pkg) {
  const weight = packageWeightLbs(pkg);
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new Error('UPS Rating requires a positive package weight');
  }
  const length = Number(pkg.lengthIn ?? pkg.length);
  const width = Number(pkg.widthIn ?? pkg.width);
  const height = Number(pkg.heightIn ?? pkg.height);
  if (![length, width, height].every((value) => value > 0)) {
    throw new Error('UPS Rating requires positive package dimensions');
  }

  return {
    PackagingType: { Code: '02', Description: 'Customer Supplied Package' },
    Dimensions: {
      UnitOfMeasurement: { Code: 'IN', Description: 'Inches' },
      Length: String(Math.max(1, Math.ceil(length))),
      Width: String(Math.max(1, Math.ceil(width))),
      Height: String(Math.max(1, Math.ceil(height))),
    },
    PackageWeight: {
      UnitOfMeasurement: { Code: 'LBS', Description: 'Pounds' },
      Weight: String(Math.round(weight * 100) / 100),
    },
  };
}

export function buildUpsRateBody(shipment) {
  if (!shipment?.from) {
    throw new Error('UPS Rating requires a ship-from address');
  }
  if (!shipment?.to) {
    throw new Error('UPS Rating requires a ship-to address');
  }
  if (!Array.isArray(shipment.packages) || shipment.packages.length === 0) {
    throw new Error('UPS Rating requires at least one package');
  }

  return {
    RateRequest: {
      Request: {
        TransactionReference: {
          CustomerContext:
            shipment.orderNumber || shipment.orderId || 'rateshop-usa',
        },
      },
      Shipment: {
        Shipper: party(shipment.from, true),
        ShipFrom: party(shipment.from),
        ShipTo: party(shipment.to),
        PaymentDetails: {
          ShipmentCharge: {
            Type: '01',
            BillShipper: { AccountNumber: upsAccountNumber() },
          },
        },
        NumOfPieces: String(shipment.packages.length),
        Package: shipment.packages.map(mapPackage),
        ShipmentRatingOptions: {
          NegotiatedRatesIndicator: 'Y',
        },
        // Pickup Date (YYYYMMDD) + Time (HHMM) required for Time In Transit.
        DeliveryTimeInformation: {
          PackageBillType: '03',
          Pickup: upsPickupDateTime(),
        },
      },
    },
  };
}

/**
 * America/Toronto YYYYMMDD + HHMM for UPS DeliveryTimeInformation.Pickup.
 * @param {Date} [now]
 */
export function upsPickupDateTime(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  const date = `${get('year')}${get('month')}${get('day')}`;
  const envTime = String(process.env.UPS_PICKUP_TIME || '').trim();
  const time =
    /^\d{4}(\d{2})?$/.test(envTime) ? envTime : `${get('hour')}${get('minute')}`;
  return { Date: date, Time: time };
}

function money(charge) {
  const amount = Number(charge?.MonetaryValue);
  if (!Number.isFinite(amount)) return null;
  return {
    amount,
    currency: String(charge?.CurrencyCode || 'CAD').toUpperCase(),
  };
}

/**
 * @param {unknown} data
 * @param {Record<string, unknown>} shipment Used to filter shopped UPS services.
 */
export function normalizeUpsRates(data, shipment) {
  const rawRates = data?.RateResponse?.RatedShipment;
  const list = Array.isArray(rawRates)
    ? rawRates
    : rawRates
      ? [rawRates]
      : [];

  return list
    .map((rated) => {
      const code = String(rated?.Service?.Code || '').padStart(2, '0');
      if (!isUpsQuoteService(code, shipment)) return null;

      const negotiated = money(
        rated?.NegotiatedRateCharges?.TotalCharge,
      );
      if (!negotiated) {
        throw new Error(
          `UPS Rating missing negotiated rate for service ${code} (${upsServiceName(code)})`,
        );
      }

      const arrival = rated?.TimeInTransit?.ServiceSummary?.EstimatedArrival;
      const transitValue =
        arrival?.BusinessDaysInTransit ??
        arrival?.BusinessTransitDays ??
        rated?.GuaranteedDelivery?.BusinessDaysInTransit;
      const transitDays =
        transitValue == null || !Number.isFinite(Number(transitValue))
          ? null
          : Number(transitValue);

      return {
        serviceCode: code,
        serviceName: upsServiceName(code),
        shipping: negotiated.amount,
        currency: negotiated.currency,
        negotiated: true,
        transitDays,
        raw: rated,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.shipping - b.shipping);
}

function apiError(data, status) {
  return (
    data?.response?.errors?.[0]?.message ||
    data?.RateResponse?.Response?.ResponseStatus?.Description ||
    `UPS Rating HTTP ${status}`
  );
}

export async function quoteUpsRates(
  shipment,
  timeoutMs = UPS_QUOTE_TIMEOUT_MS,
) {
  try {
    assertUpsQuoteCredentials();
    const url = upsRatingUrl();
    assertUpsQuoteOnlyUrl(url, 'rating');
    const body = buildUpsRateBody(shipment);
    const headers = await upsQuoteHeaders(Math.min(timeoutMs, 10000));
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`UPS Rating returned non-JSON (HTTP ${response.status})`);
    }
    if (!response.ok) {
      throw new Error(apiError(raw, response.status));
    }

    const rates = normalizeUpsRates(raw, shipment);
    return {
      status: rates.length ? 'ok' : 'no_rate',
      rates,
      request: body,
      raw,
      error: rates.length ? null : 'UPS returned no shipping rates',
    };
  } catch (error) {
    return {
      status: 'error',
      rates: [],
      error: error instanceof Error ? error.message : String(error),
      raw: null,
    };
  }
}
