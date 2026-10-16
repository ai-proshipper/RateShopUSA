/**
 * ShipHero Public API access tokens expire ~every 28 days.
 * Keep a warm bearer via SHIPHERO_REFRESH_TOKEN (does not expire while the account is active).
 * Never logs token values.
 */
const REFRESH_URL = 'https://public-api.shiphero.com/auth/refresh';
/** Refresh when fewer than this many ms remain on the JWT. */
const REFRESH_SKEW_MS = 2 * 24 * 60 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 15000;
const BACKGROUND_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** @type {{ token: string, expiresAtMs: number | null } | null} */
let cached = null;
/** @type {Promise<string> | null} */
let inflight = null;
/** @type {ReturnType<typeof setInterval> | null} */
let refreshTimer = null;

export function shipHeroRefreshToken() {
  return process.env.SHIPHERO_REFRESH_TOKEN?.trim() || '';
}

export function shipHeroApiTokenSync() {
  return process.env.SHIPHERO_API_TOKEN?.trim() || '';
}

/** True when either an access token or refresh token is configured. */
export function shipHeroAuthConfigured() {
  return Boolean(shipHeroApiTokenSync() || shipHeroRefreshToken());
}

/**
 * Decode JWT exp without verifying signature. null = opaque / unreadable.
 * @param {string} token
 * @returns {number | null}
 */
export function shipHeroTokenExpiresAtMs(token) {
  const raw = String(token || '').trim();
  if (!raw || raw.split('.').length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(raw.split('.')[1], 'base64url').toString('utf8'));
    const exp = Number(payload?.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} token
 * @param {number} [nowMs]
 */
export function shipHeroTokenNeedsRefresh(token, nowMs = Date.now()) {
  const expMs = shipHeroTokenExpiresAtMs(token);
  if (expMs == null) return false;
  return expMs <= nowMs + REFRESH_SKEW_MS;
}

/**
 * @param {string} token
 * @param {number | null} [expiresAtMs]
 */
function rememberToken(token, expiresAtMs = shipHeroTokenExpiresAtMs(token)) {
  const trimmed = String(token || '').trim();
  if (!trimmed) return;
  cached = { token: trimmed, expiresAtMs };
  process.env.SHIPHERO_API_TOKEN = trimmed;
}

/**
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, force?: boolean }} [runtime]
 * @returns {Promise<string>}
 */
async function refreshAccessToken(runtime = {}) {
  const refreshToken = shipHeroRefreshToken();
  if (!refreshToken) {
    throw new Error('SHIPHERO_REFRESH_TOKEN is not set');
  }
  const fetchImpl = runtime.fetchImpl || fetch;
  const timeoutMs = runtime.timeoutMs || REFRESH_TIMEOUT_MS;
  const res = await fetchImpl(REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  const access = String(body?.access_token || '').trim();
  if (!res.ok || !access) {
    const detail =
      body?.error_description ||
      body?.error ||
      body?.message ||
      `HTTP ${res.status}`;
    throw new Error(`ShipHero token refresh failed (${detail})`);
  }
  const expiresIn = Number(body.expires_in);
  const expiresAtMs = Number.isFinite(expiresIn) && expiresIn > 0
    ? Date.now() + expiresIn * 1000
    : shipHeroTokenExpiresAtMs(access);
  rememberToken(access, expiresAtMs);
  return access;
}

/**
 * Return a usable ShipHero bearer token, refreshing when needed.
 * Opaque test tokens (non-JWT) are returned as-is when no refresh is forced.
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, force?: boolean }} [runtime]
 */
export async function getShipHeroAccessToken(runtime = {}) {
  const force = Boolean(runtime.force);
  const now = Date.now();

  if (!force && cached?.token) {
    if (cached.expiresAtMs == null || cached.expiresAtMs > now + REFRESH_SKEW_MS) {
      return cached.token;
    }
  }

  const envToken = shipHeroApiTokenSync();
  if (!force && envToken && !shipHeroTokenNeedsRefresh(envToken, now)) {
    rememberToken(envToken);
    return envToken;
  }

  if (!shipHeroRefreshToken()) {
    if (envToken) {
      rememberToken(envToken);
      return envToken;
    }
    throw new Error('SHIPHERO_API_TOKEN is not set');
  }

  if (inflight) return inflight;
  inflight = refreshAccessToken(runtime).finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Background refresh so US customs attach almost never pays a cold refresh.
 */
export function startShipHeroTokenRefresh() {
  if (refreshTimer) return;
  if (!shipHeroRefreshToken()) return;

  const tick = () => {
    getShipHeroAccessToken()
      .then((token) => {
        if (shipHeroTokenNeedsRefresh(token, Date.now() + BACKGROUND_INTERVAL_MS)) {
          return getShipHeroAccessToken({ force: true });
        }
        return token;
      })
      .then(() => {
        /* quiet when still fresh */
      })
      .catch((err) =>
        console.warn(
          `[shiphero] token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  };

  tick();
  refreshTimer = setInterval(tick, BACKGROUND_INTERVAL_MS);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
}

/** @internal test helper */
export function _resetShipHeroAuthForTests() {
  cached = null;
  inflight = null;
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
