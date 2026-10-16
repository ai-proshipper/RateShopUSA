/**
 * Unit tests: carrier customs docs only — no generated fallback.
 */
import assert from 'node:assert/strict';
import {
  isCanadaPostNoService,
  isCanadaPostQuoteTimeout,
  usaCanadaPostTimeoutShopError,
  usaCarriersMissingLandedRates,
  usaIncompleteShopError,
  hasUpsLandedRate,
  rankCadLanded,
  pickBuyableWinner,
  shouldComparePostage,
  postageCompareFromRanked,
  pickStallionDuty,
  dutiesDivergeOver50,
  CANADA_POST_QUOTE_TIMEOUT_MSG,
} from '../src/compare-quotes.js';
import { WEBHOOK_DEADLINE_MS, USA_MAX_DEADLINE_MS } from '../src/config.js';
import {
  assertCanadaPostUsCreateBody,
  buildCanadaPostUsCreateShipmentBody,
  canadaPostNonDeliveryOption,
  extractCanadaPostInvoiceLink,
} from '../src/canada-post-label.js';
import { decodeDocumentBase64, isPdfBytes } from '../src/pdf-utils.js';
import { parseGenerateLabelPayload } from '../src/shiphero-webhook.js';
import {
  isStallionLabelCarrierAllowed,
  isShopifyShopName,
  isStallionUsRegionalLabel,
} from '../src/stallion-config.js';
import { isCanadaPostHangError } from '../src/canada-post-http.js';
import {
  CANADA_POST_CONNECT_TIMEOUT_MS,
  CANADA_POST_OAUTH_ROUND_MS,
  CANADA_POST_PRICES_MAX_ROUNDS,
  CANADA_POST_PRICES_ROUND_MS,
} from '../src/canada-post-config.js';
import {
  assertStallionLabelRateAllowed,
  extractStallionCustomsUrl,
} from '../src/stallion-label.js';
import {
  enrichUsaShipmentCustomsFromShipHero,
  itemNeedsShipHeroCustomsDescription,
} from '../src/shiphero-product-customs.js';
import { buildStallionRateBody, stallionItemDescription } from '../src/stallion-rate.js';
import {
  buildUpsUsShipBody,
  extractUpsCommercialInvoice,
  resolveUpsUsServiceCode,
} from '../src/ups-label.js';
import { handleUsaGenerateLabel } from '../src/usa-webhook-handler.js';
import {
  isUpsQuoteService,
  UPS_QUOTE_SERVICE_CODES,
  upsPostalCode,
  upsQuoteServiceCodes,
} from '../src/ups-config.js';
import { normalizeUpsRates } from '../src/ups-rate.js';
import { combineCanadaPostQuoteResults } from '../src/canada-post-quote.js';
import {
  combineUpsQuoteResults,
  pickCanadaPostZonosDuties,
  pickZonosDutiesFromLanded,
} from '../src/ups-quote.js';

const pdfBytes = Buffer.from(`%PDF-1.4\n${'x'.repeat(120)}`);
assert.equal(isPdfBytes(pdfBytes), true);
const pdfB64 = pdfBytes.toString('base64');

const invoice = extractUpsCommercialInvoice({
  ShipmentResponse: {
    ShipmentResults: {
      PackageResults: {
        TrackingNumber: '1ZTEST',
        ShippingLabel: { GraphicImage: 'not-the-invoice', ImageFormat: { Code: 'PDF' } },
        Form: {
          Code: '99',
          Description: 'Other',
          Image: { GraphicImage: 'short', ImageFormat: { Code: 'PDF' } },
        },
      },
      Form: [
        {
          Code: '04',
          Description: 'NAFTA',
          Image: { GraphicImage: pdfB64, ImageFormat: { Code: 'PDF' } },
        },
        {
          Code: '01',
          Description: 'Invoice',
          Image: { GraphicImage: pdfB64, ImageFormat: { Code: 'PDF' } },
        },
      ],
    },
  },
});
assert.equal(invoice?.code, '01');
assert.equal(decodeDocumentBase64(invoice.graphic)?.ext, 'pdf');

const invoiceCamel = extractUpsCommercialInvoice({
  ShipmentResponse: {
    ShipmentResults: {
      form: {
        code: '01',
        description: 'All Requested International Forms',
        image: [{ graphicImage: pdfB64, imageFormat: { code: 'PDF' } }],
      },
    },
  },
});
assert.ok(invoiceCamel?.graphic);

assert.equal(
  extractUpsCommercialInvoice({
    ShipmentResponse: {
      ShipmentResults: {
        Form: { Code: '01', Description: 'All Requested International Forms', FormGroupId: 'abc' },
      },
    },
  }),
  null,
);

assert.equal(
  extractUpsCommercialInvoice({
    ShipmentResponse: { ShipmentResults: { PackageResults: { ShippingLabel: { GraphicImage: pdfB64 } } } },
  }),
  null,
);

const gifB64 = Buffer.from('GIF89a' + 'y'.repeat(120)).toString('base64');
assert.equal(decodeDocumentBase64(gifB64), null);

