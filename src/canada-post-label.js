/**
 * Canada Post US Create Shipment → Get Artifact → Void.
 * Uses Developer Portal shipping/v1 JSON (same stack as CAD RateShopping).
 * Never sets transmitShipment — probe always voids.
 */
import {
  canadaPostAuthHeaders,
  clearCanadaPostTokenCache,
  getCanadaPostAccessToken,
} from './canada-post-auth.js';
import { canadaPostFetch } from './canada-post-http.js';
import {
  assertSingleDeclaredCurrency,
  isCad,
  isUsd,
  usdToCadRate,
} from './currency.js';
import { isPdfBytes, isPngBytes } from './pdf-utils.js';
import {
  assertCanadaPostShipmentEnv,
  assertCanadaPostShippingUrl,
  CANADA_POST_US_SERVICE_CODES,
  canadaPostAllowCreate,
  canadaPostContractId,
  canadaPostCustomerNumber,
  canadaPostDailyGroupId,
  canadaPostPaymentMethod,
  canadaPostPickupPostal,
  canadaPostServiceDisplayName,
  canadaPostShippingBaseUrl,
  canadaPostTrackingUrl,
  formatHsTariffCode,
  normalizePostal,
  usZip,
  zonosAccountKey,
} from './canada-post-config.js';

const LABEL_TIMEOUT_MS = Number(process.env.CANADA_POST_LABEL_TIMEOUT_MS) || 30000;

/** Canada Post dims: 3.1 pattern (one decimal cm). */
function cm1(inches) {
  return Math.round(Number(inches) * 2.54 * 10) / 10;
}

function kg3FromLbs(lbs) {
  return Math.round(Number(lbs) * 0.45359237 * 1000) / 1000;
}

function kg3FromOz(oz) {
  return Math.round(Number(oz) * 0.0283495 * 1000) / 1000;
}

function packageWeightKg(pkg) {
  if (pkg.weightLbs != null) return kg3FromLbs(pkg.weightLbs);
  if (pkg.weight_in_oz != null || pkg.weightOz != null) {
    return kg3FromOz(pkg.weight_in_oz ?? pkg.weightOz);
  }
  if (pkg.weight != null && String(pkg.weight_unit || '').toLowerCase() === 'kg') {
    return Math.round(Number(pkg.weight) * 1000) / 1000;
  }
  throw new Error('Canada Post US label requires package weight (weightLbs or weightOz)');
}

/**
 * CP wants units of customs currency per 1 CAD (e.g. 0.73 if 1 CAD = 0.73 USD).
 * @param {string} declaredCurrency
 * @returns {Promise<number|null>}
 */
export async function canadaPostConversionFromCad(declaredCurrency) {
  if (isCad(declaredCurrency)) return null;
  if (!isUsd(declaredCurrency)) {
    throw new Error(
      `Canada Post US customs currency ${declaredCurrency} is not CAD or USD`,
    );
  }
  const usdCad = await usdToCadRate();
  if (!Number.isFinite(usdCad) || usdCad <= 0) {
    throw new Error(
      'Canada Post US customs in USD require USD_TO_CAD_RATE or Bank of Canada FX (conversionFromCad)',
    );
  }
  return Math.round((1 / usdCad) * 1e6) / 1e6;
}

/**
 * @param {string} [serviceCode]
 */
export function resolveCanadaPostUsServiceCode(serviceCode = 'USA.EP') {
  const code = String(serviceCode || 'USA.EP').toUpperCase();
  if (!CANADA_POST_US_SERVICE_CODES.includes(code)) {
    throw new Error(
      `Canada Post US label refused service ${code}. Allowed: ${CANADA_POST_US_SERVICE_CODES.join(', ')}`,
    );
  }
  return code;
}

/**
 * Non-delivery handling (CP 8716 / 8551).
 * JSON shipping/v1 wants options as an array of { optionCode }.
 * Tracked Packet accepts RTS; EP/XP accept RASE/ABAN (not RTS).
 * @param {string} serviceCode
 */
export function canadaPostNonDeliveryOption(serviceCode) {
  const code = String(serviceCode || '').toUpperCase();
  if (code === 'USA.TP' || code === 'USA.TP.LVM') return 'RTS';
  return 'RASE';
}

/**
 * @param {string} serviceCode
 */
export function canadaPostDeliveryOptions(serviceCode) {
  return [{ optionCode: canadaPostNonDeliveryOption(serviceCode) }];
}

