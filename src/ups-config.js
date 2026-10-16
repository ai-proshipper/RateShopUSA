const UPS_PRODUCTION_ORIGIN = 'https://onlinetools.ups.com';

export const UPS_QUOTE_TIMEOUT_MS =
  Number(process.env.UPS_QUOTE_TIMEOUT_MS) || 20000;

export const UPS_LABEL_TIMEOUT_MS =
  Number(process.env.UPS_LABEL_TIMEOUT_MS) || 30000;

export const UPS_SERVICE_NAMES = {
  '01': 'UPS Next Day Air',
  '02': 'UPS 2nd Day Air',
  '03': 'UPS Ground',
  '07': 'UPS Worldwide Express',
  '08': 'UPS Worldwide Expedited',
  '11': 'UPS Standard',
  '12': 'UPS 3 Day Select',
  '13': 'UPS Next Day Air Saver',
  '14': 'UPS Next Day Air Early',
  '54': 'UPS Worldwide Express Plus',
  '59': 'UPS 2nd Day Air A.M.',
  '65': 'UPS Worldwide Saver',
};

/** Only services used for US rate shopping. Entry Prep does not apply. */
export const UPS_QUOTE_SERVICE_CODES = ['08', '12'];

/** UPS Standard (CA→US ground). UPS does not offer Ground (03) cross-border. */
export const UPS_STANDARD_SERVICE_CODE = '11';

/** Extra CAD added to UPS Standard for ranking only (print cost stays the Rating postage). */
export const UPS_STANDARD_POSTAGE_PAD_CAD = 10;

/** Contract disbursement fee (CAD). Landed Cost brokerage is list, not used. */
export const UPS_DISBURSEMENT_FEE_CAD = 4.8;

function env(name) {
  return String(process.env[name] || '').trim();
}

function envFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultValue;
  return String(raw).toLowerCase() === 'true';
}

export function upsClientId() {
  return env('UPS_CLIENT_ID');
}

export function upsClientSecret() {
  return env('UPS_CLIENT_SECRET');
}

export function upsAccountNumber() {
  return env('UPS_ACCOUNT_NUMBER');
}

export function upsTransactionSrc() {
  return env('UPS_TRANSACTION_SRC') || 'rateshop-usa';
}

export function assertUpsQuoteCredentials() {
  if ((env('UPS_ENV') || 'production').toLowerCase() !== 'production') {
    throw new Error('UPS quote integration is locked to UPS_ENV=production');
  }
  if (!upsClientId() || !upsClientSecret()) {
    throw new Error('UPS_CLIENT_ID and UPS_CLIENT_SECRET are required');
  }
  if (!upsAccountNumber()) {
    throw new Error('UPS_ACCOUNT_NUMBER is required');
  }
}

function version(name, fallback) {
  const raw = (env(name) || fallback).replace(/^\/+/, '');
  return raw.startsWith('v') ? raw : `v${raw}`;
}

export function upsTokenUrl() {
  return `${UPS_PRODUCTION_ORIGIN}/security/v1/oauth/token`;
}

export function upsRatingUrl() {
  // Plain Shop + DeliveryTimeInformation.Pickup returns transit for CA domestic.
  // Shoptimeintransit rejects some weights with "Invalid Weight".
  return `${UPS_PRODUCTION_ORIGIN}/api/rating/${version('UPS_RATING_VERSION', 'v2403')}/Shop`;
}

export function upsLandedCostUrl() {
  return `${UPS_PRODUCTION_ORIGIN}/api/landedcost/${version('UPS_LANDED_COST_VERSION', 'v1')}/quotes`;
}

export function upsShippingUrl() {
  return `${UPS_PRODUCTION_ORIGIN}/api/shipments/${version('UPS_SHIPPING_VERSION', 'v2409')}/ship`;
}

export function upsVoidUrl(shipmentIdentificationNumber) {
  const id = encodeURIComponent(String(shipmentIdentificationNumber || '').trim());
  return `${UPS_PRODUCTION_ORIGIN}/api/shipments/${version('UPS_SHIPPING_VERSION', 'v2409')}/void/cancel/${id}`;
}

