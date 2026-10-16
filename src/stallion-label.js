/**
 * Stallion US Create Label → PDF → Void.
 * Probe always voids; Stallion charges credits on purchase.
 * Void is a request — credits typically return within 14 days if unused.
 */
import { isPdfBytes, isPngBytes } from './pdf-utils.js';
import { randomUUID } from 'node:crypto';
import { buildStallionRateBody, quoteStallion } from './stallion-rate.js';
import {
  STALLION_LABEL_TIMEOUT_MS,
  assertStallionShipmentEnv,
  assertStallionShippingUrl,
  isStallionLabelCarrierAllowed,
  isStallionLabelServiceAllowed,
  stallionAllowCreate,
  stallionLabelCarriers,
  stallionLabelServices,
  stallionLabelsUrl,
  stallionToken,
  stallionVoidUrl,
} from './stallion-config.js';

function unwrapData(raw) {
  if (raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object') {
    return raw.data;
  }
  return raw || {};
}

function apiError(data, status, text) {
  const err = data?.error;
  const code = err?.code || '';
  const msg = err?.message || data?.message || `HTTP ${status}`;
  const details =
    err?.details && typeof err.details === 'object' ? JSON.stringify(err.details) : '';
  const head = [code, msg].filter(Boolean).join(' ');
  return `${head}${details ? ` ${details}` : ''}${text ? `\nRaw: ${text.slice(0, 2500)}` : ''}`;
}

function isPdf(bytes) {
  return isPdfBytes(bytes);
}

/**
 * Build POST /labels body. Always includes from_address (unlike rates).
 * @param {Record<string, unknown>} shipment
 * @param {{ service?: string }} [opts]
 */
export function buildStallionLabelBody(shipment, opts = {}) {
  const s = shipment || {};
  const from = s.from || s.from_address;
  if (!from) throw new Error('Stallion US label requires from / from_address');

  const items = Array.isArray(s.items) ? s.items : [];
  if (items.length === 0) {
    throw new Error('Stallion US label requires items[] for customs');
  }

  const body = buildStallionRateBody({
    ...s,
    include_from_address: true,
  });

  if (!body.from_address) {
    throw new Error('Stallion US label requires from / from_address');
  }

  const service = String(opts.service || '').trim();
  if (service) body.service = service;

  return body;
}

function allowlistHint() {
  const services = stallionLabelServices();
  const listed = stallionLabelCarriers();
  const carriers = listed.length ? listed.join(', ') : 'any trackable last-mile';
  return services.length
    ? `Allowed carriers: ${carriers}. Allowed services: ${services.join(', ')}.`
    : `Allowed carriers: ${carriers}.`;
}

/**
 * Never buy a label we cannot track, or a carrier/service outside the allowlist.
 * @param {Record<string, unknown> | null | undefined} rate
 * @param {string} service
 * @param {{ shopName?: unknown }} [opts]
 */
export function assertStallionLabelRateAllowed(rate, service, opts = {}) {
  const code = String(service || rate?.service || '').trim();
  if (!code) {
    throw new Error('Stallion label refused: missing service code.');
  }
  if (!rate) {
    throw new Error(
      `Stallion label refused: ${code} did not appear on a rates quote, so trackability cannot be confirmed. ${allowlistHint()}`,
    );
  }
  if (rate.trackable !== true) {
    throw new Error(
      `Stallion label refused: ${code} is not trackable (trackable=${String(rate.trackable)}). Non-trackable labels are never purchased.`,
    );
  }
  if (!isStallionLabelServiceAllowed(code)) {
    throw new Error(
      `Stallion label refused: service ${code} is not on STALLION_LABEL_SERVICES. ${allowlistHint()}`,
    );
  }
  const carrier = String(rate.carrier || '').trim();
  const serviceName = String(rate.service_name || service || '').trim();
  const allowOpts = { shopName: opts.shopName };
  if (
    !isStallionLabelCarrierAllowed(carrier, allowOpts) &&
    !isStallionLabelCarrierAllowed(serviceName, allowOpts)
  ) {
    throw new Error(
      `Stallion label refused: carrier ${carrier || '(empty)'} is not on STALLION_LABEL_CARRIERS. ${allowlistHint()}`,
    );
  }
}

function isPurchasableRate(rate, shopName) {
  if (!rate?.service || rate.trackable !== true) return false;
  if (!isStallionLabelServiceAllowed(String(rate.service))) return false;
  const allowOpts = { shopName };
  return (
    isStallionLabelCarrierAllowed(rate.carrier, allowOpts) ||
    isStallionLabelCarrierAllowed(rate.service_name, allowOpts) ||
    isStallionLabelCarrierAllowed(rate.service, allowOpts)
  );
}