function compactJson(value) {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    return value.map(compactJson).filter((item) => item !== undefined);
  }
  if (typeof value !== 'object') return value;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (child == null || child === '') continue;
    const next = compactJson(child);
    if (next === undefined) continue;
    if (Array.isArray(next) && next.length === 0) continue;
    out[key] = next;
  }
  return out;
}

function voiceNumber(raw, fallback) {
  const cleaned = String(raw || '').replace(/[^\d+()-]/g, '').slice(0, 25);
  return cleaned || fallback;
}

function addressDetails(addr, countryCode, postal) {
  /** @type {Record<string, unknown>} */
  const details = {
    addressLine1: String(addr.address1 || addr.address_1 || '').slice(0, 44),
    city: String(addr.city || '').slice(0, 40),
    provState: String(addr.state || '').slice(0, 2).toUpperCase(),
    countryCode,
    postalZipCode: postal,
  };
  const line2 = String(addr.address2 || addr.address_2 || '').trim().slice(0, 44);
  if (line2) details.addressLine2 = line2;
  return details;
}

/**
 * shipping/v1 JSON schema: repeating XML nodes become arrays (error 8551 if we send objects).
 * @param {Record<string, unknown>} body
 */
export function assertCanadaPostUsCreateBody(body) {
  const spec = body?.deliverySpec;
  if (!spec || typeof spec !== 'object') {
    throw new Error('Canada Post US create body missing deliverySpec');
  }
  const options = spec.options;
  if (!Array.isArray(options) || options.length < 1) {
    throw new Error('Canada Post US create expects deliverySpec.options as a non-empty array');
  }
  for (const option of options) {
    if (!option || typeof option !== 'object' || !option.optionCode) {
      throw new Error('Canada Post US create option must be { optionCode }');
    }
  }
  const skuList = spec.customs?.skuList;
  if (!Array.isArray(skuList) || skuList.length < 1) {
    throw new Error('Canada Post US create expects customs.skuList as a non-empty array');
  }
}

/**
 * Build Create Shipment JSON for CA → US.
 * @param {Record<string, unknown>} shipment
 * @param {{ serviceCode?: string, conversionFromCad?: number|null }} [opts]
 */