assert.equal(upsPostalCode('30361-3503', 'US'), '303613503');
assert.equal(upsPostalCode('10118', 'US'), '10118');
assert.equal(upsPostalCode('L1S 2E3', 'CA'), 'L1S2E3');
process.env.UPS_ACCOUNT_NUMBER ||= 'TESTACCT';
const upsZip4Body = buildUpsUsShipBody(
  {
    orderNumber: '22309996',
    from: {
      name: 'WH',
      address1: '410 Finley Ave',
      city: 'Ajax',
      state: 'ON',
      postalCode: 'L1S 2E3',
      country: 'CA',
      phone: '9055550100',
    },
    to: {
      name: 'Jane',
      address1: '1201 W Peachtree St NW',
      city: 'Atlanta',
      state: 'GA',
      postalCode: '30361-3503',
      country: 'US',
      phone: '2125550100',
    },
    packages: [{ weightLbs: 2, lengthIn: 10, widthIn: 8, heightIn: 4 }],
    items: [
      {
        sku: 'X',
        quantity: 1,
        value: 10,
        hs_code: '8425.49.00.00',
        country_of_origin: 'CA',
        currency: 'USD',
      },
    ],
    currency: 'USD',
  },
  { serviceCode: '08' },
);
assert.equal(upsZip4Body.ShipmentRequest.Shipment.SoldTo.Address.PostalCode, '303613503');
assert.equal(upsZip4Body.ShipmentRequest.Shipment.ShipTo.Address.PostalCode, '303613503');
assert.equal(
  upsZip4Body.ShipmentRequest.Shipment.ShipmentServiceOptions.InternationalForms.Contacts.SoldTo
    .Address.PostalCode,
  '303613503',
);

const cp = extractCanadaPostInvoiceLink({
  links: [
    { rel: 'label', href: 'https://cp.example/label' },
    { rel: 'receipt', href: 'https://cp.example/receipt' },
    { rel: 'commercialInvoice', href: 'https://cp.example/ci', mediaType: 'application/pdf' },
  ],
});
assert.equal(cp.href, 'https://cp.example/ci');
assert.equal(extractCanadaPostInvoiceLink({ links: [{ rel: 'label', href: 'https://x/l' }] }).href, '');

assert.equal(
  extractStallionCustomsUrl({
    label_url: 'https://st.example/label.pdf',
    commercial_invoice_url: 'https://st.example/ci.pdf',
  }),
  'https://st.example/ci.pdf',
);
assert.equal(
  extractStallionCustomsUrl({
    label_url: 'https://st.example/label.pdf',
    documents: [{ type: 'commercial_invoice', url: 'https://st.example/docs/ci.pdf' }],
  }),
  'https://st.example/docs/ci.pdf',
);
assert.equal(extractStallionCustomsUrl({ label_url: 'https://st.example/label.pdf' }), '');

const usPayload = {
  to_address: {
    name: 'Jane',
    address_1: '350 5th Ave',
    city: 'New York',
    state: 'NY',
    zip: '10118',
    country: 'US',
  },
  from_address: {
    name: 'WH',
    address_1: '410 Finley Ave',
    city: 'Ajax',
    state: 'ON',
    zip: 'L1S2E3',
    country: 'CA',
  },
  packages: [{ weight_in_oz: 16, length: 10, width: 8, height: 4, line_items: [] }],
};

assert.equal(parseGenerateLabelPayload(usPayload).to.country, 'US');
assert.equal(parseGenerateLabelPayload(usPayload).shopName, undefined);
assert.equal(
  parseGenerateLabelPayload({ ...usPayload, shop_name: 'Acme Shopify' }).shopName,
  'Acme Shopify',
);
assert.throws(
  () => parseGenerateLabelPayload({ ...usPayload, to_address: { ...usPayload.to_address, country: 'CA' } }),
  /only handles US destinations/,
);
await assert.rejects(
  () => handleUsaGenerateLabel({ to_address: { country: 'CA', zip: 'M5J2H1' } }),
  /only handles US destinations/,
);
await assert.rejects(
  () => handleUsaGenerateLabel({ to_address: { zip: '10118' } }),
  /only handles US destinations/,
);

assert.deepEqual(UPS_QUOTE_SERVICE_CODES, ['08', '12']);
assert.equal(isUpsQuoteService('08'), true);
assert.equal(isUpsQuoteService('12'), true);
assert.equal(isUpsQuoteService('03'), false);
const upsHeavy = { packages: [{ weightOz: 320 }] };
const upsAt19 = { packages: [{ weightLbs: 19 }] };
const upsLightBox = {
  packages: [{ weightLbs: 10, lengthIn: 12, widthIn: 12, heightIn: 12 }],
};
const upsDimHeavy = {
  packages: [{ weightLbs: 8, lengthIn: 20, widthIn: 20, heightIn: 12 }],
};
const upsSplitHeavy = { packages: [{ weightLbs: 12 }, { weight_in_oz: 128 }] };
assert.deepEqual(upsQuoteServiceCodes(upsHeavy), ['08', '12', '11']);
assert.deepEqual(upsQuoteServiceCodes(upsAt19), ['08', '12', '11']);
assert.deepEqual(upsQuoteServiceCodes({ packages: [{ weightLbs: 19.1 }] }), ['08', '12', '11']);
assert.deepEqual(upsQuoteServiceCodes(upsLightBox), ['08', '12', '11']);
assert.deepEqual(upsQuoteServiceCodes(upsDimHeavy), ['08', '12', '11']);
assert.deepEqual(upsQuoteServiceCodes(upsSplitHeavy), ['08', '12', '11']);
assert.deepEqual(upsQuoteServiceCodes({ packages: [{}] }), ['08', '12', '11']);
assert.equal(isUpsQuoteService('11', upsHeavy), true);
assert.equal(isUpsQuoteService('11', upsAt19), true);
assert.equal(isUpsQuoteService('11', upsDimHeavy), true);
assert.equal(isUpsQuoteService('11', upsLightBox), true);
assert.equal(isUpsQuoteService('03', upsHeavy), false);
const upsRatedFixture = {
  RateResponse: {
    RatedShipment: ['08', '11', '12', '65'].map((code, i) => ({
      Service: { Code: code },
      NegotiatedRateCharges: {
        TotalCharge: { MonetaryValue: String(20 + i), CurrencyCode: 'CAD' },
      },
    })),
  },
};
assert.deepEqual(
  normalizeUpsRates(upsRatedFixture, upsHeavy).map((r) => r.serviceCode),
  ['08', '11', '12'],
);
assert.deepEqual(
  normalizeUpsRates(upsRatedFixture, upsAt19).map((r) => r.serviceCode),
  ['08', '11', '12'],
);
assert.deepEqual(
  normalizeUpsRates(upsRatedFixture, upsLightBox).map((r) => r.serviceCode),
  ['08', '11', '12'],
);
assert.deepEqual(
  normalizeUpsRates(upsRatedFixture, upsDimHeavy).map((r) => r.serviceCode),
  ['08', '11', '12'],
);
assert.equal(resolveUpsUsServiceCode('11', upsHeavy), '11');
assert.equal(resolveUpsUsServiceCode('11', upsAt19), '11');
assert.equal(resolveUpsUsServiceCode('11', upsLightBox), '11');
assert.throws(() => resolveUpsUsServiceCode('03', upsHeavy), /Allowed: 08, 12, 11/);
assert.ok(WEBHOOK_DEADLINE_MS <= USA_MAX_DEADLINE_MS);
assert.equal(USA_MAX_DEADLINE_MS, 18000);

