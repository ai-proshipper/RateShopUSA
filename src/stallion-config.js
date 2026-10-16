/** Stallion v5 config for RateShop-USA — gated label create/void. */
import {
  assertStallionRateEnv,
  stallionBaseUrl,
  stallionToken,
} from './config.js';
import { isStallionScheduleWindow } from './stallion-schedule.js';

export { stallionBaseUrl, stallionToken } from './config.js';
export {
  isStallionScheduleWindow,
  ontarioHolidayMondays,
  stallionActiveYmd,
  torontoParts,
} from './stallion-schedule.js';

export const STALLION_PRODUCTION_HOST = 'ship.stallion.ca';
export const STALLION_SANDBOX_HOST = 'sandbox.stallion.ca';

const ALLOWED_HOSTS = new Set([STALLION_PRODUCTION_HOST, STALLION_SANDBOX_HOST]);

export const STALLION_LABEL_TIMEOUT_MS =
  Number(process.env.STALLION_LABEL_TIMEOUT_MS) || 30000;

/**
 * Optional last-mile allowlist. Empty = buy any trackable Stallion last-mile
 * (USPS, UPS, FedEx, OSM, …). Quotes stay unfiltered either way.
 */
export const STALLION_DEFAULT_LABEL_CARRIERS = [];

function envFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultValue;
  return String(raw).toLowerCase() === 'true';
}

function csvList(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Last-mile carriers allowed for label purchase (case-insensitive).
 * Empty list = unrestricted. Optional env: STALLION_LABEL_CARRIERS=USPS,UPS
 */
export function stallionLabelCarriers() {
  const listed = csvList('STALLION_LABEL_CARRIERS').map((s) => s.toUpperCase());
  return listed.length ? listed : [...STALLION_DEFAULT_LABEL_CARRIERS];
}

/**
 * Optional service-code allowlist (carrier.service_code).
 * Empty means any trackable service of an allowed carrier.
 * Env: STALLION_LABEL_SERVICES=usps.ground_advantage,usps.1
 */
export function stallionLabelServices() {
  return csvList('STALLION_LABEL_SERVICES').map((s) => s.toLowerCase());
}

/**
 * ShipHero shop_name contains "shopify" (any case) → Shopify store.
 * @param {unknown} shopName
 */
export function isShopifyShopName(shopName) {
  return String(shopName || '').toLowerCase().includes('shopify');
}

/**
 * Stallion "US Regional" (service name, last-mile, or code like stallion.regional).
 * @param {unknown} carrierOrService
 */
export function isStallionUsRegionalLabel(carrierOrService) {
  const name = String(carrierOrService || '').trim().toUpperCase();
  if (!name) return false;
  const words = name.split(/[^A-Z0-9]+/).filter(Boolean);
  return words.includes('REGIONAL');
}

/**
 * Last-mile / service name allowed for Stallion label purchase.
 * @param {unknown} carrier
 * @param {{ shopName?: unknown }} [opts] Shopify shops may also buy US Regional.
 */
export function isStallionLabelCarrierAllowed(carrier, opts = {}) {
  const name = String(carrier || '').trim().toUpperCase();
  if (!name) return false;
  const listed = stallionLabelCarriers();
  if (!listed.length) return true;
  const words = name.split(/[^A-Z0-9]+/).filter(Boolean);
  const onList = listed.some((allowed) => {
    if (!allowed) return false;
    if (name === allowed) return true;
    // "FedEx Ground", "UPS SurePost" — do not substring-match (UPS must not match USPS).
    if (name.startsWith(`${allowed} `)) return true;
    // "US Regional" matches allowlist token REGIONAL.
    return words.includes(allowed);
  });
  if (onList) return true;
  // Shopify-only exception: Stallion US Regional (not on STALLION_LABEL_CARRIERS).
  return isShopifyShopName(opts.shopName) && isStallionUsRegionalLabel(name);
}

export function isStallionLabelServiceAllowed(service) {
  const code = String(service || '').trim().toLowerCase();
  if (!code) return false;
  const services = stallionLabelServices();
  if (!services.length) return true;
  return services.includes(code);
}

function stallionHost() {
  try {
    return new URL(stallionBaseUrl()).hostname;
  } catch {
    return '';
  }
}

export function stallionIsProduction() {
  return stallionHost() === STALLION_PRODUCTION_HOST;
}

export function stallionIsSandbox() {
  return stallionHost() === STALLION_SANDBOX_HOST;
}

export function stallionAllowProdCreateVoid() {
  return envFlag('STALLION_ALLOW_PROD_CREATE_VOID', false);
}

/**
 * US rate shop quote + compare + buy.
 *
 * - STALLION_ENABLED=false always wins (kill switch).
 * - STALLION_SCHEDULE=true → on only Mon 05:00–11:30 America/Toronto
 *   (Tue if that Monday is an Ontario long-weekend holiday). Needs ENABLED=true.
 * - STALLION_SCHEDULE=false (default) → ENABLED alone, legacy always-on/off.
 *
 * Standalone probe scripts that call quoteStallion() directly are not gated here.
 */
export function stallionEnabled(now = new Date()) {
  if (!envFlag('STALLION_ENABLED', false)) return false;
  if (envFlag('STALLION_SCHEDULE', false)) {
    return isStallionScheduleWindow(now);
  }
  return true;
}

/** True when weekly schedule mode is on (independent of current window). */
export function stallionScheduleEnabled() {
  return envFlag('STALLION_SCHEDULE', false);
}

/**
 * Create/void gate. Production needs ALLOW_CREATE or the probe pair
 * (PROD_CREATE_VOID + TEST_CREATE). Sandbox needs TEST_CREATE. Default off.
 */
export function stallionAllowCreate() {
  if (!stallionEnabled()) return false;
  if (envFlag('STALLION_ALLOW_CREATE', false)) return true;
  if (stallionIsSandbox()) {
    return envFlag('STALLION_ALLOW_TEST_CREATE', false);
  }
  return stallionAllowProdCreateVoid() && envFlag('STALLION_ALLOW_TEST_CREATE', false);
}

export function assertStallionAllowedHost() {
  const base = stallionBaseUrl();
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(`Stallion refused: invalid STALLION_BASE_URL "${base}"`);
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`Stallion refused: unexpected host ${parsed.hostname}`);
  }
}