/**
 * Resolve carrier.service_code. Explicit arg wins; otherwise cheapest trackable quote.
 * @param {Record<string, unknown>} shipment
 * @param {string} [serviceArg]
 * @param {number} [timeoutMs]
 */
export async function resolveStallionLabelService(
  shipment,
  serviceArg = '',
  timeoutMs = STALLION_LABEL_TIMEOUT_MS,
) {
  const requested = String(serviceArg || '').trim();
  const shopName = shipment?.shopName;

  const quote = await quoteStallion(shipment, timeoutMs);
  if (quote.status !== 'ok') {
    throw new Error(
      `Stallion label needs a rates quote before purchase (quote failed: ${quote.message}).`,
    );
  }

  if (requested) {
    const match = quote.rates.find((r) => String(r.service || '') === requested);
    assertStallionLabelRateAllowed(match, requested, { shopName });
    return {
      service: requested,
      serviceName: match.service_name || requested,
      quotedRate: match,
    };
  }

  const eligible = quote.rates.filter((r) => isPurchasableRate(r, shopName));
  if (!eligible.length) {
    throw new Error(
      `Stallion label refused: no trackable rates to buy. ${allowlistHint()}`,
    );
  }

  eligible.sort((a, b) => Number(a.total) - Number(b.total));
  const picked = eligible[0];
  assertStallionLabelRateAllowed(picked, String(picked.service), { shopName });
  return {
    service: String(picked.service),
    serviceName: picked.service_name || String(picked.service),
    quotedRate: picked,
  };
}

/**
 * @param {string} labelUrl
 * @param {number} timeoutMs
 */