const comparisonMissingStallion = {
  stallion: { status: 'error', rates: [], message: 'timeout' },
  ups: { status: 'ok', rates: [{ landedTotal: 42.1 }] },
  canadaPost: { status: 'ok', rates: [{ landedTotal: 55 }] },
};
// Stallion is optional — empty/failed quote must not abort print.
assert.deepEqual(usaCarriersMissingLandedRates(comparisonMissingStallion), []);
const prevStallionEnabled = process.env.STALLION_ENABLED;
process.env.STALLION_ENABLED = 'true';
assert.deepEqual(usaCarriersMissingLandedRates(comparisonMissingStallion), []);

assert.equal(
  usaCarriersMissingLandedRates({
    stallion: { status: 'ok', rates: [{ landedTotal: 10 }] },
    ups: { status: 'ok', rates: [{ landedTotal: 12 }] },
    canadaPost: { status: 'ok', rates: [{ landedTotal: 14 }] },
  }).length,
  0,
);
if (prevStallionEnabled == null) delete process.env.STALLION_ENABLED;
else process.env.STALLION_ENABLED = prevStallionEnabled;

const comparisonMissingUps = {
  stallion: { status: 'skipped', rates: [] },
  ups: { status: 'error', rates: [], error: 'timeout' },
  canadaPost: { status: 'ok', rates: [{ landedTotal: 55 }] },
};
assert.deepEqual(usaCarriersMissingLandedRates(comparisonMissingUps), ['UPS']);
assert.match(
  usaIncompleteShopError(comparisonMissingUps, [
    {
      carrier: 'Canada Post',
      service: 'Expedited',
      serviceCode: 'USA.EP',
      landedTotal: 55,
      printCost: 30,
      trackable: true,
    },
  ]),
  /UPS \(timeout\) did not return a rate/,
);

const comparisonUpsShippingOnly = {
  compareMode: 'landed',
  stallion: { status: 'ok', rates: [{ landedTotal: 13.87 }] },
  ups: combineUpsQuoteResults(
    {
      status: 'ok',
      rates: [{ serviceCode: '08', shipping: 53.53, currency: 'CAD' }],
    },
    {
      status: 'unavailable',
      error: 'you are not allowed to make non postal landedCost',
    },
  ),
  canadaPost: { status: 'ok', rates: [{ landedTotal: 89.68 }] },
};
assert.equal(comparisonUpsShippingOnly.ups.status, 'shipping_only');
assert.equal(comparisonUpsShippingOnly.ups.rates[0].landedTotal, null);
assert.equal(hasUpsLandedRate(comparisonUpsShippingOnly), false);
assert.deepEqual(usaCarriersMissingLandedRates(comparisonUpsShippingOnly), ['UPS']);
assert.deepEqual(
  usaCarriersMissingLandedRates(comparisonUpsShippingOnly, { ignoreCanadaPost: true }),
  ['UPS'],
);
assert.match(
  usaIncompleteShopError(comparisonUpsShippingOnly, [
    {
      carrier: 'Canada Post',
      service: 'Expedited Parcel USA',
      serviceCode: 'USA.EP',
      landedTotal: 89.68,
      printCost: 81.12,
      trackable: true,
    },
  ]),
  /UPS \(you are not allowed to make non postal landedCost\) did not return a rate/,
);

const stallionWouldWin = {
  carrier: 'Stallion',
  service: 'USPS Ground Advantage',
  serviceCode: 'usps_ground_advantage',
  lastMileCarrier: 'USPS',
  landedTotal: 60.52,
  printCost: 60.52,
  trackable: true,
};
const comparisonCpNoService = {
  stallion: { status: 'ok', rates: [{ landedTotal: 60.52 }] },
  ups: { status: 'ok', rates: [{ landedTotal: 80 }] },
  canadaPost: {
    status: 'no_rate',
    rates: [],
    ratingError: 'No rates for USA.EP, USA.XP, USA.TP',
  },
};
assert.equal(isCanadaPostNoService(comparisonCpNoService), true);
assert.deepEqual(usaCarriersMissingLandedRates(comparisonCpNoService), []);

