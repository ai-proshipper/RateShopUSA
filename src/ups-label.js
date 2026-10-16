/**
 * UPS US Create Shipment → PDF label → Void.
 * Worldwide Expedited (08), 3 Day Select (12), and Standard (11).
 * Probe always voids; UPS bills postage on create.
 */
import { decodeDocumentBase64, isPdfBytes } from './pdf-utils.js';
import { upsQuoteHeaders } from './ups-auth.js';
import { assertSingleDeclaredCurrency } from './currency.js';
import {
  UPS_LABEL_TIMEOUT_MS,
  UPS_QUOTE_SERVICE_CODES,
  UPS_STANDARD_SERVICE_CODE,
  assertUpsShipmentEnv,
  assertUpsShippingUrl,
  isUpsQuoteService,
  upsAccountNumber,
  upsAllowCreate,
  upsPostalCode,
  upsQuoteServiceCodes,
  upsServiceName,
  upsShippingUrl,
  upsTrackingUrl,
  upsVoidUrl,
} from './ups-config.js';

function digitsPhone(value, fallback) {
  const digits = String(value || '').replace(/[^\d+]/g, '').slice(0, 15);
  return digits || fallback;
}

function money2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function todayYmd(date = new Date()) {
  const tz = process.env.UPS_GROUP_TZ || 'America/Toronto';
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
  return `${parts.year}${parts.month}${parts.day}`;
}

function packageWeightLbs(pkg) {
  if (pkg.weightLbs != null) return Number(pkg.weightLbs);
  if (pkg.weightOz != null) return Number(pkg.weightOz) / 16;
  if (pkg.weight_in_oz != null) return Number(pkg.weight_in_oz) / 16;
  if (pkg.weight != null && String(pkg.weight_unit || '').toLowerCase() === 'lbs') {
    return Number(pkg.weight);
  }
  throw new Error('UPS US label requires package weight (weightLbs or weightOz)');
}

function mapParty(address, opts = {}) {
  const source = address || {};
  const lines = [
    source.address1 || source.address_1,
    source.address2 || source.address_2,
  ]
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .slice(0, 2);
  const name = String(source.name || source.company || source.company_name || 'Shipper').slice(
    0,
    35,
  );
  const company = String(source.company || source.company_name || '').trim().slice(0, 35);
  const countryCode = String(source.country || source.country_code || opts.country || 'CA')
    .slice(0, 2)
    .toUpperCase();
  const mapped = {
    Name: (company || name).slice(0, 35),
    AttentionName: name,
    Phone: {
      Number: digitsPhone(source.phone, opts.fallbackPhone || '9055550100'),
    },
    Address: {
      AddressLine: lines.length ? lines.map((line) => line.slice(0, 35)) : ['N/A'],
      City: String(source.city || '').slice(0, 30),
      StateProvinceCode: String(source.state || source.province || '').slice(0, 5),
      PostalCode: upsPostalCode(
        source.postalCode || source.postal_code || source.zip,
        countryCode,
      ),
      CountryCode: countryCode,
    },
  };
  if (opts.includeShipperNumber) {
    mapped.ShipperNumber = upsAccountNumber();
  }
  if (
    opts.residential === true ||
    source.is_residential === true ||
    source.residential === true ||
    (!company && opts.allowResidential)
  ) {
    mapped.Address.ResidentialAddressIndicator = 'Y';
  }
  return mapped;
}

/**
 * @param {string} [serviceCode]
 * @param {Record<string, unknown>} [shipment]
 */
export function resolveUpsUsServiceCode(serviceCode, shipment) {
  const code = String(serviceCode || '').padStart(2, '0');
  if (!isUpsQuoteService(code, shipment)) {
    const allowed = shipment
      ? upsQuoteServiceCodes(shipment)
      : [...UPS_QUOTE_SERVICE_CODES, UPS_STANDARD_SERVICE_CODE];
    throw new Error(
      `UPS US label refused service ${code || '(empty)'}. Allowed: ${allowed.join(', ')}`,
    );
  }
  return code;
}