export function buildCanadaPostUsCreateShipmentBody(shipment, opts = {}) {
  const from = shipment.from || {};
  const to = shipment.to || {};
  const pkg = shipment.packages?.[0];
  if (!pkg) throw new Error('Canada Post US label requires packages[0]');

  const items = Array.isArray(shipment.items) ? shipment.items : [];
  if (items.length === 0) {
    throw new Error('Canada Post US label requires items[] for customs');
  }
  const declaredCurrency = assertSingleDeclaredCurrency(items, shipment);

  const weight = packageWeightKg(pkg);
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new Error('Canada Post US label requires positive package weight');
  }

  const destZip = usZip(to.postalCode || to.postal_code || to.zip);
  if (!destZip || destZip.replace(/\D/g, '').length < 5) {
    throw new Error('Canada Post US label requires a 5-digit destination ZIP');
  }

  const serviceCode = resolveCanadaPostUsServiceCode(opts.serviceCode);
  const customer = canadaPostCustomerNumber();
  const contract = canadaPostContractId();
  const pickup = canadaPostPickupPostal();
  const groupId = canadaPostDailyGroupId();

  /** @type {Record<string, unknown>} */
  const parcelCharacteristics = { weight };
  const lengthIn = Number(pkg.lengthIn ?? pkg.length);
  const widthIn = Number(pkg.widthIn ?? pkg.width);
  const heightIn = Number(pkg.heightIn ?? pkg.height);
  if ([lengthIn, widthIn, heightIn].every((v) => Number.isFinite(v) && v > 0)) {
    parcelCharacteristics.dimensions = {
      length: cm1(lengthIn),
      width: cm1(widthIn),
      height: cm1(heightIn),
    };
  }

  const senderCompany =
    String(from.company || from.company_name || from.name || 'Shipper').slice(0, 44) || 'Shipper';
  const destName = String(to.name || to.company || to.company_name || 'Recipient').slice(0, 44);

  const totalQty = items.reduce(
    (sum, item) => sum + Math.max(1, Math.floor(Number(item.quantity) || 1)),
    0,
  );

  const skuItems = items.map((item, index) => {
    const origin = String(item.country_of_origin || item.countryOfOrigin || 'CA')
      .slice(0, 2)
      .toUpperCase();
    const qty = Math.max(1, Math.floor(Number(item.quantity) || 1));
    const value = Number(item.value ?? item.customs_value ?? item.price);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Canada Post US customs item missing value (sku=${item.sku || '?'})`);
    }
    /** @type {Record<string, unknown>} */
    const row = {
      customsNumberOfUnits: qty,
      customsDescription: String(
        item.customs_description || item.title || item.name || item.sku || 'Merchandise',
      ).slice(0, 45),
      unitWeight: 0.001,
      customsValuePerUnit: Math.round(value * 100) / 100,
      countryOfOrigin: origin,
    };
    if (item.sku) row.sku = String(item.sku).slice(0, 15);
    const hs = formatHsTariffCode(item.hs_code || item.hsCode || item.tariff_code);
    if (hs) row.hsTariffCode = hs;
    if (origin === 'CA') {
      row.provinceOfOrigin = String(
        item.province_of_origin || from.state || shipment.region || 'ON',
      )
        .slice(0, 2)
        .toUpperCase();
    }
    return { row, qty, index };
  });

  // Line unitWeight * qty must sum to <= parcel kg (CP error 2700). Last line gets remainder.
  let allocatedKg = 0;
  for (let i = 0; i < skuItems.length; i += 1) {
    const { row, qty } = skuItems[i];
    const isLast = i === skuItems.length - 1;
    let lineKg;
    if (isLast) {
      lineKg = Math.max(0.001 * qty, Math.round((weight - allocatedKg) * 1000) / 1000);
    } else {
      lineKg = Math.max(
        0.001 * qty,
        Math.floor((weight * (qty / totalQty)) * 1000) / 1000,
      );
    }
    allocatedKg += lineKg;
    row.unitWeight = Math.max(0.001, Math.round((lineKg / qty) * 1000) / 1000);
  }
  const skuList = skuItems.map((s) => s.row);

  /** @type {Record<string, unknown>} */
  const customs = {
    currency: declaredCurrency,
    reasonForExport: 'SOG',
    // shipping/v1 expects skuList as an array (not { item: [...] }).
    skuList,
  };
  if (!isCad(declaredCurrency)) {
    const factor = Number(opts.conversionFromCad);
    if (!Number.isFinite(factor) || factor <= 0) {
      throw new Error(
        `Canada Post US customs in ${declaredCurrency} require conversionFromCad (units of ${declaredCurrency} per 1 CAD)`,
      );
    }
    customs.conversionFromCad = factor;
  }

  /** @type {Record<string, unknown>} */
  const body = {
    groupId,
    cpcPickupIndicator: true,
    requestedShippingPoint: pickup,
    deliverySpec: {
      serviceCode,
      sender: {
        name: String(from.name || senderCompany).slice(0, 44),
        company: senderCompany,
        contactPhone: voiceNumber(from.phone, '9055550100'),
        addressDetails: addressDetails(
          from,
          'CA',
          normalizePostal(from.postalCode || from.postal_code || pickup),
        ),
      },
      destination: {
        name: destName,
        clientVoiceNumber: voiceNumber(to.phone, '2125550100'),
        addressDetails: addressDetails(to, 'US', destZip),
      },
      options: canadaPostDeliveryOptions(serviceCode),
      parcelCharacteristics,
      printPreferences: {
        outputFormat: '4x6',
        encoding: 'PDF',
      },
      preferences: {
        showPackingInstructions: false,
        showPostageRate: true,
        showInsuredValue: false,
      },
      references: {
        customerRef1: String(shipment.orderNumber || shipment.orderId || 'PROBE-US')
          .slice(0, 35),
      },
      customs,
      settlementInfo: {
        paidByCustomer: customer,
        intendedMethodOfPayment: canadaPostPaymentMethod(),
      },
    },
  };

  if (to.company || to.company_name) {
    /** @type {Record<string, unknown>} */ (body.deliverySpec).destination = {
      .../** @type {object} */ (
        /** @type {Record<string, unknown>} */ (body.deliverySpec).destination
      ),
      company: String(to.company || to.company_name).slice(0, 44),
    };
  }

  if (contract) {
    /** @type {Record<string, unknown>} */ (body.deliverySpec).settlementInfo = {
      .../** @type {object} */ (
        /** @type {Record<string, unknown>} */ (body.deliverySpec).settlementInfo
      ),
      contractId: contract,
    };
  }

  if ('transmitShipment' in body) {
    delete body.transmitShipment;
  }

  const compact = compactJson(body);
  assertCanadaPostUsCreateBody(compact);
  return compact;
}

/**
 * @param {Record<string, unknown>} body
 */
export function assertNoTransmitOnCreate(body) {
  if (body.transmitShipment === true) {
    throw new Error('Canada Post safety: transmitShipment must never be set on Create Shipment');
  }
  if (!body.groupId) {
    throw new Error('Canada Post Create Shipment requires groupId (manifest workflow)');
  }
}

/**
 * @param {Record<string, unknown>} createResponse
 */
export function extractCanadaPostInvoiceLink(createResponse) {
  const links = Array.isArray(createResponse?.links) ? createResponse.links : [];
  const link = links.find((l) => {
    const rel = String(l?.rel || '')
      .toLowerCase()
      .replace(/[_-\s]/g, '');
    return rel === 'commercialinvoice';
  });
  if (!link?.href) {
    return { href: '', mediaType: 'application/pdf' };
  }
  return {
    href: String(link.href),
    mediaType: String(link.mediaType || 'application/pdf'),
  };
}

/**
 * @param {Record<string, unknown>} createResponse
 */
export function extractCanadaPostLabelMeta(createResponse) {
  const shipmentId = String(createResponse.shipmentId || '');
  const trackingPin = String(createResponse.trackingPin || '');
  const links = Array.isArray(createResponse.links) ? createResponse.links : [];
  const labelLink = links.find((l) => l?.rel === 'label');
  const labelHref = labelLink?.href ? String(labelLink.href) : '';
  const invoice = extractCanadaPostInvoiceLink(createResponse);
  return {
    shipmentId,
    trackingPin,
    labelHref,
    mediaType: labelLink?.mediaType || 'application/pdf',
    invoiceHref: invoice.href,
    invoiceMediaType: invoice.mediaType,
  };
}

/**
 * Auth headers for Create / Void.
 * US Create Shipment requires X-CPC-Zonos-Key (CP error 8722) even when the
 * merchant account is Zonos-linked. GraphQL quotes still use ZONOS_API_KEY only.
 * @param {number} [timeoutMs]
 * @param {{ forceRefresh?: boolean }} [opts]
 */
export async function canadaPostUsShippingAuthHeaders(timeoutMs = LABEL_TIMEOUT_MS, opts = {}) {
  const headers = await canadaPostAuthHeaders(timeoutMs, opts);
  const key = zonosAccountKey();
  if (!key) {
    throw new Error(
      'ZONOS_ACCOUNT_KEY is required for US Canada Post labels (X-CPC-Zonos-Key). ' +
        'Canada Post error 8722: US shipments need a Zonos Declaration ID or Account Key.',
    );
  }
  return {
    ...headers,
    'X-CPC-Zonos-Key': key,
  };
}

/**
 * @param {string} shipmentId
 * @param {number} [timeoutMs]
 */
export async function voidCanadaPostShipment(shipmentId, timeoutMs = LABEL_TIMEOUT_MS) {
  assertCanadaPostShipmentEnv();
  if (!canadaPostAllowCreate()) {
    throw new Error('Canada Post void refused: create/void gates are off');
  }
  if (!shipmentId) throw new Error('voidCanadaPostShipment requires shipmentId');

  const customer = canadaPostCustomerNumber();
  const headers = await canadaPostAuthHeaders(timeoutMs);
  const url = `${canadaPostShippingBaseUrl()}/${customer}/${customer}/shipments/${encodeURIComponent(shipmentId)}`;
  assertCanadaPostShippingUrl(url);

  const res = await fetch(url, {
    method: 'DELETE',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok && res.status !== 204) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Canada Post void failed (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`,
    );
  }
  return { ok: true, shipmentId };
}

