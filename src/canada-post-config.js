/** Canada Post config for RateShop-USA — US rates + gated label create/void. */

export const CANADA_POST_QUOTE_TIMEOUT_MS =
  Number(process.env.CANADA_POST_QUOTE_TIMEOUT_MS) || 20000;

function envPositiveMs(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * US /prices is slower than CAD DOM. Short rounds abort live USA quotes.
 * Dual-race + IPv4 still kills hung CloudFront sockets; each round just waits longer.
 */
export const CANADA_POST_PRICES_ROUND_MS = Math.max(
  800,
  envPositiveMs('CANADA_POST_PRICES_ROUND_MS', 6000),
);
export const CANADA_POST_OAUTH_ROUND_MS = Math.max(
  800,
  envPositiveMs('CANADA_POST_OAUTH_ROUND_MS', 4000),
);
export const CANADA_POST_CONNECT_TIMEOUT_MS = Math.max(
  500,
  envPositiveMs('CANADA_POST_CONNECT_TIMEOUT_MS', 3000),
);
export const CANADA_POST_PRICES_MAX_ROUNDS = Math.min(
  5,
  Math.max(1, Math.floor(envPositiveMs('CANADA_POST_PRICES_MAX_ROUNDS', 3))),
);
export const CANADA_POST_OAUTH_MAX_ROUNDS = Math.min(
  5,
  Math.max(1, Math.floor(envPositiveMs('CANADA_POST_OAUTH_MAX_ROUNDS', 2))),
);

export const CANADA_POST_ALLOWED_TOKEN_URL =
  'https://api.canadapost-postescanada.ca/prod/devportal-portaildesdeveloppeurs/cpc-api-native-oauth-provider/oauth2/token';

export const CANADA_POST_ALLOWED_RATING_BASE =
  'https://api.canadapost-postescanada.ca/prod/devportal-portaildesdeveloppeurs/rating/v1';

export const CANADA_POST_ALLOWED_SHIPPING_BASE =
  'https://api.canadapost-postescanada.ca/prod/devportal-portaildesdeveloppeurs/shipping/v1';

/** US-bound services for RateShop-USA (excludes Small Packet USA Air). */
export const CANADA_POST_US_SERVICE_CODES = [
  'USA.EP',
  'USA.XP',
  'USA.TP',
];

const SERVICE_NAMES = {
  'USA.EP': 'Canada Post Expedited Parcel USA',
  'USA.XP': 'Canada Post Xpresspost USA',
  'USA.TP': 'Canada Post Tracked Packet USA',
};

const ALLOWED_RATING_ENVS = new Set([
  'test',
  'sandbox',
  'development',
  'dev',
  'production',
  'prod',
]);
const ALLOWED_SHIPMENT_ENVS = new Set(['test', 'sandbox', 'development', 'dev']);

function env(name) {
  return String(process.env[name] || '').trim();
}

function envFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultValue;
  return String(raw).toLowerCase() === 'true';
}

function canadaPostEnv() {
  return (env('CANADA_POST_ENV') || 'production').toLowerCase();
}

export function canadaPostIsProduction() {
  const mode = canadaPostEnv();
  return mode === 'production' || mode === 'prod';
}

export function canadaPostClientId() {
  return env('CANADA_POST_CLIENT_ID');
}

export function canadaPostClientSecret() {
  return env('CANADA_POST_CLIENT_SECRET');
}

export function canadaPostCustomerNumber() {
  return env('CANADA_POST_CUSTOMER_NUMBER');
}

export function canadaPostContractId() {
  return env('CANADA_POST_CONTRACT_ID');
}

export function zonosAccountKey() {
  return env('ZONOS_ACCOUNT_KEY');
}

export function normalizePostal(value) {
  return String(value || '').replace(/\s+/g, '').toUpperCase();
}

export function usZip(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length >= 9) return `${digits.slice(0, 5)}-${digits.slice(5, 9)}`;
  return digits.slice(0, 5);
}

/**
 * Format HS for Canada Post customs: 9999.99.99.99 pattern.
 * @param {unknown} raw
 */