function mapCustomsProducts(shipment, pkg, declaredCurrency) {
  const items = Array.isArray(shipment.items) ? shipment.items : [];
  if (items.length === 0) {
    throw new Error('UPS US label requires items[] for customs');
  }
  const pkgWeight = packageWeightLbs(pkg);
  const totalQty = items.reduce((sum, item) => sum + Math.max(1, Number(item.quantity) || 1), 0);

  return items.map((item, index) => {
    const qty = Math.max(1, Math.floor(Number(item.quantity) || 1));
    const value = money2(item.value ?? item.customs_value ?? item.price);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`UPS US customs item missing value (sku=${item.sku || index + 1})`);
    }
    const origin = String(item.country_of_origin || item.originCountryCode || 'CA')
      .slice(0, 2)
      .toUpperCase();
    const hs = String(item.hs_code || item.hsCode || item.tariff_code || '').replace(/\D/g, '');
    const description = String(
      item.customs_description || item.description || item.title || item.sku || 'Merchandise',
    ).slice(0, 35);
    const unitWeight =
      totalQty > 0 && Number.isFinite(pkgWeight) && pkgWeight > 0
        ? Math.max(0.1, Math.round((pkgWeight * (qty / totalQty)) * 100) / 100)
        : 0.1;
    /** @type {Record<string, unknown>} */
    const product = {
      Description: description,
      OriginCountryCode: origin,
      Unit: {
        Number: String(qty),
        UnitOfMeasurement: { Code: 'PCS', Description: 'Pieces' },
        Value: value.toFixed(2),
      },
      Number: String(qty),
      Value: {
        MonetaryValue: (value * qty).toFixed(2),
        CurrencyCode: declaredCurrency,
      },
    };
    if (hs) product.CommodityCode = hs.slice(0, 15);
    if (item.sku) {
      product.PartNumber = String(item.sku)
        .replace(/[^A-Za-z0-9_-]/g, '-')
        .slice(0, 35);
    }
    product.ProductWeight = {
      UnitOfMeasurement: { Code: 'LBS', Description: 'Pounds' },
      Weight: String(unitWeight),
    };
    return product;
  });
}

function invoiceTotal(products) {
  return products.reduce((sum, product) => {
    const unitValue = Number(product.Unit?.Value);
    const qty = Number(product.Unit?.Number || 1);
    return sum + unitValue * qty;
  }, 0);
}

/**
 * Build Shipping API JSON for CA → US.
 * @param {Record<string, unknown>} shipment
 * @param {{ serviceCode?: string }} [opts]
 */
