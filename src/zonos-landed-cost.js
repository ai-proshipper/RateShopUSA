import {
  CANADA_POST_QUOTE_TIMEOUT_MS,
} from './canada-post-config.js';
import { resolveDeclaredCurrency } from './currency.js';

const ZONOS_QUOTE_TIMEOUT_MS =
  Number(process.env.ZONOS_QUOTE_TIMEOUT_MS) || CANADA_POST_QUOTE_TIMEOUT_MS;

/** Fallback when the CP service is not a known USA code. */
export const ZONOS_CANADA_POST_SERVICE_LEVEL = 'canada_post.custom';

const ZONOS_CP_SERVICE_LEVELS = {
  'USA.EP': 'canada_post.expedited_parcel_usa',
  'USA.XP': 'canada_post.xpresspost_usa',
  'USA.TP': 'canada_post.tracked_packet_usa',
};

const GUARANTEE_FEE_TYPES = new Set([
  'zonos_landed_cost_guarantee',
  'ZONOS_LANDED_COST_GUARANTEE',
]);

/** HTS chapter 76. CBP/Zonos treat missing smelt/cast as 200% Russia aluminum. */
function isAluminumHs(hsDigits) {
  return String(hsDigits || '').startsWith('76');
}

/**
 * Attach CA smelt/cast when aluminum 232 may apply.
 * Chapter 76 always; also when description says aluminum/aluminium (e.g. pins on 73xx)
 * or when the item explicitly sets smelt/cast countries.
 *
 * Note: Zonos docs (Jul 24 2026+) say postal/international mail does not yet support
 * smelt/cast reporting, so Canada Post quotes may still default to 200%. Formal/commercial
 * entry can use these fields. Still send them so commercial paths and future postal support work.
 * @param {Record<string, unknown>} item
 * @param {string} hsDigits
 */
export function needsAluminumSmeltCast(item, hsDigits) {
  if (isAluminumHs(hsDigits)) return true;
  if (
    item?.country_of_smelt ||
    item?.primaryCountryOfSmelt ||
    item?.country_of_cast ||
    item?.countryOfCast
  ) {
    return true;
  }
  const desc = String(
    item?.customs_description || item?.description || item?.title || '',
  ).toLowerCase();
  return desc.includes('aluminum') || desc.includes('aluminium');
}

/**
 * Aluminum smelt + cast countries for Section 232.
 * Default smelt/cast Canada; override with item.country_of_smelt / country_of_cast.
 * @param {Record<string, unknown>} item
 */
export function aluminumSmeltCastComposition(item) {
  return {
    material: 'aluminum',
    percentage: 100,
    primaryCountryOfSmelt: country(
      { country: item?.country_of_smelt || item?.primaryCountryOfSmelt },
      'CA',
    ),
    countryOfCast: country(
      { country: item?.country_of_cast || item?.countryOfCast },
      'CA',
    ),
  };
}

function env(name) {
  return String(process.env[name] || '').trim();
}

export function zonosApiKey() {
  return env('ZONOS_API_KEY');
}

export function zonosGraphqlUrl() {
  const base = (env('ZONOS_BASE_URL') || 'https://api.zonos.com').replace(/\/$/, '');
  return `${base}/graphql`;
}

/**
 * Only allow GraphQL quote endpoint — refuse order/label shipment create URLs.
 * @param {string} url
 */
export function assertZonosQuoteOnlyUrl(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== 'api.zonos.com') {
    throw new Error('Zonos refused: unexpected host');
  }
  if (!parsed.pathname.endsWith('/graphql')) {
    throw new Error('Zonos refused: endpoint is not GraphQL quote path');
  }
}

export function assertZonosCredentials() {
  if (!zonosApiKey()) {
    throw new Error('ZONOS_API_KEY is required');
  }
}

function splitName(name) {
  const parts = String(name || 'Customer').trim().split(/\s+/);
  const firstName = parts[0] || 'Customer';
  const lastName = parts.slice(1).join(' ') || 'Customer';
  return { firstName, lastName };
}

function country(addr, fallback) {
  return String(addr?.country || addr?.country_code || fallback || '')
    .slice(0, 2)
    .toUpperCase();
}