export function formatHsTariffCode(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 4) return '';
  const parts = [digits.slice(0, 4)];
  if (digits.length >= 6) parts.push(digits.slice(4, 6));
  if (digits.length >= 8) parts.push(digits.slice(6, 8));
  if (digits.length >= 10) parts.push(digits.slice(8, 10));
  return parts.join('.');
}

export function canadaPostPickupPostal() {
  return normalizePostal(env('CANADA_POST_PICKUP_POSTAL') || 'L1S2E3');
}

export function canadaPostPaymentMethod() {
  return env('CANADA_POST_PAYMENT_METHOD') || 'CreditCard';
}

/**
 * US-bound CP services only. When embedded with CAD RateShopping, CAD keeps
 * CANADA_POST_SERVICE_CODES=DOM.* — use CANADA_POST_USA_SERVICE_CODES or fall
 * back to the USA allowlist (DOM codes are filtered out).
 */
export function canadaPostServiceCodes() {
  const preferred =
    env('CANADA_POST_USA_SERVICE_CODES') || env('CANADA_POST_SERVICE_CODES') || '';
  const raw = (preferred || CANADA_POST_US_SERVICE_CODES.join(','))
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const allowed = raw.filter((c) => CANADA_POST_US_SERVICE_CODES.includes(c));
  return allowed.length ? [...new Set(allowed)] : [...CANADA_POST_US_SERVICE_CODES];
}

export function canadaPostServiceDisplayName(serviceCode) {
  const code = String(serviceCode || '').toUpperCase();
  return SERVICE_NAMES[code] || `Canada Post ${code}`;
}

export function canadaPostTrackingUrl(pin) {
  const id = String(pin || '').trim();
  if (!id) return '';
  const template =
    env('CANADA_POST_TRACKING_URL') ||
    'https://www.canadapost-postescanada.ca/track-reperage/en#/details/{tracking_id}';
  return template.includes('{tracking_id}')
    ? template.replace('{tracking_id}', encodeURIComponent(id))
    : `${template}${encodeURIComponent(id)}`;
}

/**
 * Same daily group as CAD RateShopping EOD (`RS-YYYYMMDD`, max 12).
 * US and domestic CP labels share this group so one Transmit covers both.
 */
export function canadaPostDailyGroupId(date = new Date()) {
  const prefix = (env('CANADA_POST_GROUP_PREFIX') || 'RS').trim() || 'RS';
  const tz = env('CANADA_POST_GROUP_TZ') || 'America/Toronto';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(date)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
  return `${prefix}-${parts.year}${parts.month}${parts.day}`.slice(0, 12);
}

export function canadaPostAllowProdCreateVoid() {
  return envFlag('CANADA_POST_ALLOW_PROD_CREATE_VOID', false);
}

export function canadaPostTransmitEnabled() {
  return envFlag('CANADA_POST_TRANSMIT_ENABLED', false);
}

/**
 * Create/void gate. Production needs ALLOW_CREATE or probe pair
 * (PROD_CREATE_VOID + TEST_CREATE). Transmit stays separate.
 */
export function canadaPostAllowCreate() {
  if (canadaPostIsProduction()) {
    if (envFlag('CANADA_POST_ALLOW_CREATE', false)) return true;
    return (
      canadaPostAllowProdCreateVoid() && envFlag('CANADA_POST_ALLOW_TEST_CREATE', false)
    );
  }
  return (
    envFlag('CANADA_POST_ALLOW_CREATE', false) ||
    envFlag('CANADA_POST_ALLOW_TEST_CREATE', false)
  );
}

export function assertCanadaPostQuoteCredentials() {
  const mode = canadaPostEnv();
  if (!ALLOWED_RATING_ENVS.has(mode)) {
    throw new Error(
      `Canada Post refused: CANADA_POST_ENV must be test/sandbox/production (got "${mode}")`,
    );
  }
  if (!canadaPostClientId() || !canadaPostClientSecret()) {
    throw new Error('CANADA_POST_CLIENT_ID and CANADA_POST_CLIENT_SECRET are required');
  }
  if (!canadaPostCustomerNumber()) {
    throw new Error('CANADA_POST_CUSTOMER_NUMBER is required');
  }
}

