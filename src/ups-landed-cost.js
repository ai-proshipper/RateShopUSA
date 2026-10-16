import { randomUUID } from 'node:crypto';
import { upsQuoteHeaders } from './ups-auth.js';
import { assertSingleDeclaredCurrency } from './currency.js';
import {
  assertUpsQuoteCredentials,
  assertUpsQuoteOnlyUrl,
  UPS_QUOTE_TIMEOUT_MS,
  upsAccountNumber,
  upsLandedCostUrl,
} from './ups-config.js';

function country(address, fallback) {
  return String(
    address?.country || address?.country_code || fallback || '',
  )
    .slice(0, 2)
    .toUpperCase();
}

function totalPackageWeightLbs(packages) {
  return (packages || []).reduce((sum, pkg) => {
    if (pkg.weightLbs != null) return sum + Number(pkg.weightLbs);
    if (pkg.weightOz != null) return sum + Number(pkg.weightOz) / 16;
    if (
      pkg.weight != null &&
      String(pkg.weight_unit || '').toLowerCase() === 'lbs'
    ) {
      return sum + Number(pkg.weight);
    }
    return sum;
  }, 0);
}

function normalizedHsCode(value) {
  return String(value || '').replace(/\D/g, '');
}

export function buildUpsLandedCostBody(shipment) {
  if (!shipment?.from || !shipment?.to) {
    throw new Error('UPS Landed Cost requires ship-from and ship-to addresses');
  }
  if (!Array.isArray(shipment.items) || shipment.items.length === 0) {
    throw new Error('UPS Landed Cost requires at least one customs item');
  }

  const totalQuantity = shipment.items.reduce(
    (sum, item) => sum + Math.max(1, Number(item.quantity) || 1),
    0,
  );
  const packageWeight = totalPackageWeightLbs(shipment.packages);
  const declaredCurrency = assertSingleDeclaredCurrency(shipment.items, shipment);

  const shipmentItems = shipment.items.map((item, index) => {
    const quantity = Math.max(1, Number(item.quantity) || 1);
    const value = Number(item.value ?? item.customs_value);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`UPS Landed Cost item ${index + 1} needs a customs value`);
    }
    const origin = country(
      { country: item.country_of_origin || item.originCountryCode },
      null,
    );
    if (!origin) {
      throw new Error(
        `UPS Landed Cost item ${index + 1} needs country of origin`,
      );
    }
    const hsCode = normalizedHsCode(item.hs_code || item.hsCode);
    const description = String(
      item.customs_description || item.description || item.title || '',
    ).slice(0, 150);
    if (!hsCode && !description) {
      throw new Error(
        `UPS Landed Cost item ${index + 1} needs an HS code or description`,
      );
    }

    const explicitWeight = Number(item.weightLbs ?? item.weight_lbs);
    const allocatedWeight =
      Number.isFinite(explicitWeight) && explicitWeight > 0
        ? explicitWeight * quantity
        : packageWeight > 0
          ? packageWeight * (quantity / totalQuantity)
          : null;

    const commodity = {
      commodityId: String(item.sku || item.id || index + 1)
        .replace(/[^A-Za-z0-9_-]/g, '-')
        .slice(0, 100),
      priceEach: value,
      commodityCurrencyCode: declaredCurrency,
      quantity,
      UOM: 'Each',
      hsCode,
      description,
      originCountryCode: origin,
    };
    if (allocatedWeight != null) {
      commodity.grossWeight = Math.round(allocatedWeight * 100) / 100;
      commodity.grossWeightUnit = 'LB';
    }
    return commodity;
  });

  const transactionId = String(
    shipment.orderNumber ||
      shipment.orderId ||
      randomUUID().replaceAll('-', ''),
  ).slice(0, 50);

  return {
    currencyCode: declaredCurrency,
    transID: transactionId,
    allowPartialLandedCostResult: true,
    alversion: 1,
    shipment: {
      id: transactionId,
      importCountryCode: country(shipment.to, 'US'),
      importProvince: String(
        shipment.to.state || shipment.to.province || '',
      ).slice(0, 100),
      shipDate: new Date().toISOString().slice(0, 10),
      exportCountryCode: country(shipment.from, 'CA'),
      incoterms: 'DDP',
      shipmentItems,
      transModes: 'INT_TRUCK',
      shipmentType: 'SALE',
    },
  };
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeUpsLandedCost(data) {
  const shipment = data?.shipment;
  if (!shipment) {
    throw new Error('UPS Landed Cost response is missing shipment');
  }
  const items = Array.isArray(shipment.shipmentItems)
    ? shipment.shipmentItems
    : [];
  const allCalculable =
    items.length > 0 && items.every((item) => item.isCalculable === true);

  return {
    status: allCalculable ? 'ok' : 'partial',
    currency: String(shipment.currencyCode || 'CAD').toUpperCase(),
    totalDuties: number(shipment.totalDuties),
    totalDutyAndTax: number(
      shipment.totalDutyAndTax ?? shipment.totalDutyandTax,
    ),
    totalBrokerageFees: number(shipment.totalBrokerageFees),
    brokerageFeeItems: (shipment.brokerageFeeItems || []).map((fee) => ({
      name: fee.chargeName || 'Brokerage fee',
      amount: number(fee.chargeAmount),
    })),
    totalCommodityTaxesAndFees: number(
      shipment.totalCommodityLevelTaxesAndFees,
    ),
    totalShipmentTaxesAndFees: number(
      shipment.totalShipmentLevelTaxesAndFees,
    ),
    totalVAT: number(shipment.totalVAT),
    importCharges: number(shipment.grandTotal),
    items: items.map((item) => ({
      commodityId: item.commodityId ?? item.commodityID ?? null,
      hsCode: item.hsCode || null,
      duty: number(item.commodityDuty),
      vat: number(item.commodityVAT),
      dutyAndTax: number(
        item.totalCommodityDutyAndTax ?? item.totalCommodityDutyandTax,
      ),
      calculable: item.isCalculable === true,
    })),
  };
}

