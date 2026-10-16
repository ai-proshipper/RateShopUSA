/**
 * Attach a US customs PDF to a ShipHero order after Print Label.
 * Never used by CAD Rate Shop. Failures must not affect the label webhook.
 */
import {
  getShipHeroAccessToken,
  shipHeroAuthConfigured,
  usaAttachCustomsToOrder,
} from './config.js';

const SHIPHERO_URL = 'https://public-api.shiphero.com/graphql';
const ATTACH_TIMEOUT_MS = 8000;
const ORDER_PREFIX_B64 = 'T3JkZXI6'; // "Order:"

const ATTACH_MUTATION = `
  mutation OrderAddAttachment($data: OrderAddAttachmentInput!) {
    order_add_attachment(data: $data) {
      request_id
      complexity
      attachment {
        id
        url
        filename
      }
    }
  }
`;

/**
 * Webhook order_id is numeric; GraphQL wants Order:{id} as base64.
 * @param {unknown} orderId
 */
export function shipHeroGraphqlOrderId(orderId) {
  const raw = String(orderId ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith(ORDER_PREFIX_B64)) return raw;
  return Buffer.from(`Order:${raw}`, 'utf8').toString('base64');
}

/**
 * ShipHero attachment names cannot include # @ ( ) % etc.
 * @param {unknown} tracking
 */
export function sanitizeAttachmentFilename(tracking) {
  const id = String(tracking || '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'usa';
  return `${id}-customs`.slice(0, 80);
}

/**
 * @param {'pdf'|'png'|string} [ext]
 */
export function attachmentFileType(ext) {
  return ext === 'png' ? 'image/png' : 'application/pdf';
}

/**
 * @param {{ orderId?: unknown, customsUrl?: string, tracking?: unknown, fileType?: string }} opts
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [runtime]
 */
export async function attachUsaCustomsToOrder(opts, runtime = {}) {
  const orderId = shipHeroGraphqlOrderId(opts.orderId);
  const url = String(opts.customsUrl || '').trim();
  if (!orderId || !url) {
    return { ok: false, skipped: true, reason: 'missing_order_or_url' };
  }
  if (!usaAttachCustomsToOrder()) {
    return { ok: false, skipped: true, reason: 'disabled' };
  }
  if (!shipHeroAuthConfigured() && !runtime.token) {
    return { ok: false, skipped: true, reason: 'missing_token' };
  }

  const filename = sanitizeAttachmentFilename(opts.tracking);
  const fileType = attachmentFileType(opts.fileType);
  const timeoutMs = runtime.timeoutMs || ATTACH_TIMEOUT_MS;
  const fetchImpl = runtime.fetchImpl || fetch;
  const tracking = String(opts.tracking || '').trim();
  const mutationBody = JSON.stringify({
    query: ATTACH_MUTATION,
    variables: {
      data: {
        order_id: orderId,
        url,
        filename,
        file_type: fileType,
        description: tracking
          ? `Commercial invoice ${tracking}`.slice(0, 200)
          : 'Commercial invoice',
      },
    },
  });

  async function postWithToken(token) {
    const res = await fetchImpl(SHIPHERO_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: mutationBody,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    return { res, body };
  }

  let token = runtime.token;
  if (!token) {
    try {
      token = await getShipHeroAccessToken({
        fetchImpl: runtime.authFetchImpl || fetch,
        timeoutMs,
      });
    } catch {
      return { ok: false, skipped: true, reason: 'missing_token' };
    }
  }

  let { res, body } = await postWithToken(token);
  if (res.status === 401 && !runtime.token && shipHeroAuthConfigured()) {
    try {
      token = await getShipHeroAccessToken({
        fetchImpl: runtime.authFetchImpl || fetch,
        timeoutMs,
        force: true,
      });
      ({ res, body } = await postWithToken(token));
    } catch {
      /* fall through to failure below */
    }
  }

  const attachment = body?.data?.order_add_attachment?.attachment;
  if (attachment?.id) {
    if (Array.isArray(body.errors) && body.errors.length) {
      console.warn(
        `[usa-label] customs attachment GraphQL warning (file still attached): ${body.errors
          .map((e) => e?.message)
          .filter(Boolean)
          .join('; ')}`,
      );
    }
    return { ok: true, attachmentId: attachment.id, filename };
  }

  const message =
    body.errors?.map((e) => e.message).filter(Boolean).join('; ') ||
    `HTTP ${res.status}`;
  throw new Error(`ShipHero order_add_attachment failed: ${message}`);
}

/**
 * Fire-and-forget after the webhook JSON is ready. Never throws to the print path.
 * @param {{ orderId?: unknown, customsUrl?: string, tracking?: unknown, fileType?: string }} opts
 */
export function scheduleUsaCustomsAttachment(opts) {
  const url = String(opts?.customsUrl || '').trim();
  const orderId = String(opts?.orderId ?? '').trim();
  if (!url) return;
  if (!usaAttachCustomsToOrder()) return;
  if (!orderId) {
    console.warn('[usa-label] customs PDF saved but order_id missing — cannot attach');
    return;
  }
  if (!shipHeroAuthConfigured()) {
    console.warn(
      '[usa-label] customs PDF saved but SHIPHERO_API_TOKEN / SHIPHERO_REFRESH_TOKEN is not set — skipping order attachment',
    );
    return;
  }

  console.log(
    `[usa-label] customs attachment scheduled order=${orderId} tracking=${opts.tracking || ''}`,
  );
  setImmediate(() => {
    attachUsaCustomsToOrder(opts).then(
      (result) => {
        if (result.skipped) {
          console.warn(`[usa-label] customs attachment skipped (${result.reason})`);
          return;
        }
        console.log(
          `[usa-label] customs attached to order filename=${result.filename} id=${result.attachmentId}`,
        );
      },
      (err) => {
        console.warn(
          `[usa-label] customs attachment failed: ${err instanceof Error ? err.message : err}`,
        );
      },
    );
  });
}