const comparisonCpNoServiceMsg = {
  stallion: { status: 'ok', rates: [{ landedTotal: 60.52 }] },
  ups: { status: 'ok', rates: [{ landedTotal: 80 }] },
  canadaPost: {
    status: 'error',
    rates: [],
    ratingError: 'No service for this destination',
  },
};
assert.equal(isCanadaPostNoService(comparisonCpNoServiceMsg), true);
assert.deepEqual(usaCarriersMissingLandedRates(comparisonCpNoServiceMsg), []);

const comparisonCpAborted = {
  stallion: { status: 'ok', rates: [{ landedTotal: 60.52 }] },
  ups: { status: 'ok', rates: [{ landedTotal: 80 }] },
  canadaPost: {
    status: 'error',
    rates: [],
    ratingError: 'This operation was aborted',
  },
};
assert.equal(isCanadaPostNoService(comparisonCpAborted), false);
assert.equal(isCanadaPostQuoteTimeout(comparisonCpAborted), true);
assert.deepEqual(usaCarriersMissingLandedRates(comparisonCpAborted), ['Canada Post']);
assert.deepEqual(
  usaCarriersMissingLandedRates(comparisonCpAborted, { ignoreCanadaPost: true }),
  [],
);
assert.equal(usaCanadaPostTimeoutShopError(0, stallionWouldWin), CANADA_POST_QUOTE_TIMEOUT_MSG);
assert.equal(usaCanadaPostTimeoutShopError(1, stallionWouldWin), CANADA_POST_QUOTE_TIMEOUT_MSG);
const timeoutPostageRanked = [
  {
    carrier: 'UPS',
    service: 'Worldwide Expedited',
    serviceCode: '08',
    shipping: 53.53,
    landedTotal: 53.53,
  },
  {
    carrier: 'Stallion',
    service: 'USPS Ground Advantage',
    serviceCode: 'usps.ground_advantage',
    shipping: 22,
    landedTotal: 22,
  },
  {
    carrier: 'Canada Post',
    service: 'Expedited Parcel USA',
    shipping: 10,
    landedTotal: 10,
  },
];
assert.equal(
  usaCanadaPostTimeoutShopError(0, stallionWouldWin, timeoutPostageRanked),
  CANADA_POST_QUOTE_TIMEOUT_MSG,
);
const postageAudit = postageCompareFromRanked(timeoutPostageRanked);
assert.equal(postageAudit.ups.shipping, 53.53);
assert.equal(postageAudit.stallion.shipping, 22);
assert.equal(postageAudit.ups.carrier, 'UPS');
assert.equal(
  usaIncompleteShopError(comparisonCpAborted, [stallionWouldWin]),
  CANADA_POST_QUOTE_TIMEOUT_MSG,
);
const comparisonCpGenericError = {
  stallion: { status: 'no_rate', rates: [] },
  ups: { status: 'ok', rates: [{ landedTotal: 63.31, printCost: 63.31 }] },
  canadaPost: {
    status: 'error',
    rates: [],
    ratingError: 'Errors occurred while processing the request.',
  },
};
assert.equal(isCanadaPostNoService(comparisonCpGenericError), false);
assert.equal(isCanadaPostQuoteTimeout(comparisonCpGenericError), false);
assert.deepEqual(usaCarriersMissingLandedRates(comparisonCpGenericError), ['Canada Post']);
assert.match(
  usaIncompleteShopError(comparisonCpGenericError, [
    {
      carrier: 'UPS',
      service: 'UPS 3 Day Select',
      serviceCode: '12',
      landedTotal: 63.31,
      printCost: 63.31,
      trackable: true,
    },
  ]),
  /Canada Post \(Errors occurred while processing the request\.\) did not return a rate/,
);
assert.notEqual(
  usaIncompleteShopError(comparisonCpGenericError, [
    {
      carrier: 'UPS',
      service: 'UPS 3 Day Select',
      serviceCode: '12',
      landedTotal: 63.31,
      printCost: 63.31,
      trackable: true,
    },
  ]),
  CANADA_POST_QUOTE_TIMEOUT_MSG,
);

const comparisonCpNoServiceUpsMissing = {
  stallion: { status: 'ok', rates: [{ landedTotal: 60.52 }] },
  ups: { status: 'error', rates: [], error: 'timeout' },
  canadaPost: {
    status: 'no_rate',
    rates: [],
    ratingError: 'No rates for USA.EP, USA.XP, USA.TP',
  },
};
assert.deepEqual(usaCarriersMissingLandedRates(comparisonCpNoServiceUpsMissing), ['UPS']);

assert.equal(canadaPostNonDeliveryOption('USA.EP'), 'RASE');
assert.equal(canadaPostNonDeliveryOption('USA.XP'), 'RASE');
assert.equal(canadaPostNonDeliveryOption('USA.TP'), 'RTS');
assert.equal(canadaPostNonDeliveryOption('USA.TP.LVM'), 'RTS');