export function buildUpsUsShipBody(shipment, opts = {}) {
  const from = shipment.from || {};
  const to = shipment.to || {};
  const pkg = shipment.packages?.[0];
  if (!pkg) throw new Error('UPS US label requires packages[0]');

  const serviceCode = resolveUpsUsServiceCode(opts.serviceCode, shipment);
  const account = upsAccountNumber();
  if (!account) throw new Error('UPS_ACCOUNT_NUMBER is required');

  const weight = packageWeightLbs(pkg);
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new Error('UPS US label requires a positive package weight');
  }
  const length = Number(pkg.lengthIn ?? pkg.length);
  const width = Number(pkg.widthIn ?? pkg.width);
  const height = Number(pkg.heightIn ?? pkg.height);
  if (![length, width, height].every((value) => value > 0)) {
    throw new Error('UPS US label requires positive package dimensions');
  }

  const destZip = upsPostalCode(to.postalCode || to.postal_code || to.zip, 'US');
  if (!destZip || destZip.length < 5) {
    throw new Error('UPS US label requires a 5-digit destination ZIP');
  }

  const orderRef = String(shipment.orderNumber || shipment.orderId || 'PROBE-US-UPS').slice(0, 35);
  const declaredCurrency = assertSingleDeclaredCurrency(shipment.items, shipment);
  const products = mapCustomsProducts(shipment, pkg, declaredCurrency);
  const invoiceAmount = money2(invoiceTotal(products));
  const shipFrom = mapParty(from, {
    includeShipperNumber: false,
    fallbackPhone: '9055550100',
    country: 'CA',
  });
  const shipper = mapParty(from, {
    includeShipperNumber: true,
    fallbackPhone: '9055550100',
    country: 'CA',
  });
  const shipTo = mapParty(to, {
    fallbackPhone: '2125550100',
    country: 'US',
    allowResidential: true,
  });
  const goods = String(
    products[0]?.Description || pkg.package_contents || pkg.name || 'Merchandise',
  ).slice(0, 50);

  return {
    ShipmentRequest: {
      Request: {
        SubVersion: '1801',
        RequestOption: 'nonvalidate',
        TransactionReference: {
          CustomerContext: orderRef,
        },
      },
      Shipment: {
        Description: goods,
        Shipper: shipper,
        ShipTo: shipTo,
        ShipFrom: shipFrom,
        SoldTo: shipTo,
        PaymentInformation: {
          ShipmentCharge: [
            {
              Type: '01',
              BillShipper: { AccountNumber: account },
            },
            {
              Type: '02',
              BillShipper: { AccountNumber: account },
            },
          ],
        },
        Service: {
          Code: serviceCode,
          Description: upsServiceName(serviceCode),
        },
        InvoiceLineTotal: {
          CurrencyCode: declaredCurrency,
          MonetaryValue: invoiceAmount.toFixed(2),
        },
        NumOfPiecesInShipment: '1',
        Package: {
          Description: goods.slice(0, 35),
          Packaging: { Code: '02', Description: 'Customer Supplied Package' },
          Dimensions: {
            UnitOfMeasurement: { Code: 'IN', Description: 'Inches' },
            Length: String(Math.max(1, Math.ceil(length))),
            Width: String(Math.max(1, Math.ceil(width))),
            Height: String(Math.max(1, Math.ceil(height))),
          },
          PackageWeight: {
            UnitOfMeasurement: { Code: 'LBS', Description: 'Pounds' },
            Weight: String(Math.max(0.1, Math.round(weight * 100) / 100)),
          },
          ReferenceNumber: [{ Code: 'ON', Value: orderRef }],
        },
        ShipmentRatingOptions: {
          NegotiatedRatesIndicator: 'Y',
        },
        ShipmentServiceOptions: {
          InternationalForms: {
            FormType: ['01'],
            InvoiceNumber: orderRef.slice(0, 35),
            InvoiceDate: todayYmd(),
            ReasonForExport: 'SALE',
            CurrencyCode: declaredCurrency,
            TermsOfShipment: 'DDP',
            Product: products,
            Contacts: {
              SoldTo: shipTo,
            },
          },
        },
      },
      LabelSpecification: {
        LabelImageFormat: { Code: 'PDF', Description: 'PDF' },
        LabelStockSize: { Height: '6', Width: '4' },
      },
    },
  };
}

function graphicFromImageNode(image) {
  if (!image) return '';
  if (typeof image === 'string' && image.length >= 80) return image;
  if (Array.isArray(image)) {
    for (const item of image) {
      const found = graphicFromImageNode(item);
      if (found) return found;
    }
    return '';
  }
  if (typeof image !== 'object') return '';
  const rec = /** @type {Record<string, unknown>} */ (image);
  const direct =
    rec.GraphicImage || rec.graphicImage || rec.graphic_image;
  if (typeof direct === 'string' && direct.length >= 80) return direct;
  if (Array.isArray(direct)) {
    const found = graphicFromImageNode(direct);
    if (found) return found;
  }
  return (
    graphicFromImageNode(rec.Image) ||
    graphicFromImageNode(rec.image) ||
    graphicFromImageNode(rec.FormImage) ||
    graphicFromImageNode(rec.formImage)
  );
}

/**
 * Commercial invoice image from Create Shipment — not the 4x6 label.
 * UPS Form Code 01 = "All Requested International Forms" (we request FormType 01).
 * @param {Record<string, unknown>} data
 * @returns {{ graphic: string, format: string, code: string, description: string } | null}
 */