function postal(addr) {
  return String(addr?.postalCode || addr?.postal_code || addr?.zip || '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Map Canada Post USA service codes to Zonos service levels.
 * @param {string} cpServiceCode
 */
export function mapCanadaPostServiceToZonos(cpServiceCode) {
  const code = String(cpServiceCode || '').toUpperCase();
  return ZONOS_CP_SERVICE_LEVELS[code] || ZONOS_CANADA_POST_SERVICE_LEVEL;
}

function isGuaranteeFee(fee) {
  const type = String(fee?.type || '').toLowerCase();
  const desc = String(fee?.description || fee?.note || '').toLowerCase();
  if (GUARANTEE_FEE_TYPES.has(fee?.type) || type.includes('guarantee')) return true;
  if (desc.includes('landed cost guarantee') || desc.includes('zonos guarantee')) {
    return true;
  }
  return false;
}

/**
 * Manual-shipping Zonos GraphQL mutation (landed cost only — no order/label).
 */
export const ZONOS_LANDED_COST_MUTATION = `
mutation CalculateLandedCost(
  $parties: [PartyCreateWorkflowInput!]!
  $items: [ItemCreateWorkflowInput!]!
  $cartons: [CartonCreateWorkflowInput!]!
  $shipmentRating: ShipmentRatingCreateWorkflowInput!
  $landedCostConfig: LandedCostWorkFlowInput!
) {
  partyCreateWorkflow(input: $parties) {
    type
    id
  }
  itemCreateWorkflow(input: $items) {
    id
    amount
    sku
  }
  cartonsCreateWorkflow(input: $cartons) {
    id
  }
  shipmentRatingCreateWorkflow(input: $shipmentRating) {
    id
    amount
  }
  landedCostCalculateWorkflow(input: $landedCostConfig) {
    id
    duties {
      amount
      currency
      note
      formula
    }
    taxes {
      amount
      currency
      note
      formula
    }
    fees {
      amount
      currency
      note
      type
      description
      formula
    }
  }
}
`;

/**
 * @param {Record<string, unknown>} shipment
 * @param {{ shipping: number, currency?: string, serviceCode: string, serviceName?: string, zonosServiceLevelCode?: string }} shippingQuote
 */
export function buildZonosLandedCostVariables(shipment, shippingQuote) {
  if (!shipment?.from || !shipment?.to) {
    throw new Error('Zonos requires ship-from and ship-to addresses');
  }
  if (!Array.isArray(shipment.items) || shipment.items.length === 0) {
    throw new Error('Zonos requires at least one customs item');
  }
  if (!Number.isFinite(shippingQuote.shipping) || shippingQuote.shipping < 0) {
    throw new Error('Zonos requires a shipping amount');
  }

  const destCountry = country(shipment.to, 'US');
  const destPerson = splitName(shipment.to.name);
  const items = shipment.items.map((item, index) => {
    const amount = Number(item.value ?? item.customs_value);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`Zonos item ${index + 1} needs a customs value`);
    }
    const origin = country(
      { country: item.country_of_origin || item.originCountryCode },
      null,
    );
    if (!origin) {
      throw new Error(`Zonos item ${index + 1} needs country of origin`);
    }
    const sku = String(item.sku || item.productId || `item-${index + 1}`);
    /** @type {Record<string, unknown>} */
    const row = {
      amount,
      currencyCode: resolveDeclaredCurrency(item, shipment),
      quantity: Math.max(1, Number(item.quantity) || 1),
      countryOfOrigin: origin,
      sku,
      description: String(
        item.customs_description || item.description || item.title || sku,
      ).slice(0, 200),
    };
    const hs = String(item.hs_code || item.hsCode || '').replace(/\D/g, '');
    if (hs) row.hsCode = hs;
    if (needsAluminumSmeltCast(item, hs)) {
      row.productComposition = [aluminumSmeltCastComposition(item)];
    }
    return row;
  });

  const pkg = shipment.packages?.[0] || {};
  let weightLbs = null;
  if (pkg.weightLbs != null) weightLbs = Number(pkg.weightLbs);
  else if (pkg.weightOz != null) weightLbs = Number(pkg.weightOz) / 16;
  else if (pkg.weight != null && String(pkg.weight_unit || '').toLowerCase() === 'kg') {
    weightLbs = Number(pkg.weight) / 0.45359237;
  } else if (pkg.weight != null && String(pkg.weight_unit || '').toLowerCase() === 'lbs') {
    weightLbs = Number(pkg.weight);
  }
  const length = Number(pkg.lengthIn ?? pkg.length) || 10;
  const width = Number(pkg.widthIn ?? pkg.width) || 10;
  const height = Number(pkg.heightIn ?? pkg.height) || 4;
  if (!Number.isFinite(weightLbs) || weightLbs <= 0) {
    weightLbs = 1;
  }

  const displayName =
    shippingQuote.serviceName ||
    (shippingQuote.zonosServiceLevelCode
      ? String(shippingQuote.zonosServiceLevelCode)
      : `Canada Post ${shippingQuote.serviceCode}`);

  return {
    parties: [
      {
        type: 'ORIGIN',
        location: {
          line1: String(shipment.from.address1 || shipment.from.address_1 || ''),
          locality: String(shipment.from.city || ''),
          administrativeAreaCode: String(
            shipment.from.state || shipment.from.province || '',
          ).slice(0, 2),
          postalCode: postal(shipment.from),
          countryCode: country(shipment.from, 'CA'),
        },
      },
      {
        type: 'DESTINATION',
        location: {
          line1: String(shipment.to.address1 || shipment.to.address_1 || ''),
          locality: String(shipment.to.city || ''),
          administrativeAreaCode: String(shipment.to.state || '').slice(0, 2),
          postalCode: postal(shipment.to),
          countryCode: destCountry,
        },
        person: {
          firstName: destPerson.firstName,
          lastName: destPerson.lastName,
          email: String(shipment.to.email || 'rateshop@example.com'),
          phone: String(shipment.to.phone || '2125550100'),
        },
      },
    ],
    items,
    cartons: [
      {
        length,
        width,
        height,
        weight: weightLbs,
        weightUnit: 'POUND',
        dimensionalUnit: 'INCH',
      },
    ],
    shipmentRating: {
      amount: shippingQuote.shipping,
      // CP postage stays CAD (what Canada Post bills).
      currencyCode: String(shippingQuote.currency || 'CAD').toUpperCase(),
      serviceLevelCode:
        shippingQuote.zonosServiceLevelCode ||
        mapCanadaPostServiceToZonos(shippingQuote.serviceCode),
      displayName,
    },
    landedCostConfig: {
      calculationMethod: 'DDP',
      quoteType: 'CHECKOUT',
      endUse: 'NOT_FOR_RESALE',
      tariffRate: 'ZONOS_PREFERRED',
      // Render duties/fees in CAD so remittance compares to CP shipping + dashboard.
      currencyCode: 'CAD',
    },
  };
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((sum, row) => sum + (Number(row?.amount) || 0), 0);
}