export function upsTrackingUrl(trackingNumber) {
  const id = String(trackingNumber || '').trim();
  if (!id) return '';
  const template =
    env('UPS_TRACKING_URL') || 'https://www.ups.com/track?tracknum={tracking_id}';
  return template.includes('{tracking_id}')
    ? template.replace('{tracking_id}', encodeURIComponent(id))
    : `${template}${encodeURIComponent(id)}`;
}

export function upsAllowProdCreateVoid() {
  return envFlag('UPS_ALLOW_PROD_CREATE_VOID', false);
}

/**
 * Create/void gate. Production needs ALLOW_CREATE or the probe pair
 * (PROD_CREATE_VOID + TEST_CREATE). Default off.
 */
export function upsAllowCreate() {
  if (envFlag('UPS_ALLOW_CREATE', false)) return true;
  return upsAllowProdCreateVoid() && envFlag('UPS_ALLOW_TEST_CREATE', false);
}

export function assertUpsShipmentEnv() {
  assertUpsQuoteCredentials();
  if (!upsAllowCreate()) {
    throw new Error(
      'UPS label create is disabled. Set UPS_ALLOW_TEST_CREATE=true ' +
        'and UPS_ALLOW_PROD_CREATE_VOID=true for this probe.',
    );
  }
}

/**
 * Permit only the three read/quote operations used by this project.
 * No shipment, purchase, label, or void URL can pass this guard.
 */
export function assertUpsQuoteOnlyUrl(url, operation) {
  const parsed = new URL(url);
  if (parsed.origin !== UPS_PRODUCTION_ORIGIN) {
    throw new Error(`UPS ${operation} refused: unexpected host`);
  }

  const allowed = {
    oauth: /^\/security\/v1\/oauth\/token$/,
    rating: /^\/api\/rating\/v[^/]+\/Shop$/i,
    landedCost: /^\/api\/landedcost\/v[^/]+\/quotes$/,
  };
  const rule = allowed[operation];
  if (!rule || !rule.test(parsed.pathname)) {
    throw new Error(`UPS ${operation} refused: endpoint is not quote-only`);
  }
}

/**
 * Permit only Shipping ship + void. Quote modules must not use this.
 * @param {string} url
 * @param {'ship' | 'void'} operation
 */
export function assertUpsShippingUrl(url, operation) {
  const parsed = new URL(url);
  if (parsed.origin !== UPS_PRODUCTION_ORIGIN) {
    throw new Error(`UPS ${operation} refused: unexpected host`);
  }
  const allowed = {
    ship: /^\/api\/shipments\/v[^/]+\/ship$/,
    void: /^\/api\/shipments\/v[^/]+\/void\/cancel\/[^/]+$/,
  };
  const rule = allowed[operation];
  if (!rule || !rule.test(parsed.pathname)) {
    throw new Error(`UPS ${operation} refused: endpoint is not a gated shipping path`);
  }
}

/** US + territories: UPS SoldTo PostalCode is 0–9 alphanumeric (no hyphen). */
const US_POSTAL_COUNTRIES = new Set(['US', 'PR', 'VI', 'GU', 'AS', 'MP']);

/**
 * Normalize a postal code for UPS Rating / Shipping.
 * ZIP+4 like 30361-3503 is valid USPS, but UPS error 128101 rejects the hyphen.
 * @param {unknown} value
 * @param {unknown} [country]
 */
export function upsPostalCode(value, country) {
  const countryCode = String(country || '').slice(0, 2).toUpperCase();
  const raw = String(value || '').toUpperCase();
  if (US_POSTAL_COUNTRIES.has(countryCode)) {
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 9) return digits.slice(0, 9);
    return digits.slice(0, 5);
  }
  return raw.replace(/[^A-Z0-9]/g, '').slice(0, 9);
}

export function upsServiceName(code) {
  const normalized = String(code || '').padStart(2, '0');
  return UPS_SERVICE_NAMES[normalized] || `UPS ${normalized}`;
}

