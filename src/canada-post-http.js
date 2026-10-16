import dns from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';
import { CANADA_POST_CONNECT_TIMEOUT_MS } from './canada-post-config.js';

/**
 * Same IPv4 pin + dual-race as CAD RateShopping. CloudFront AAAA from this VM
 * hangs; a single /prices fetch must not burn the whole quote window.
 * Connect timeout is 3s (not 1.5s) so USA TLS to CloudFront can finish.
 */

/**
 * @param {string} hostname
 * @param {object} options
 * @param {(err: NodeJS.ErrnoException | null, address: string, family: number) => void} callback
 */
function ipv4Lookup(hostname, options, callback) {
  dns.lookup(
    hostname,
    {
      family: 4,
      hints: options?.hints,
      all: false,
    },
    callback,
  );
}

function createCanadaPostAgent() {
  return new Agent({
    connect: {
      family: 4,
      lookup: ipv4Lookup,
      timeout: CANADA_POST_CONNECT_TIMEOUT_MS,
    },
    pipelining: 0,
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
    connections: 1,
  });
}

/** @type {import('undici').Agent} */
let canadaPostAgent = createCanadaPostAgent();

export function resetCanadaPostHttpAgent() {
  const prev = canadaPostAgent;
  canadaPostAgent = createCanadaPostAgent();
  try {
    prev.destroy();
  } catch {
    // ignore
  }
}

/**
 * Hang / connect failures only — not HTTP 4xx business errors.
 * @param {unknown} err
 */
export function isCanadaPostHangError(err) {
  if (!err || typeof err !== 'object') return false;
  const name = err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : String(err);
  const code =
    'code' in err && err.code != null
      ? String(err.code)
      : err instanceof Error &&
          err.cause &&
          typeof err.cause === 'object' &&
          'code' in err.cause
        ? String(/** @type {{ code?: unknown }} */ (err.cause).code)
        : '';

  if (name === 'TimeoutError' || name === 'AbortError') return true;
  if (/timeout|aborted|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR/i.test(msg)) return true;
  if (/UND_ERR|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(code)) return true;
  return false;
}

/**
 * @param {string | URL} url
 * @param {RequestInit & { dispatcher?: unknown }} [init]
 * @returns {Promise<Response>}
 */
async function fetchFreshBuffered(url, init = {}) {
  const agent = createCanadaPostAgent();
  try {
    const res = await undiciFetch(url, {
      ...init,
      dispatcher: agent,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return new Response(buf, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  } finally {
    try {
      agent.destroy();
    } catch {
      // ignore
    }
  }
}

/**
 * @param {string | URL} url
 * @param {RequestInit & { dispatcher?: unknown }} [init]
 */
export async function canadaPostFetch(url, init = {}) {
  return fetchFreshBuffered(url, init);
}

/**
 * Two staggered IPv4-only requests; first HTTP response wins; loser aborted.
 * @param {string | URL} url
 * @param {RequestInit & { dispatcher?: unknown }} init
 * @param {number} timeoutMs
 */
export async function canadaPostFetchRace(url, init = {}, timeoutMs = 6000) {
  const budget = Math.max(800, Number(timeoutMs) || 6000);
  const deadline = AbortSignal.timeout(budget);
  const controllers = [new AbortController(), new AbortController()];

  /** @param {AbortController} ac */
  const linkDeadline = (ac) => {
    const abort = () => {
      try {
        ac.abort();
      } catch {
        // ignore
      }
    };
    deadline.addEventListener('abort', abort, { once: true });
    if (init.signal) {
      /** @type {AbortSignal} */ (init.signal).addEventListener('abort', abort, { once: true });
    }
  };

  /**
   * @param {number} idx
   * @param {number} staggerMs
   */
  const one = async (idx, staggerMs) => {
    if (staggerMs > 0) await new Promise((r) => setTimeout(r, staggerMs));
    if (deadline.aborted) {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }
    linkDeadline(controllers[idx]);
    return fetchFreshBuffered(url, {
      ...init,
      signal: controllers[idx].signal,
    });
  };

  try {
    const res = await Promise.any([one(0, 0), one(1, 50)]);
    for (const c of controllers) {
      try {
        c.abort();
      } catch {
        // ignore
      }
    }
    return res;
  } catch (err) {
    for (const c of controllers) {
      try {
        c.abort();
      } catch {
        // ignore
      }
    }
    if (
      err &&
      typeof err === 'object' &&
      'errors' in err &&
      Array.isArray(/** @type {{ errors: unknown[] }} */ (err).errors)
    ) {
      const first = /** @type {{ errors: unknown[] }} */ (err).errors[0];
      if (first) throw first;
    }
    throw err;
  }
}

/** no-op kept for call sites that invalidated a pin cache */
export function invalidateCanadaPostIpv4(_hostname) {}

/** Warm helper used at boot — forces an IPv4 resolve for the hostname. */
export async function resolveCanadaPostIpv4(hostname) {
  return new Promise((resolve, reject) => {
    ipv4Lookup(hostname, {}, (err, address) => {
      if (err) reject(err);
      else resolve(address);
    });
  });
}

export const CANADA_POST_HTTP_FAMILY = 4;