export function assertStallionShipmentEnv() {
  assertStallionRateEnv();
  assertStallionAllowedHost();
  if (!stallionAllowCreate()) {
    throw new Error(
      !stallionEnabled()
        ? stallionScheduleEnabled()
          ? 'Stallion is outside the weekly window (Mon/Tue 05:00–11:30 America/Toronto), or STALLION_ENABLED=false.'
          : 'Stallion label create is disabled. Set STALLION_ENABLED=true to restore US Stallion shopping.'
        : stallionIsSandbox()
          ? 'Stallion label create is disabled. Set STALLION_ALLOW_TEST_CREATE=true for this sandbox probe.'
          : 'Stallion label create is disabled. Set STALLION_ALLOW_TEST_CREATE=true ' +
            'and STALLION_ALLOW_PROD_CREATE_VOID=true for this probe.',
    );
  }
}

export function stallionLabelsUrl() {
  return `${stallionBaseUrl()}/labels`;
}

export function stallionVoidUrl(shipmentId) {
  const id = encodeURIComponent(String(shipmentId || '').trim());
  return `${stallionBaseUrl()}/shipments/${id}/void`;
}

/**
 * Permit only gated label purchase + void. Quote modules must not use this.
 * @param {string} url
 * @param {'labels' | 'void'} operation
 */
export function assertStallionShippingUrl(url, operation) {
  const parsed = new URL(url);
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`Stallion ${operation} refused: unexpected host`);
  }
  const allowed = {
    labels: /^\/api\/v5\/labels$/,
    void: /^\/api\/v5\/shipments\/[^/]+\/void$/,
  };
  const rule = allowed[operation];
  if (!rule || !rule.test(parsed.pathname)) {
    throw new Error(`Stallion ${operation} refused: endpoint is not a gated shipping path`);
  }
}