process.env.CANADA_POST_CUSTOMER_NUMBER ||= '0007273151';
process.env.CANADA_POST_CONTRACT_ID ||= '0041597065';
process.env.CANADA_POST_PICKUP_POSTAL ||= 'L1S2E3';
const cpBody = buildCanadaPostUsCreateShipmentBody(
  {
    orderNumber: 'TEST-NDI',
    from: {
      name: 'WH',
      address1: '410 Finley Ave',
      city: 'Ajax',
      state: 'ON',
      postalCode: 'L1S2E3',
      phone: '9055550100',
    },
    to: {
      name: 'Jane',
      address1: '350 5th Ave',
      city: 'New York',
      state: 'NY',
      postalCode: '10118',
      phone: '2125550100',
    },
    packages: [{ weightLbs: 2, lengthIn: 10, widthIn: 8, heightIn: 4 }],
    items: [{ sku: 'X', quantity: 1, value: 10, hs_code: '8425.49.00.00', country_of_origin: 'CA' }],
    currency: 'USD',
  },
  { serviceCode: 'USA.TP', conversionFromCad: 0.71 },
);
assert.deepEqual(cpBody.deliverySpec.options, [{ optionCode: 'RTS' }]);
assert.match(String(cpBody.groupId), /^RS-\d{8}$/);
const cpEpBody = buildCanadaPostUsCreateShipmentBody(
  {
    orderNumber: 'TEST-NDI-EP',
    from: {
      name: 'WH',
      address1: '410 Finley Ave',
      city: 'Ajax',
      state: 'ON',
      postalCode: 'L1S2E3',
      phone: '9055550100',
    },
    to: {
      name: 'Jane',
      address1: '350 5th Ave',
      city: 'New York',
      state: 'NY',
      postalCode: '10118',
      phone: '2125550100',
    },
    packages: [{ weightLbs: 2, lengthIn: 10, widthIn: 8, heightIn: 4 }],
    items: [{ sku: 'X', quantity: 1, value: 10, hs_code: '8425.49.00.00', country_of_origin: 'CA' }],
    currency: 'USD',
  },
  { serviceCode: 'USA.EP', conversionFromCad: 0.71 },
);
assert.deepEqual(cpEpBody.deliverySpec.options, [{ optionCode: 'RASE' }]);
assertCanadaPostUsCreateBody(cpBody);
assertCanadaPostUsCreateBody(cpEpBody);
assert.equal(Array.isArray(cpBody.deliverySpec.options), true);
assert.equal(Array.isArray(cpBody.deliverySpec.customs.skuList), true);
assert.equal(Object.prototype.toString.call(cpBody.deliverySpec.options), '[object Array]');
assert.equal('option' in cpBody.deliverySpec.options, false);
assert.equal(cpBody.deliverySpec.destination.addressDetails.countryCode, 'US');
assert.equal(cpBody.deliverySpec.sender.addressDetails.countryCode, 'CA');
assert.equal(cpBody.deliverySpec.customs.reasonForExport, 'SOG');
assert.equal(cpBody.deliverySpec.preferences.showPackingInstructions, false);
assert.equal('addressLine2' in cpBody.deliverySpec.destination.addressDetails, false);
assert.equal('transmitShipment' in cpBody, false);
const wire = JSON.parse(JSON.stringify(cpBody));
assert.equal(Array.isArray(wire.deliverySpec.options), true);
assert.equal(wire.deliverySpec.options[0].optionCode, 'RTS');

const zonosFromCp = pickCanadaPostZonosDuties({
  rates: [
    {
      serviceCode: 'USA.TP',
      duty_source: 'api',
      duty: 20,
      taxes: 5,
      importCharges: 28,
      landedCurrency: 'CAD',
    },
  ],
});
assert.equal(zonosFromCp.duties, 20);
assert.equal(zonosFromCp.importCharges, undefined);
const upsCombined = combineUpsQuoteResults(
  { status: 'ok', rates: [{ serviceCode: '08', shipping: 40, currency: 'CAD' }] },
  zonosFromCp,
);
assert.equal(upsCombined.rates[0].duty, 20);
assert.equal(upsCombined.rates[0].brokerage, 4.8);
assert.equal(upsCombined.rates[0].landedTotal, 64.8);

const zonosDirect = pickZonosDutiesFromLanded({
  status: 'ok',
  currency: 'CAD',
  duties: 15.5,
  dutyItems: [{ amount: 15.5, note: 'MFN' }],
});
assert.equal(zonosDirect.duties, 15.5);
const upsWithoutCp = combineUpsQuoteResults(
  { status: 'ok', rates: [{ serviceCode: '08', shipping: 40, currency: 'CAD' }] },
  zonosDirect,
);
assert.equal(upsWithoutCp.status, 'ok');
assert.equal(upsWithoutCp.rates[0].landedTotal, 60.3);

const cpWithZonos = combineCanadaPostQuoteResults(
  {
    status: 'ok',
    rates: [
      { serviceCode: 'USA.EP', shipping: 25, currency: 'CAD' },
      { serviceCode: 'USA.TP', shipping: 15, currency: 'CAD' },
    ],
  },
  [
    {
      status: 'ok',
      currency: 'CAD',
      duties: 15.5,
      taxes: 0,
      clearanceFees: 2,
      importCharges: 17.5,
      dutyItems: [{ amount: 15.5, note: 'MFN' }],
    },
    {
      status: 'ok',
      currency: 'CAD',
      duties: 15.5,
      taxes: 0,
      clearanceFees: 2,
      importCharges: 17.5,
    },
  ],
);
assert.equal(cpWithZonos.status, 'ok');
assert.equal(cpWithZonos.rates[0].duty, 15.5);
assert.equal(cpWithZonos.rates[0].landedTotal, 42.5);
assert.equal(cpWithZonos.rates[1].landedTotal, 32.5);
assert.equal(cpWithZonos.rates[0].duty_source, 'api');
assert.equal(pickCanadaPostZonosDuties(cpWithZonos).duties, 15.5);