function normalizeFeeRow(fee) {
  return {
    amount: Number(fee?.amount) || 0,
    currency: String(fee?.currency || fee?.currencyCode || 'CAD').toUpperCase(),
    type: fee?.type || null,
    description: fee?.description || null,
    formula: fee?.formula || null,
    note: fee?.note || null,
    isGuarantee: isGuaranteeFee(fee),
  };
}

/**
 * @param {unknown} data
 */
export function normalizeZonosLandedCost(data) {
  const list = data?.data?.landedCostCalculateWorkflow;
  const landed = Array.isArray(list) ? list[0] : list;
  if (!landed) {
    throw new Error('Zonos response missing landedCostCalculateWorkflow');
  }

  const duties = roundMoney(sumAmounts(landed.duties));
  const taxes = roundMoney(sumAmounts(landed.taxes));
  const feeItems = (landed.fees || []).map(normalizeFeeRow);
  const clearanceFeeItems = feeItems.filter((f) => !f.isGuarantee);
  const guaranteeFeeItems = feeItems.filter((f) => f.isGuarantee);
  const clearanceFees = roundMoney(sumAmounts(clearanceFeeItems));
  const guaranteeFee = roundMoney(sumAmounts(guaranteeFeeItems));
  const feesAll = roundMoney(sumAmounts(feeItems));
  // Rate-shop remittance excludes Zonos guarantee (matches dashboard remittance).
  const importCharges = roundMoney(duties + taxes + clearanceFees);
  const currencySample =
    landed.duties?.[0]?.currency ||
    landed.taxes?.[0]?.currency ||
    feeItems[0]?.currency ||
    'CAD';

  return {
    status: 'ok',
    currency: String(currencySample).toUpperCase(),
    duties,
    taxes,
    fees: clearanceFees,
    feesAll,
    clearanceFees,
    guaranteeFee,
    importCharges,
    dutyItems: landed.duties || [],
    taxItems: landed.taxes || [],
    feeItems,
    clearanceFeeItems,
    guaranteeFeeItems,
    landedCostId: landed.id || null,
  };
}

/**
 * Quote Zonos duties/taxes/fees for a known shipping amount.
 * Live shop uses Canada Post postal service levels. Caller may pass an override.
 * @param {Record<string, unknown>} shipment
 * @param {{ shipping: number, currency?: string, serviceCode: string, serviceName?: string, zonosServiceLevelCode?: string }} shippingQuote
 * @param {number} [timeoutMs]
 */
export async function quoteZonosLandedCost(
  shipment,
  shippingQuote,
  timeoutMs = ZONOS_QUOTE_TIMEOUT_MS,
) {
  try {
    assertZonosCredentials();
    const url = zonosGraphqlUrl();
    assertZonosQuoteOnlyUrl(url);
    const variables = buildZonosLandedCostVariables(shipment, shippingQuote);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        credentialToken: zonosApiKey(),
      },
      body: JSON.stringify({
        query: ZONOS_LANDED_COST_MUTATION,
        variables,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await response.text();
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`Zonos returned non-JSON (HTTP ${response.status})`);
    }

    if (!response.ok) {
      throw new Error(
        raw?.errors?.[0]?.message || `Zonos HTTP ${response.status}`,
      );
    }
    if (Array.isArray(raw?.errors) && raw.errors.length) {
      throw new Error(raw.errors.map((e) => e.message).filter(Boolean).join('; '));
    }

    return {
      ...normalizeZonosLandedCost(raw),
      request: variables,
      raw,
      error: null,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      currency: 'CAD',
      duties: null,
      taxes: null,
      fees: null,
      feesAll: null,
      clearanceFees: null,
      guaranteeFee: null,
      importCharges: null,
      error: error instanceof Error ? error.message : String(error),
      raw: null,
    };
  }
}
