/** Shared env helpers for RateShop-USA. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const QUOTE_TIMEOUT_MS = Number(process.env.QUOTE_TIMEOUT_MS) || 15000;

/** ShipHero Generate Label is ~20s; never spend more than 18s on the US path. */
export const USA_MAX_DEADLINE_MS = 18000;

function envPositiveMs(name) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const requestedDeadline =
  envPositiveMs('USA_WEBHOOK_DEADLINE_MS') ||
  envPositiveMs('WEBHOOK_DEADLINE_MS') ||
  USA_MAX_DEADLINE_MS;

/** Internal cap before label purchase. Never above 18s. */
export const WEBHOOK_DEADLINE_MS = Math.min(requestedDeadline, USA_MAX_DEADLINE_MS);
/** Time reserved for the winning carrier's label step. */
export const LABEL_RESERVE_MS = Number(process.env.LABEL_RESERVE_MS) || 5500;
export const LABEL_TIMEOUT_MS = Number(process.env.LABEL_TIMEOUT_MS) || 15000;
/** Overlapping Generate Label retries only. 0 = do not replay a finished print after ShipHero void. */
export const WEBHOOK_DEDUP_TTL_MS = Number(process.env.WEBHOOK_DEDUP_TTL_MS) || 0;
export const AUTO_SELECT_WINNER =
  (process.env.AUTO_SELECT_WINNER ?? 'true').toLowerCase() === 'true';
/** Default true until the webhook path is proven. */
export const QUOTE_ONLY = (process.env.QUOTE_ONLY ?? 'true').toLowerCase() === 'true';
/**
 * Cap on ShipHero `cost` (amount charged at print).
 * Prefer USA_MAX_LABEL_COST so CAD's lower MAX_LABEL_COST (often 100) is not inherited when embedded.
 */
export const MAX_LABEL_COST =
  Number(process.env.USA_MAX_LABEL_COST || process.env.MAX_LABEL_COST) || 150;
/** Freak Athlete may print up to this amount before the management block. */
export const FREAK_ATHLETE_MAX_LABEL_COST =
  Number(process.env.FREAK_ATHLETE_MAX_LABEL_COST) || 200;
/** ShipHero customer account id for Freak Athlete (numeric legacy id). */
export const FREAK_ATHLETE_ACCOUNT_ID = String(
  process.env.FREAK_ATHLETE_ACCOUNT_ID || '100970',
).trim();
/**
 * Cap on ranked CAD landed total (shipping + duties/fees).
 * Prefer USA_MAX_LANDED_COST when sharing env with CAD RateShopping.
 */
export const MAX_LANDED_COST =
  Number(process.env.USA_MAX_LANDED_COST || process.env.MAX_LANDED_COST) || 500;
export const LABEL_COST_TOO_HIGH_MSG = 'Label cost too high. PLEASE CALL MANAGEMENT.';
export const LANDED_COST_TOO_HIGH_MSG = 'Landed cost too high. PLEASE CALL MANAGEMENT.';

/**
 * Normalize ShipHero account_id (numeric or GraphQL "Account:123" / base64).
 * @param {unknown} accountId
 * @returns {string}
 */
export function shipHeroAccountId(accountId) {
  if (accountId == null || accountId === '') return '';
  const s = String(accountId).trim();
  if (/^\d+$/.test(s)) return s;
  const plain = s.match(/^Account:(\d+)$/i);
  if (plain) return plain[1];
  try {
    const decoded = Buffer.from(s, 'base64').toString('utf8');
    const m = decoded.match(/^Account:(\d+)$/i);
    if (m) return m[1];
  } catch {
    // ignore
  }
  return s;
}

/**
 * True when the ShipHero order belongs to Freak Athlete (account_id).
 * @param {Record<string, unknown>|null|undefined} rawPayload
 */
export function isFreakAthleteClient(rawPayload) {
  const body = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
  return shipHeroAccountId(body.account_id) === FREAK_ATHLETE_ACCOUNT_ID;
}