/**
 * Guard for Create / Get Artifact / Void.
 * Transmit is gated separately and must stay off for print-and-cancel probes.
 */
export function assertCanadaPostShipmentEnv() {
  assertCanadaPostQuoteCredentials();
  const mode = canadaPostEnv();
  if (ALLOWED_SHIPMENT_ENVS.has(mode)) return;
  if (
    canadaPostIsProduction() &&
    (envFlag('CANADA_POST_ALLOW_CREATE', false) ||
      canadaPostAllowProdCreateVoid() ||
      envFlag('CANADA_POST_TRANSMIT_ENABLED', false))
  ) {
    return;
  }
  throw new Error(
    `Canada Post label operations are disabled (CANADA_POST_ENV="${mode}"). ` +
      'Production requires CANADA_POST_ALLOW_CREATE=true or CANADA_POST_ALLOW_PROD_CREATE_VOID=true.',
  );
}

export function canadaPostTokenUrl() {
  const url = (env('CANADA_POST_TOKEN_URL') || CANADA_POST_ALLOWED_TOKEN_URL).replace(/\/$/, '');
  if (url !== CANADA_POST_ALLOWED_TOKEN_URL) {
    throw new Error('Canada Post refused: unexpected token URL');
  }
  return url;
}

export function canadaPostRatingBaseUrl() {
  const url = (env('CANADA_POST_API_BASE_URL') || CANADA_POST_ALLOWED_RATING_BASE).replace(
    /\/$/,
    '',
  );
  if (url !== CANADA_POST_ALLOWED_RATING_BASE) {
    throw new Error('Canada Post refused: unexpected rating base URL');
  }
  return url;
}

export function canadaPostShippingBaseUrl() {
  const url = (
    env('CANADA_POST_SHIPPING_API_BASE_URL') || CANADA_POST_ALLOWED_SHIPPING_BASE
  ).replace(/\/$/, '');
  if (url !== CANADA_POST_ALLOWED_SHIPPING_BASE) {
    throw new Error('Canada Post refused: unexpected shipping base URL');
  }
  return url;
}

export function canadaPostPricesUrl() {
  return `${canadaPostRatingBaseUrl()}/prices`;
}

/**
 * Permit only OAuth + Rating /prices. Refuse shipping/label/void/transmit.
 * @param {string} url
 * @param {'oauth' | 'rating'} operation
 */
export function assertCanadaPostQuoteOnlyUrl(url, operation) {
  const parsed = new URL(url);
  if (parsed.hostname !== 'api.canadapost-postescanada.ca') {
    throw new Error(`Canada Post ${operation} refused: unexpected host`);
  }
  if (/\/shipping\//i.test(parsed.pathname)) {
    throw new Error(`Canada Post ${operation} refused: shipping endpoints are blocked`);
  }
  if (operation === 'oauth') {
    if (!parsed.pathname.includes('/oauth2/token')) {
      throw new Error(`Canada Post oauth refused: endpoint is not quote-only`);
    }
    return;
  }
  if (operation === 'rating') {
    if (!/\/rating\/v\d+\/prices$/i.test(parsed.pathname)) {
      throw new Error(`Canada Post rating refused: endpoint is not /prices`);
    }
    return;
  }
  throw new Error(`Canada Post refused unknown operation: ${operation}`);
}

/**
 * Allow only Developer Portal shipping/v1 shipment paths (create/void/artifact host).
 * @param {string} url
 */
export function assertCanadaPostShippingUrl(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== 'api.canadapost-postescanada.ca') {
    throw new Error('Canada Post shipping refused: unexpected host');
  }
  if (!/\/shipping\/v\d+\//i.test(parsed.pathname)) {
    throw new Error('Canada Post shipping refused: endpoint is not shipping/v1');
  }
  if (/transmit/i.test(parsed.pathname)) {
    throw new Error('Canada Post shipping refused: transmit is blocked on this path');
  }
}