function apiError(data, status) {
  const message =
    data?.response?.errors?.[0]?.message ||
    data?.errors?.[0]?.message ||
    data?.errors?.[0]?.description ||
    data?.message ||
    null;
  if (message) return message;
  try {
    const compact = JSON.stringify(data);
    if (compact && compact !== '{}') {
      return `UPS Landed Cost HTTP ${status}: ${compact.slice(0, 500)}`;
    }
  } catch {
    // ignore
  }
  return `UPS Landed Cost HTTP ${status}`;
}

export async function quoteUpsLandedCost(
  shipment,
  timeoutMs = UPS_QUOTE_TIMEOUT_MS,
) {
  let lastRaw = null;
  let lastRequest = null;
  try {
    assertUpsQuoteCredentials();
    const url = upsLandedCostUrl();
    assertUpsQuoteOnlyUrl(url, 'landedCost');
    const body = buildUpsLandedCostBody(shipment);
    lastRequest = body;
    const headers = {
      ...(await upsQuoteHeaders(Math.min(timeoutMs, 10000))),
      AccountNumber: upsAccountNumber(),
    };
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
      throw new Error(
        `UPS Landed Cost returned non-JSON (HTTP ${response.status}): ${text.slice(0, 300)}`,
      );
    }
    lastRaw = raw;
    if (!response.ok || raw?.errors?.length) {
      throw new Error(apiError(raw, response.status));
    }
    return {
      ...normalizeUpsLandedCost(raw),
      request: body,
      raw,
      error: null,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      currency: 'CAD',
      importCharges: null,
      error: error instanceof Error ? error.message : String(error),
      request: lastRequest,
      raw: lastRaw,
    };
  }
}