export function extractUpsCommercialInvoice(data) {
  const results = data?.ShipmentResponse?.ShipmentResults || data?.ShipmentResults || data;
  /** @type {unknown[]} */
  const nodes = [];
  const pushForm = (value) => {
    if (!value) return;
    if (Array.isArray(value)) nodes.push(...value);
    else nodes.push(value);
  };
  pushForm(results?.Form);
  pushForm(results?.Forms);
  pushForm(results?.form);
  pushForm(results?.forms);
  const packageResults = results?.PackageResults || results?.packageResults;
  const pkgs = Array.isArray(packageResults) ? packageResults : packageResults ? [packageResults] : [];
  for (const pkg of pkgs) {
    pushForm(pkg?.Form);
    pushForm(pkg?.Forms);
    pushForm(pkg?.form);
    pushForm(pkg?.forms);
  }

  const forms = [];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const form = /** @type {Record<string, unknown>} */ (node);
    const graphic =
      graphicFromImageNode(form.Image) ||
      graphicFromImageNode(form.image) ||
      graphicFromImageNode(form.FormImage) ||
      graphicFromImageNode(form.formImage) ||
      graphicFromImageNode(form.GraphicImage) ||
      graphicFromImageNode(form.graphicImage);
    if (!graphic) continue;
    const image =
      (form.Image && typeof form.Image === 'object' && !Array.isArray(form.Image) && form.Image) ||
      (form.image && typeof form.image === 'object' && !Array.isArray(form.image) && form.image) ||
      form;
    const formatNode =
      /** @type {Record<string, unknown>} */ (image).ImageFormat ||
      /** @type {Record<string, unknown>} */ (image).imageFormat ||
      form.ImageFormat ||
      form.imageFormat;
    forms.push({
      graphic,
      format: String(
        (formatNode && typeof formatNode === 'object' && formatNode.Code) ||
          (formatNode && typeof formatNode === 'object' && formatNode.code) ||
          'PDF',
      ).toUpperCase(),
      code: String(form.Code || form.code || form.FormType || form.formType || '').trim(),
      description: String(form.Description || form.description || '').trim(),
    });
  }

  const invoice =
    forms.find((f) => f.code === '01' || /invoice|international form/i.test(f.description)) ||
    forms[0] ||
    null;
  return invoice;
}

/**
 * @param {Record<string, unknown>} data
 */
export function extractUpsShipMeta(data) {
  const results = data?.ShipmentResponse?.ShipmentResults;
  const shipmentId = String(results?.ShipmentIdentificationNumber || '').trim();
  const packageResults = results?.PackageResults;
  const pkg = Array.isArray(packageResults) ? packageResults[0] : packageResults;
  const tracking = String(pkg?.TrackingNumber || shipmentId || '').trim();
  const graphic = pkg?.ShippingLabel?.GraphicImage || '';
  const labelFormat = String(pkg?.ShippingLabel?.ImageFormat?.Code || 'PDF').toUpperCase();
  const form = extractUpsCommercialInvoice(data);

  const negotiated = results?.NegotiatedRateCharges?.TotalCharge;
  const cost =
    negotiated?.MonetaryValue != null
      ? Number(negotiated.MonetaryValue)
      : NaN;
  if (!Number.isFinite(cost)) {
    throw new Error('UPS shipment response missing negotiated rate charges');
  }

  return {
    shipmentId,
    trackingNumber: tracking,
    labelBase64: typeof graphic === 'string' ? graphic : '',
    labelFormat,
    formBase64: form?.graphic || '',
    formFormat: form?.format || '',
    cost,
    raw: results || data,
  };
}

function apiError(data, status, text) {
  const msg =
    data?.response?.errors?.[0]?.message ||
    data?.ShipmentResponse?.Response?.ResponseStatus?.Description ||
    data?.VoidShipmentResponse?.Response?.ResponseStatus?.Description ||
    `HTTP ${status}`;
  const extra = Array.isArray(data?.response?.errors)
    ? data.response.errors
        .map((e) => [e?.code, e?.message].filter(Boolean).join(' '))
        .filter(Boolean)
        .join('; ')
    : '';
  return `${extra && extra !== msg ? extra : msg}${text ? `\nRaw: ${text.slice(0, 2500)}` : ''}`;
}