/**
 * @param {string} labelHref
 * @param {string} mediaType
 * @param {number} timeoutMs
 */
async function downloadCanadaPostLabelPdf(labelHref, mediaType, timeoutMs) {
  const token = await getCanadaPostAccessToken(timeoutMs);
  const res = await fetch(labelHref, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-IBM-Client-Id': process.env.CANADA_POST_CLIENT_ID?.trim() || '',
      Accept: mediaType || 'application/pdf',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Canada Post Get Artifact failed (HTTP ${res.status})`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Create US shipment, download PDF bytes, return meta (caller should void).
 * @param {Record<string, unknown>} shipment
 * @param {{ serviceCode?: string, timeoutMs?: number }} [opts]
 */
export async function createCanadaPostUsLabel(shipment, opts = {}) {
  assertCanadaPostShipmentEnv();
  if (!canadaPostAllowCreate()) {
    throw new Error(
      'Canada Post label create is disabled. Set CANADA_POST_ALLOW_TEST_CREATE=true ' +
        '(and CANADA_POST_ALLOW_PROD_CREATE_VOID=true in production) for this probe.',
    );
  }

  const timeoutMs = opts.timeoutMs || LABEL_TIMEOUT_MS;
  const declaredCurrency = assertSingleDeclaredCurrency(
    Array.isArray(shipment.items) ? shipment.items : [],
    shipment,
  );
  const conversionFromCad = await canadaPostConversionFromCad(declaredCurrency);
  const body = buildCanadaPostUsCreateShipmentBody(shipment, {
    serviceCode: opts.serviceCode || 'USA.EP',
    conversionFromCad: conversionFromCad ?? undefined,
  });
  assertNoTransmitOnCreate(body);
  assertCanadaPostUsCreateBody(body);

  const customer = canadaPostCustomerNumber();
  let headers = await canadaPostUsShippingAuthHeaders(timeoutMs);
  const url = `${canadaPostShippingBaseUrl()}/${customer}/${customer}/shipments`;
  assertCanadaPostShippingUrl(url);

  let authRetried = false;
  /** @type {Response} */
  let res;
  /** @type {string} */
  let text;
  for (;;) {
    res = await canadaPostFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
    if (res.status === 401 && !authRetried) {
      authRetried = true;
      clearCanadaPostTokenCache();
      console.warn(
        `[canada-post-usa] create HTTP 401 — refreshing OAuth and retrying ` +
          `body=${text.slice(0, 120).replace(/\s+/g, ' ')}`,
      );
      headers = await canadaPostUsShippingAuthHeaders(timeoutMs, { forceRefresh: true });
      continue;
    }
    break;
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Canada Post Create Shipment non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    const errBits = Array.isArray(data?.errors)
      ? data.errors
          .map((e) => {
            const code = e?.code || e?.errorCode || '';
            const desc = e?.description || e?.message || e?.detail || '';
            return [code, desc].filter(Boolean).join(' ');
          })
          .filter(Boolean)
          .join('; ')
      : '';
    const msg =
      errBits ||
      data?.detail ||
      data?.title ||
      data?.message ||
      `HTTP ${res.status}`;
    throw new Error(
      `Canada Post Create Shipment failed: ${msg}` +
        (text ? `\nRaw: ${text.slice(0, 2500)}` : ''),
    );
  }

  const meta = extractCanadaPostLabelMeta(data);
  if (!meta.shipmentId) throw new Error('Canada Post create response missing shipmentId');
  if (!meta.labelHref) throw new Error('Canada Post create response missing label artifact link');

  const pdfBytes = await downloadCanadaPostLabelPdf(meta.labelHref, meta.mediaType, timeoutMs);

  let customsPdfBytes = null;
  let customsExt = 'pdf';
  if (meta.invoiceHref && meta.invoiceHref !== meta.labelHref) {
    try {
      const invoiceTimeout = Math.min(8000, timeoutMs);
      const invoiceBytes = await downloadCanadaPostLabelPdf(
        meta.invoiceHref,
        meta.invoiceMediaType,
        invoiceTimeout,
      );
      if (isPdfBytes(invoiceBytes)) {
        customsPdfBytes = invoiceBytes;
        customsExt = 'pdf';
      } else if (isPngBytes(invoiceBytes)) {
        customsPdfBytes = invoiceBytes;
        customsExt = 'png';
      } else {
        console.warn(
          '[canada-post-label] commercialinvoice artifact was not PDF or PNG — omitting customs_info',
        );
      }
    } catch (err) {
      console.warn(
        `[canada-post-label] commercialinvoice download failed — omitting customs_info: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  return {
    shipmentId: meta.shipmentId,
    trackingPin: meta.trackingPin,
    groupId: String(body.groupId),
    serviceCode: resolveCanadaPostUsServiceCode(opts.serviceCode || 'USA.EP'),
    serviceName: canadaPostServiceDisplayName(opts.serviceCode || 'USA.EP'),
    trackingUrl: canadaPostTrackingUrl(meta.trackingPin),
    pdfBytes,
    customsPdfBytes,
    customsExt,
    createResponse: data,
  };
}