const cpZonosTimeout = combineCanadaPostQuoteResults(
  { status: 'ok', rates: [{ serviceCode: 'USA.EP', shipping: 25, currency: 'CAD' }] },
  [{ status: 'unavailable', error: 'The operation was aborted due to timeout' }],
);
assert.equal(cpZonosTimeout.status, 'shipping_only');
assert.equal(cpZonosTimeout.rates[0].landedTotal, null);
assert.equal(isCanadaPostQuoteTimeout({ canadaPost: cpZonosTimeout }), false);
assert.equal(
  shouldComparePostage({
    ups: { rates: [{ shipping: 40, currency: 'CAD' }] },
    canadaPost: cpZonosTimeout,
  }),
  true,
);
assert.deepEqual(
  usaCarriersMissingLandedRates({
    compareMode: 'postage',
    stallion: { status: 'ok', rates: [{ base_rate: 22, landedTotal: 60, total: 60 }] },
    ups: { status: 'shipping_only', rates: [{ shipping: 40, currency: 'CAD' }] },
    canadaPost: cpZonosTimeout,
  }),
  [],
);
const prevStallionPostage = process.env.STALLION_ENABLED;
process.env.STALLION_ENABLED = 'true';
const postageRanked = rankCadLanded(
  {
    stallion: {
      rates: [
        {
          service_name: 'USPS Ground Advantage',
          service: 'usps.ground_advantage',
          carrier: 'USPS',
          trackable: true,
          base_rate: 22,
          duty: 38,
          total: 60,
          landedTotal: 60,
        },
      ],
    },
    ups: { rates: [{ serviceCode: '08', serviceName: 'Expedited', shipping: 40, landedTotal: null }] },
    canadaPost: cpZonosTimeout,
  },
  { postageOnly: true },
);
assert.equal(postageRanked[0].carrier, 'Stallion');
assert.equal(postageRanked[0].landedTotal, 22);
assert.equal(postageRanked[0].fullLandedTotal, 60);
assert.equal(postageRanked[0].duty, 38);
assert.equal(postageRanked[0].duty_source, 'stallion');
assert.equal(postageRanked[0].compareMode, 'postage');
assert.equal(postageRanked[0].printCost, 60);
assert.equal(pickBuyableWinner(postageRanked).carrier, 'Stallion');
process.env.STALLION_ENABLED = 'false';
assert.equal(
  rankCadLanded(
    {
      stallion: {
        rates: [{ base_rate: 22, landedTotal: 60, total: 60, trackable: true }],
      },
      ups: { rates: [{ serviceCode: '08', serviceName: 'Expedited', shipping: 40, landedTotal: null }] },
      canadaPost: cpZonosTimeout,
    },
    { postageOnly: true },
  ).every((row) => row.carrier !== 'Stallion'),
  true,
);
if (prevStallionPostage == null) delete process.env.STALLION_ENABLED;
else process.env.STALLION_ENABLED = prevStallionPostage;
const skipCpPostageRanked = rankCadLanded(
  {
    stallion: {
      rates: [
        {
          service_name: 'USPS Ground Advantage',
          service: 'usps.ground_advantage',
          carrier: 'USPS',
          trackable: true,
          base_rate: 30,
          total: 70,
          landedTotal: 70,
        },
      ],
    },
    ups: {
      rates: [{ serviceCode: '08', serviceName: 'Worldwide Expedited', shipping: 25, landedTotal: 90 }],
    },
    canadaPost: { rates: [] },
  },
  { postageOnly: true },
);
assert.equal(skipCpPostageRanked.some((row) => row.carrier === 'Canada Post'), false);
assert.equal(pickBuyableWinner(skipCpPostageRanked).carrier, 'UPS');
assert.equal(pickBuyableWinner(skipCpPostageRanked).landedTotal, 25);

const standardPadRanked = rankCadLanded({
  stallion: { rates: [] },
  ups: {
    rates: [
      {
        serviceCode: '11',
        serviceName: 'UPS Standard',
        shipping: 20,
        landedTotal: 24.8,
      },
      {
        serviceCode: '08',
        serviceName: 'UPS Worldwide Expedited',
        shipping: 25,
        landedTotal: 29.8,
      },
      {
        serviceCode: '12',
        serviceName: 'UPS 3 Day Select',
        shipping: 28,
        landedTotal: 32.8,
      },
    ],
  },
  canadaPost: { rates: [] },
});
assert.equal(standardPadRanked[0].serviceCode, '08');
assert.equal(standardPadRanked[0].landedTotal, 29.8);
assert.equal(
  standardPadRanked.find((row) => row.serviceCode === '11')?.landedTotal,
  34.8,
);
assert.equal(
  standardPadRanked.find((row) => row.serviceCode === '11')?.printCost,
  20,
);
assert.equal(
  standardPadRanked.find((row) => row.serviceCode === '11')?.shipping,
  20,
);
assert.equal(
  standardPadRanked.find((row) => row.serviceCode === '11')?.fullLandedTotal,
  24.8,
);
const standardWinsRanked = rankCadLanded({
  stallion: { rates: [] },
  ups: {
    rates: [
      {
        serviceCode: '11',
        serviceName: 'UPS Standard',
        shipping: 18,
        landedTotal: 22.8,
      },
      {
        serviceCode: '08',
        serviceName: 'UPS Worldwide Expedited',
        shipping: 30,
        landedTotal: 34.8,
      },
    ],
  },
  canadaPost: { rates: [] },
});
assert.equal(pickBuyableWinner(standardWinsRanked).serviceCode, '11');
assert.equal(pickBuyableWinner(standardWinsRanked).landedTotal, 32.8);
assert.equal(pickBuyableWinner(standardWinsRanked).printCost, 18);
const standardPostageRanked = rankCadLanded(
  {
    stallion: { rates: [] },
    ups: {
      rates: [
        { serviceCode: '11', serviceName: 'UPS Standard', shipping: 20, landedTotal: null },
        { serviceCode: '08', serviceName: 'UPS Worldwide Expedited', shipping: 25, landedTotal: null },
      ],
    },
    canadaPost: { rates: [] },
  },
  { postageOnly: true },
);
assert.equal(standardPostageRanked[0].serviceCode, '08');
assert.equal(standardPostageRanked[0].landedTotal, 25);
assert.equal(
  standardPostageRanked.find((row) => row.serviceCode === '11')?.landedTotal,
  30,
);
assert.equal(
  standardPostageRanked.find((row) => row.serviceCode === '11')?.printCost,
  20,
);
assert.deepEqual(
  usaCarriersMissingLandedRates(
    {
      compareMode: 'postage',
      stallion: { status: 'ok', rates: [{ base_rate: 30 }] },
      ups: { status: 'shipping_only', rates: [{ shipping: 25 }] },
      canadaPost: { status: 'error', rates: [], ratingError: 'This operation was aborted' },
    },
    { ignoreCanadaPost: true, postageOnly: true },
  ),
  [],
);
assert.equal(usaCanadaPostTimeoutShopError(0, null), CANADA_POST_QUOTE_TIMEOUT_MSG);
assert.equal(
  usaCarriersMissingLandedRates({
    stallion: { status: 'ok', rates: [{ landedTotal: 10 }] },
    ups: upsWithoutCp,
    canadaPost: { status: 'error', rates: [], ratingError: 'This operation was aborted' },
  }).join(','),
  'Canada Post',
);