/**
 * @param {string} shipmentIdentificationNumber
 * @param {number} [timeoutMs]
 */
export async function voidUpsShipment(
  shipmentIdentificationNumber,
  timeoutMs = UPS_LABEL_TIMEOUT_MS,
) {
  assertUpsShipmentEnv();
  if (!upsAllowCreate()) {
    throw new Error('UPS void refused: create/void gates are off');
  }
  const id = String(shipmentIdentificationNumber || '').trim();
  if (!id) throw new Error('voidUpsShipment requires ShipmentIdentificationNumber');

  const url = upsVoidUrl(id);
  assertUpsShippingUrl(url, 'void');
  const headers = await upsQuoteHeaders(Math.min(8000, timeoutMs));
  const res = await fetch(url, {
    method: 'DELETE',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* empty */
  }
  if (!res.ok) {
    throw new Error(`UPS void failed: ${apiError(data, res.status, text)}`);
  }
  return { ok: true, shipmentId: id, raw: data };
}

/**
 * Create US shipment, return PDF bytes (caller should void).
 * @param {Record<string, unknown>} shipment
 * @param {{ serviceCode?: string, timeoutMs?: number }} [opts]
 */
export async function createUpsUsLabel(shipment, opts = {}) {
  assertUpsShipmentEnv();
  if (!upsAllowCreate()) {
    throw new Error(
      'UPS label create is disabled. Set UPS_ALLOW_TEST_CREATE=true ' +
        'and UPS_ALLOW_PROD_CREATE_VOID=true for this probe.',
    );
  }

  const timeoutMs = opts.timeoutMs || UPS_LABEL_TIMEOUT_MS;
  const serviceCode = resolveUpsUsServiceCode(opts.serviceCode);
  const body = buildUpsUsShipBody(shipment, { serviceCode });
  const url = upsShippingUrl();
  assertUpsShippingUrl(url, 'ship');
  const headers = await upsQuoteHeaders(Math.min(8000, timeoutMs));

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`UPS Create Shipment non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(`UPS Create Shipment failed: ${apiError(data, res.status, text)}`);
  }

  const meta = extractUpsShipMeta(data);
  if (!meta.shipmentId) {
    throw new Error('UPS create response missing ShipmentIdentificationNumber');
  }
  if (!meta.labelBase64) {
    throw new Error('UPS create response missing label GraphicImage (PDF)');
  }

  const pdfBytes = Buffer.from(meta.labelBase64, 'base64');
  if (pdfBytes.length < 100) {
    throw new Error('UPS label PDF decode produced empty/short buffer');
  }
  if (!isPdfBytes(pdfBytes)) {
    throw new Error(
      'UPS returned a non-PDF label image. Re-check LabelSpecification PDF support for this account.',
    );
  }

  let customsPdfBytes = null;
  let customsExt = 'pdf';
  if (meta.formBase64) {
    const decoded = decodeDocumentBase64(meta.formBase64);
    if (decoded) {
      customsPdfBytes = decoded.bytes;
      customsExt = decoded.ext;
    } else {
      const head = Buffer.from(String(meta.formBase64).replace(/\s+/g, '').slice(0, 48), 'base64');
      const magic = head.slice(0, 6).toString('latin1');
      console.warn(
        `[ups-label] commercial invoice image was not PDF or PNG (magic=${JSON.stringify(magic)} format=${meta.formFormat || '?'}) — omitting customs_info`,
      );
    }
  }

  return {
    shipmentId: meta.shipmentId,
    trackingNumber: meta.trackingNumber,
    serviceCode,
    serviceName: upsServiceName(serviceCode),
    trackingUrl: upsTrackingUrl(meta.trackingNumber),
    cost: meta.cost,
    pdfBytes,
    labelFormat: meta.labelFormat,
    customsPdfBytes,
    customsExt,
    createResponse: data,
  };
}
