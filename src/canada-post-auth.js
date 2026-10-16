import {
  assertCanadaPostQuoteCredentials,
  assertCanadaPostQuoteOnlyUrl,
  CANADA_POST_OAUTH_MAX_ROUNDS,
  CANADA_POST_OAUTH_ROUND_MS,
  canadaPostClientId,
  canadaPostClientSecret,
  canadaPostTokenUrl,
} from './canada-post-config.js';
import {
  CANADA_POST_HTTP_FAMILY,
  canadaPostFetchRace,
  isCanadaPostHangError,
  resetCanadaPostHttpAgent,
} from './canada-post-http.js';

const TOKEN_REFRESH_INTERVAL_MS = 20 * 60 * 1000;
const TOKEN_REFRESH_BUDGET_MS = 15000;
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

/** @type {{ token: string, expiresAt: number } | null} */
let cachedToken = null;

/** @type {ReturnType<typeof setInterval> | null} */
let refreshTimer = null;

/**
 * Fetch a fresh OAuth token via dual-raced IPv4 rounds (never one 9s hang).
 * @param {number} timeoutMs
 */
async function fetchCanadaPostAccessToken(timeoutMs) {
  const budgetMs = Math.max(1500, Number(timeoutMs) || TOKEN_REFRESH_BUDGET_MS);
  const started = Date.now();
  const url = canadaPostTokenUrl();
  assertCanadaPostQuoteOnlyUrl(url, 'oauth');

  const init = {
    method: 'POST',
    headers: {
      'X-IBM-Client-Id': canadaPostClientId(),
      'X-IBM-Client-Secret': canadaPostClientSecret(),
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'scope=merchant&grant_type=client_credentials',
  };

  /** @type {unknown} */
  let lastErr;
  for (let attempt = 1; attempt <= CANADA_POST_OAUTH_MAX_ROUNDS; attempt += 1) {
    const left = Math.max(0, budgetMs - (Date.now() - started));
    if (left < 800) {
      if (lastErr) throw lastErr;
      throw new Error(`Canada Post OAuth budget exhausted (${budgetMs}ms)`);
    }
    const roundMs = Math.min(CANADA_POST_OAUTH_ROUND_MS, left);
    try {
      const res = await canadaPostFetchRace(url, init, roundMs);
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Canada Post OAuth failed (HTTP ${res.status})`);
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error('Canada Post OAuth returned non-JSON body');
      }

      const token = json.access_token;
      if (!token) throw new Error('Canada Post OAuth response missing access_token');

      const expiresIn = Number(json.expires_in) || 3600;
      cachedToken = {
        token,
        expiresAt: Date.now() + expiresIn * 1000,
      };
      return token;
    } catch (err) {
      lastErr = err;
      const name = err instanceof Error ? err.name : 'Error';
      resetCanadaPostHttpAgent();
      if (!isCanadaPostHangError(err) || attempt >= CANADA_POST_OAUTH_MAX_ROUNDS) {
        const elapsedMs = Date.now() - started;
        console.warn(
          `[canada-post-usa] oauth error round=${attempt}/${CANADA_POST_OAUTH_MAX_ROUNDS} ` +
            `elapsedMs=${elapsedMs} budgetMs=${budgetMs} family=${CANADA_POST_HTTP_FAMILY} ` +
            `errName=${name} msg=${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
      console.warn(
        `[canada-post-usa] oauth retry after ${name} round=${attempt}/${CANADA_POST_OAUTH_MAX_ROUNDS} ` +
          `roundMs=${roundMs} leftMs=${Math.max(0, budgetMs - (Date.now() - started))} ` +
          `family=${CANADA_POST_HTTP_FAMILY}`,
      );
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr || 'Canada Post OAuth failed'));
}

/**
 * @param {number} [timeoutMs]
 * @param {{ forceRefresh?: boolean }} [opts]
 */
export async function getCanadaPostAccessToken(timeoutMs = 15000, opts = {}) {
  assertCanadaPostQuoteCredentials();

  if (opts.forceRefresh) {
    cachedToken = null;
  }

  const now = Date.now();
  if (cachedToken?.token && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token;
  }

  return fetchCanadaPostAccessToken(timeoutMs);
}

export function startCanadaPostTokenRefresh() {
  if (refreshTimer) return;

  const tick = () => {
    const now = Date.now();
    const freshEnough = cachedToken?.token && cachedToken.expiresAt > now + TOKEN_REFRESH_SKEW_MS;
    if (freshEnough) return;

    getCanadaPostAccessToken(TOKEN_REFRESH_BUDGET_MS)
      .then(() => console.log('[canada-post-usa] OAuth token refreshed (background)'))
      .catch((err) =>
        console.warn(
          `[canada-post-usa] OAuth background refresh failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
  };

  refreshTimer = setInterval(tick, TOKEN_REFRESH_INTERVAL_MS);
  if (typeof refreshTimer === 'object' && refreshTimer && 'unref' in refreshTimer) {
    refreshTimer.unref();
  }
  tick();
}

/**
 * @param {number} [timeoutMs]
 * @param {{ forceRefresh?: boolean }} [opts]
 */
export async function canadaPostAuthHeaders(timeoutMs = 15000, opts = {}) {
  const token = await getCanadaPostAccessToken(timeoutMs, opts);
  return {
    Authorization: `Bearer ${token}`,
    'X-IBM-Client-Id': canadaPostClientId(),
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Accept-Language': 'en-CA',
  };
}

export function clearCanadaPostTokenCache() {
  cachedToken = null;
}