/** Dimensional divisor (inches → lbs) for billable-weight helpers. */
export const UPS_DIM_DIVISOR_IN = 225;

function packageWeightLbs(pkg) {
  if (pkg?.weightLbs != null) return Number(pkg.weightLbs);
  if (pkg?.weightOz != null) return Number(pkg.weightOz) / 16;
  if (pkg?.weight_in_oz != null) return Number(pkg.weight_in_oz) / 16;
  if (pkg?.weight != null && String(pkg.weight_unit || '').toLowerCase() === 'lbs') {
    return Number(pkg.weight);
  }
  return NaN;
}

function packageDimInches(pkg) {
  const length = Number(pkg?.lengthIn ?? pkg?.length);
  const width = Number(pkg?.widthIn ?? pkg?.width);
  const height = Number(pkg?.heightIn ?? pkg?.height);
  if (![length, width, height].every((value) => Number.isFinite(value) && value > 0)) {
    return null;
  }
  // Match UPS Rating package dims (ceil to whole inches).
  return {
    length: Math.max(1, Math.ceil(length)),
    width: Math.max(1, Math.ceil(width)),
    height: Math.max(1, Math.ceil(height)),
  };
}

/**
 * Dimensional weight in lbs: L×W×H / 225. Null when dims are missing.
 * @param {Record<string, unknown> | null | undefined} pkg
 */
export function packageDimensionalWeightLbs(pkg) {
  const dims = packageDimInches(pkg);
  if (!dims) return null;
  return (dims.length * dims.width * dims.height) / UPS_DIM_DIVISOR_IN;
}

/**
 * Billable weight for one package: max(actual, dimensional). Falls back to actual
 * when dims are missing.
 * @param {Record<string, unknown> | null | undefined} pkg
 */
export function packageBillableWeightLbs(pkg) {
  const actual = packageWeightLbs(pkg);
  if (!Number.isFinite(actual)) return NaN;
  const dimensional = packageDimensionalWeightLbs(pkg);
  if (dimensional == null || !Number.isFinite(dimensional)) return actual;
  return Math.max(actual, dimensional);
}

/**
 * Total billable weight of all packages in pounds; NaN if any package weight is unknown.
 * @param {Record<string, unknown> | null | undefined} shipment
 */
export function shipmentBillableWeightLbs(shipment) {
  const packages = Array.isArray(shipment?.packages) ? shipment.packages : [];
  if (!packages.length) return NaN;
  return packages.reduce((sum, pkg) => sum + packageBillableWeightLbs(pkg), 0);
}

/**
 * UPS services shopped for this shipment: Worldwide Expedited (08),
 * 3 Day Select (12), and Standard (11). Standard is always included.
 * @param {Record<string, unknown> | null | undefined} [_shipment]
 */
export function upsQuoteServiceCodes(_shipment) {
  return [...UPS_QUOTE_SERVICE_CODES, UPS_STANDARD_SERVICE_CODE];
}

/**
 * Ranking pad for UPS Standard. 08 / 12 are unpadded. Print cost is not padded.
 * @param {unknown} serviceCode
 */
export function upsStandardComparePad(serviceCode) {
  const normalized = String(serviceCode || '').padStart(2, '0');
  return normalized === UPS_STANDARD_SERVICE_CODE
    ? UPS_STANDARD_POSTAGE_PAD_CAD
    : 0;
}

/**
 * Without a shipment, any service we may ever shop (including UPS Standard).
 * With a shipment, uses the same always-on shopped-service list.
 * @param {unknown} code
 * @param {Record<string, unknown>} [shipment]
 */
export function isUpsQuoteService(code, shipment) {
  const normalized = String(code || '').padStart(2, '0');
  if (shipment) return upsQuoteServiceCodes(shipment).includes(normalized);
  return (
    UPS_QUOTE_SERVICE_CODES.includes(normalized) ||
    normalized === UPS_STANDARD_SERVICE_CODE
  );
}