/**
 * Per-request label print cap. Freak Athlete stops at $200; everyone else at MAX_LABEL_COST.
 * @param {Record<string, unknown>|null|undefined} rawPayload
 */
export function maxLabelCostForRequest(rawPayload) {
  return isFreakAthleteClient(rawPayload) ? FREAK_ATHLETE_MAX_LABEL_COST : MAX_LABEL_COST;
}

/**
 * After a US print, attach the carrier customs PDF to the ShipHero order.
 * Default on. Does not put the URL in webhook customs_info (avoids thermal print).
 * CAD Rate Shop never reads this.
 */
export function usaAttachCustomsToOrder() {
  const raw = (process.env.USA_ATTACH_CUSTOMS_TO_ORDER ?? 'true').trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

export {
  getShipHeroAccessToken,
  shipHeroAuthConfigured,
  shipHeroApiTokenSync as shipHeroApiToken,
  shipHeroRefreshToken,
  startShipHeroTokenRefresh,
} from './shiphero-auth.js';

const SAFETY_BUFFER_MS = 500;

/** Max ms for the parallel quote phase given time already spent. */
export function quotePhaseBudgetMs(elapsedMs = 0) {
  const remaining = WEBHOOK_DEADLINE_MS - LABEL_RESERVE_MS - elapsedMs - SAFETY_BUFFER_MS;
  return Math.max(1500, Math.min(QUOTE_TIMEOUT_MS, remaining, USA_MAX_DEADLINE_MS));
}

/** Max ms left for label purchase given time already spent. Never exceeds the 18s cap. */
export function labelPhaseBudgetMs(elapsedMs) {
  const remaining = WEBHOOK_DEADLINE_MS - elapsedMs - SAFETY_BUFFER_MS;
  return Math.max(0, Math.min(remaining, USA_MAX_DEADLINE_MS));
}

export function publicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3457}`).replace(
    /\/$/,
    '',
  );
}

/**
 * Prefer PUBLIC_BASE_URL; else build from webhook forward headers (ShipHero must fetch label PDF).
 * @param {Record<string, string|undefined>} [forwardHeaders]
 */
export function resolvePublicBaseUrl(forwardHeaders = {}) {
  const explicit = process.env.PUBLIC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const host = forwardHeaders['x-forwarded-host'] || forwardHeaders.host;
  const proto = (forwardHeaders['x-forwarded-proto'] || 'https').split(',')[0].trim();
  if (host) return `${proto}://${host}`.replace(/\/$/, '');
  return publicBaseUrl();
}

/**
 * Label PDF directory. When embedded in CAD RateShopping, set LABELS_PUBLIC_DIR
 * to RateShopping's public/labels so ShipHero can fetch via the shared PUBLIC_BASE_URL.
 */
export function labelsPublicDir() {
  const override = process.env.LABELS_PUBLIC_DIR?.trim();
  if (override) return path.resolve(override);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'labels');
}

export const STALLION_PRODUCTION_BASE_URL = 'https://ship.stallion.ca/api/v5';

/**
 * Stallion API bearer token.
 * Prefers STALLION_TOKEN; falls back to StallionAPI for existing .env.
 */
export function stallionToken() {
  const raw =
    process.env.STALLION_TOKEN?.trim() ||
    process.env.StallionAPI?.trim() ||
    '';
  // Tolerate accidental leading '=' from STALLION_TOKEN==value typos.
  return raw.replace(/^=+/, '');
}

/**
 * Stallion v5 base URL (no trailing slash).
 * Defaults to production — rates-only probes use live quoting, never labels.
 */
export function stallionBaseUrl() {
  const explicit = process.env.STALLION_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  return STALLION_PRODUCTION_BASE_URL;
}

export function assertStallionRateEnv() {
  if (!stallionToken()) {
    throw new Error(
      'Missing Stallion token: set STALLION_TOKEN (or StallionAPI) in .env',
    );
  }
}