// Formula A: |a-b|/min(a,b) > 50% → postage-only when Stallion vs Zonos duties diverge
assert.equal(dutiesDivergeOver50(20, 150), true);
assert.equal(dutiesDivergeOver50(150, 20), true);
assert.equal(dutiesDivergeOver50(9.75, 6.58), false);
assert.equal(dutiesDivergeOver50(10, 16), true);
assert.equal(dutiesDivergeOver50(0, 0), false);
assert.equal(dutiesDivergeOver50(0, 20), true);
assert.equal(dutiesDivergeOver50(20, 0), true);
assert.equal(dutiesDivergeOver50(null, 20), false);
assert.equal(dutiesDivergeOver50(20, null), false);
assert.equal(
  pickStallionDuty({
    rates: [
      { base_rate: 22, duty: null },
      { base_rate: 25, duty: 9.75 },
    ],
  }),
  9.75,
);
assert.equal(pickStallionDuty({ rates: [{ base_rate: 22 }] }), null);

const ranked = rankCadLanded({
  stallion: {
    rates: [{ landedTotal: 90, service_name: 'USPS', service: 'usps.ga', carrier: 'USPS', trackable: true, total: 90 }],
  },
  ups: upsCombined,
  canadaPost: {
    rates: [{ serviceCode: 'USA.TP', serviceName: 'Tracked Packet', shipping: 15, duty: 20, landedTotal: 43, landedCurrency: 'CAD' }],
  },
});
assert.equal(ranked[0].carrier, 'Canada Post');
assert.equal(pickBuyableWinner(ranked).carrier, 'Canada Post');

process.env.STALLION_LABEL_CARRIERS = 'USPS,FEDEX,UPS';
assert.equal(isStallionLabelCarrierAllowed('USPS'), true);
assert.equal(isStallionLabelCarrierAllowed('FedEx'), true);
assert.equal(isStallionLabelCarrierAllowed('FedEx Ground'), true);
assert.equal(isStallionLabelCarrierAllowed('UPS'), true);
assert.equal(isStallionLabelCarrierAllowed('UPS Ground'), true);
assert.equal(isStallionLabelCarrierAllowed('Stallion'), false);
assert.equal(isStallionLabelCarrierAllowed('US Regional'), false);
assert.equal(isStallionLabelCarrierAllowed('OSM'), false);
assert.equal(isShopifyShopName('Acme Shopify'), true);
assert.equal(isShopifyShopName('SHOPIFY'), true);
assert.equal(isShopifyShopName('Amazon'), false);
assert.equal(isStallionUsRegionalLabel('US Regional'), true);
assert.equal(isStallionUsRegionalLabel('stallion.regional'), true);
assert.equal(isStallionUsRegionalLabel('USPS'), false);
assert.equal(
  isStallionLabelCarrierAllowed('US Regional', { shopName: 'Amazon' }),
  false,
);
assert.equal(
  isStallionLabelCarrierAllowed('US Regional', { shopName: 'Acme Shopify' }),
  true,
);
assert.equal(
  isStallionLabelCarrierAllowed('OSM', { shopName: 'Acme Shopify' }),
  false,
);
assert.doesNotThrow(() =>
  assertStallionLabelRateAllowed(
    {
      service: 'stallion.regional',
      service_name: 'US Regional',
      carrier: 'Stallion',
      trackable: true,
    },
    'stallion.regional',
    { shopName: 'Acme Shopify' },
  ),
);
assert.throws(
  () =>
    assertStallionLabelRateAllowed(
      {
        service: 'stallion.regional',
        service_name: 'US Regional',
        carrier: 'Stallion',
        trackable: true,
      },
      'stallion.regional',
      { shopName: 'Amazon' },
    ),
  /not on STALLION_LABEL_CARRIERS/,
);