async function downloadStallionLabelPdf(labelUrl, timeoutMs) {
  if (!labelUrl) throw new Error('Stallion create response missing label_url');

  const headers = { Accept: 'application/pdf' };
  let res = await fetch(labelUrl, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.status === 401 || res.status === 403) {
    res = await fetch(labelUrl, {
      method: 'GET',
      headers: {
        ...headers,
        Authorization: `Bearer ${stallionToken()}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  if (!res.ok) {
    throw new Error(`Stallion label PDF download failed (HTTP ${res.status})`);
  }

  const pdfBytes = Buffer.from(await res.arrayBuffer());
  if (pdfBytes.length < 100) {
    throw new Error('Stallion label PDF download produced empty/short buffer');
  }
  if (!isPdf(pdfBytes)) {
    throw new Error('Stallion label_url did not return a PDF');
  }
  return pdfBytes;
}

const STALLION_CUSTOMS_URL_KEYS = [
  'commercial_invoice_url',
  'commercialInvoiceUrl',
  'customs_invoice_url',
  'customs_form_url',
  'cn22_url',
  'cn23_url',
];

/**
 * @param {Record<string, unknown>} payload
 */
export function extractStallionCustomsUrl(payload) {
  const data = payload || {};
  const labelUrl = String(data.label_url || '');
  for (const key of STALLION_CUSTOMS_URL_KEYS) {
    const value = data[key];
    if (typeof value === 'string' && /^https?:\/\//i.test(value) && value !== labelUrl) {
      return value;
    }
  }
  const docs = Array.isArray(data.documents) ? data.documents : [];
  for (const doc of docs) {
    const kind = String(doc?.type || doc?.kind || doc?.rel || '').toLowerCase();
    if (!/(invoice|customs|cn22|cn23)/.test(kind)) continue;
    const url = doc?.url || doc?.href;
    if (typeof url === 'string' && /^https?:\/\//i.test(url) && url !== labelUrl) {
      return url;
    }
  }
  return '';
}

/**
 * @param {string} documentUrl
 * @param {number} timeoutMs
 */
async function downloadStallionCustomsDocument(documentUrl, timeoutMs) {
  const headers = { Accept: 'application/pdf,image/png' };
  let res = await fetch(documentUrl, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401 || res.status === 403) {
    res = await fetch(documentUrl, {
      method: 'GET',
      headers: {
        ...headers,
        Authorization: `Bearer ${stallionToken()}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
  if (!res.ok) {
    throw new Error(`Stallion customs document download failed (HTTP ${res.status})`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (isPdfBytes(bytes)) return { bytes, ext: 'pdf' };
  if (isPngBytes(bytes)) return { bytes, ext: 'png' };
  throw new Error('Stallion customs URL did not return a PDF or PNG');
}

/**
 * @param {string|number} shipmentId
 * @param {number} [timeoutMs]
 */
export async function voidStallionShipment(shipmentId, timeoutMs = STALLION_LABEL_TIMEOUT_MS) {
  assertStallionShipmentEnv();
  if (!stallionAllowCreate()) {
    throw new Error('Stallion void refused: create/void gates are off');
  }
  const id = String(shipmentId || '').trim();
  if (!id) throw new Error('voidStallionShipment requires shipmentId');

  const url = stallionVoidUrl(id);
  assertStallionShippingUrl(url, 'void');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stallionToken()}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* empty */
  }

  if (res.ok) {
    const payload = unwrapData(data);
    return { ok: true, shipmentId: id, status: payload.status || null, raw: data };
  }

  const code = data?.error?.code || '';
  const hint =
    code === 'not_voidable' || res.status === 409
      ? ' Void manually in the Stallion dashboard to recover credits.'
      : '';
  throw new Error(`Stallion void failed: ${apiError(data, res.status, text)}${hint}`);
}

/**
 * Create US shipment, return PDF bytes (webhook keeps the label; probes void).
 * @param {Record<string, unknown>} shipment
 * @param {{ service?: string, timeoutMs?: number, idempotencyKey?: string, quotedRate?: Record<string, unknown> }} [opts]
 */
export async function createStallionUsLabel(shipment, opts = {}) {
  assertStallionShipmentEnv();
  if (!stallionAllowCreate()) {
    throw new Error(
      'Stallion label create is disabled. Set STALLION_ALLOW_TEST_CREATE=true ' +
        'and STALLION_ALLOW_PROD_CREATE_VOID=true for this probe.',
    );
  }

  const timeoutMs = opts.timeoutMs || STALLION_LABEL_TIMEOUT_MS;
  const shopName = shipment?.shopName;
  let resolved;
  if (opts.quotedRate && (opts.service || opts.quotedRate.service)) {
    const service = String(opts.service || opts.quotedRate.service).trim();
    assertStallionLabelRateAllowed(opts.quotedRate, service, { shopName });
    resolved = {
      service,
      serviceName: opts.quotedRate.service_name || service,
      quotedRate: opts.quotedRate,
    };
  } else {
    resolved = await resolveStallionLabelService(shipment, opts.service, timeoutMs);
  }
  const body = buildStallionLabelBody(shipment, { service: resolved.service });
  const url = stallionLabelsUrl();
  assertStallionShippingUrl(url, 'labels');

  const idempotencyKey = String(opts.idempotencyKey || randomUUID());
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stallionToken()}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Stallion Create Label non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(`Stallion Create Label failed: ${apiError(data, res.status, text)}`);
  }

  const payload = unwrapData(data);
  const shipmentId = payload.shipment_id ?? payload.id;
  const trackingNumber = payload.tracking_number || '';
  const labelUrl = payload.label_url || '';
  const rate = payload.rate || resolved.quotedRate || null;

  if (!shipmentId) throw new Error('Stallion create response missing shipment_id');
  if (!labelUrl) throw new Error('Stallion create response missing label_url');
  if (!trackingNumber) {
    throw new Error(
      'Stallion create response missing tracking_number. Do not treat this label as shipped; void it.',
    );
  }

  assertStallionLabelRateAllowed(
    {
      service: rate?.service || resolved.service,
      service_name: rate?.service_name || resolved.serviceName || resolved.quotedRate?.service_name,
      carrier: rate?.carrier || resolved.quotedRate?.carrier,
      trackable: rate?.trackable ?? resolved.quotedRate?.trackable,
    },
    resolved.service,
    { shopName },
  );

  const pdfBytes = await downloadStallionLabelPdf(labelUrl, timeoutMs);

  let customsPdfBytes = null;
  let customsExt = 'pdf';
  const customsUrl = extractStallionCustomsUrl(payload);
  if (customsUrl) {
    try {
      const invoiceTimeout = Math.min(8000, timeoutMs);
      const doc = await downloadStallionCustomsDocument(customsUrl, invoiceTimeout);
      customsPdfBytes = doc.bytes;
      customsExt = doc.ext;
    } catch (err) {
      console.warn(
        `[stallion-label] customs document download failed — omitting customs_info: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  return {
    shipmentId: String(shipmentId),
    shipCode: payload.ship_code || '',
    trackingNumber: String(trackingNumber),
    serviceCode: resolved.service,
    serviceName: rate?.service_name || resolved.serviceName,
    cost: rate?.total ?? null,
    currency: rate?.currency || null,
    labelUrl,
    pdfBytes,
    customsPdfBytes,
    customsExt,
    createResponse: data,
  };
}
