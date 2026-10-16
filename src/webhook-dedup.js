import { WEBHOOK_DEDUP_TTL_MS } from './config.js';

/** @type {Map<string, { expiresAt: number, response: Record<string, string> }>} */
const completedLabels = new Map();

/** @type {Map<string, Promise<Record<string, string>>>} */
const inFlight = new Map();

/**
 * Stable key for overlapping ShipHero Generate Label retries (order + first package weight).
 * Do not treat a later print (void in ShipHero, then Print again) as the same request —
 * that reuse is handled by in-flight coalescing only, not a completed-label cache.
 * @param {Record<string, unknown>} rawPayload
 * @returns {string|null}
 */
export function orderDedupKey(rawPayload) {
  const orderId = rawPayload.order_id != null ? String(rawPayload.order_id).trim() : '';
  const orderNumber =
    rawPayload.order_number != null ? String(rawPayload.order_number).trim() : '';
  const key = orderId || orderNumber;
  if (!key) return null;

  const packages = Array.isArray(rawPayload.packages) ? rawPayload.packages : [];
  const pkg = packages[0];
  const weight =
    pkg && typeof pkg === 'object' && pkg.weight_in_oz != null
      ? String(pkg.weight_in_oz)
      : '0';

  return `${key}:${weight}`;
}

function pruneExpired() {
  const now = Date.now();
  for (const [key, entry] of completedLabels) {
    if (entry.expiresAt <= now) completedLabels.delete(key);
  }
}

/** @param {unknown} result */
function isSuccessLabelResponse(result) {
  if (!result || typeof result !== 'object') return false;
  const obj = /** @type {Record<string, unknown>} */ (result);
  return (
    String(obj.code) === '200' &&
    (Boolean(obj.label) || (Array.isArray(obj.packages) && obj.packages.length > 0))
  );
}

/**
 * Coalesce concurrent Generate Label webhooks for the same order+weight.
 * Completed labels are not replayed: void-in-ShipHero then Print must buy a new label.
 * Optional WEBHOOK_DEDUP_TTL_MS > 0 still caches successes briefly for late retries.
 * @template T
 * @param {string|null} key
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
export async function withOrderDedup(key, run) {
  if (!key) return run();

  pruneExpired();

  const cacheCompleted = WEBHOOK_DEDUP_TTL_MS > 0;
  if (cacheCompleted) {
    const cached = completedLabels.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      console.log(`[dedup] returning cached label for ${key}`);
      return /** @type {T} */ (cached.response);
    }
  }

  const existing = inFlight.get(key);
  if (existing) {
    console.log(`[dedup] waiting on in-flight request for ${key}`);
    return /** @type {Promise<T>} */ (existing);
  }

  const promise = run()
    .then((result) => {
      if (cacheCompleted && isSuccessLabelResponse(result)) {
        completedLabels.set(key, {
          response: /** @type {Record<string, string>} */ (result),
          expiresAt: Date.now() + WEBHOOK_DEDUP_TTL_MS,
        });
      }
      return result;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, /** @type {Promise<Record<string, string>>> */ (promise));
  return promise;
}

/** Test helper. */
export function clearWebhookDedup() {
  completedLabels.clear();
  inFlight.clear();
}