const prevStallionForRegional = process.env.STALLION_ENABLED;
process.env.STALLION_ENABLED = 'true';
assert.equal(
  pickBuyableWinner([
    {
      carrier: 'Stallion',
      service: 'US Regional',
      serviceCode: 'stallion.regional',
      lastMileCarrier: 'Stallion',
      landedTotal: 40.46,
      printCost: 40.46,
      trackable: true,
    },
    {
      carrier: 'Stallion',
      service: 'USPS Ground Advantage',
      serviceCode: 'usps.ground_advantage',
      lastMileCarrier: 'USPS',
      landedTotal: 60.52,
      printCost: 60.52,
      trackable: true,
    },
  ])?.service,
  'USPS Ground Advantage',
);
assert.equal(
  pickBuyableWinner([
    {
      carrier: 'Stallion',
      service: 'US Regional',
      serviceCode: 'stallion.regional',
      lastMileCarrier: 'Stallion',
      landedTotal: 40.46,
      printCost: 40.46,
      trackable: true,
      shopName: 'Acme Shopify',
    },
    {
      carrier: 'Stallion',
      service: 'USPS Ground Advantage',
      serviceCode: 'usps.ground_advantage',
      lastMileCarrier: 'USPS',
      landedTotal: 60.52,
      printCost: 60.52,
      trackable: true,
      shopName: 'Acme Shopify',
    },
  ])?.service,
  'US Regional',
);
assert.equal(
  pickBuyableWinner([
    {
      carrier: 'Stallion',
      service: 'US Regional',
      serviceCode: 'stallion.regional',
      lastMileCarrier: 'Stallion',
      landedTotal: 40.46,
      printCost: 40.46,
      trackable: true,
      shopName: 'Amazon',
    },
    {
      carrier: 'Stallion',
      service: 'USPS Ground Advantage',
      serviceCode: 'usps.ground_advantage',
      lastMileCarrier: 'USPS',
      landedTotal: 60.52,
      printCost: 60.52,
      trackable: true,
      shopName: 'Amazon',
    },
  ])?.service,
  'USPS Ground Advantage',
);
if (prevStallionForRegional == null) delete process.env.STALLION_ENABLED;
else process.env.STALLION_ENABLED = prevStallionForRegional;

const timeoutErr = new Error('The operation was aborted due to timeout');
timeoutErr.name = 'TimeoutError';
assert.equal(isCanadaPostHangError(timeoutErr), true);
assert.equal(isCanadaPostHangError(new Error('HTTP 400 Validation failed')), false);
assert.equal(CANADA_POST_PRICES_ROUND_MS, 6000);
assert.equal(CANADA_POST_OAUTH_ROUND_MS, 4000);
assert.equal(CANADA_POST_CONNECT_TIMEOUT_MS, 3000);
assert.equal(CANADA_POST_PRICES_MAX_ROUNDS, 3);

assert.equal(stallionItemDescription({ sku: 'VEN11' }), 'Merchandise VEN11');
assert.equal(stallionItemDescription({ sku: 'VEN11', customs_description: 'VEN11' }), 'Merchandise VEN11');
assert.equal(stallionItemDescription({ sku: 'VEN11', description: '[1]VEN11' }), 'Merchandise VEN11');
assert.equal(
  stallionItemDescription({ sku: 'VEN11', title: 'Venturi carburetor kit' }),
  'Venturi carburetor kit',
);

const stallionBody = buildStallionRateBody({
  to: { name: 'Jane', address1: '1 Main', city: 'Atlanta', state: 'GA', postalCode: '30361', country: 'US' },
  packages: [{ weightOz: 16, lengthIn: 10, widthIn: 8, heightIn: 6 }],
  items: [{ sku: 'VEN11', quantity: 1, value: 12, hs_code: '8409914000', country_of_origin: 'CN' }],
});
assert.equal(stallionBody.items[0].description, 'Merchandise VEN11');
assert.equal(stallionBody.items[0].customs_description, 'Merchandise VEN11');
assert.ok(stallionBody.items[0].description.split(/\s+/).length >= 2);

assert.equal(itemNeedsShipHeroCustomsDescription({ sku: 'VEN11', customs_description: 'VEN11' }), true);
assert.equal(itemNeedsShipHeroCustomsDescription({ sku: 'VEN11', title: 'VEN11' }), true);
assert.equal(
  itemNeedsShipHeroCustomsDescription({ sku: 'VEN11', customs_description: 'Lift Stands' }),
  false,
);

const savedLookupToken = process.env.SHIPHERO_API_TOKEN;
process.env.SHIPHERO_API_TOKEN = 'test-token';
const filled = await enrichUsaShipmentCustomsFromShipHero(
  {
    items: [
      { sku: 'SMI6010', title: 'Iron Motorcycle Lift Stands', customs_description: 'Iron Motorcycle Lift Stands' },
      { sku: 'VEN11', title: 'VEN11', customs_description: 'VEN11' },
    ],
  },
  {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          p0: {
            data: {
              edges: [{ node: { sku: 'VEN11', name: 'VEN11', customs_description: 'Lift Stands' } }],
            },
          },
        },
      }),
    }),
  },
);
assert.equal(filled.items[0].customs_description, 'Iron Motorcycle Lift Stands');
assert.equal(filled.items[1].customs_description, 'Lift Stands');
assert.equal(filled.items[1].title, 'Lift Stands');
if (savedLookupToken == null) delete process.env.SHIPHERO_API_TOKEN;
else process.env.SHIPHERO_API_TOKEN = savedLookupToken;

console.log('usa customs-docs tests passed');
