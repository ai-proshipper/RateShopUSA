/**
 * Canada Post US Create Shipment + Get Artifact + Void probe.
 *
 * Safety:
 * - Never calls Transmit Shipments
 * - Always voids the created shipment when possible
 * - Production requires BOTH:
 *     CANADA_POST_ALLOW_PROD_CREATE_VOID=true
 *     CANADA_POST_ALLOW_TEST_CREATE=true
 *   and CANADA_POST_TRANSMIT_ENABLED must stay false
 * - Requires ZONOS_ACCOUNT_KEY (X-CPC-Zonos-Key) for US duties (CP error 8722 without it).
 *
 * Usage (PowerShell):
 *   $env:CANADA_POST_ALLOW_PROD_CREATE_VOID='true'
 *   $env:CANADA_POST_ALLOW_TEST_CREATE='true'
 *   $env:CANADA_POST_TRANSMIT_ENABLED='false'
 *   npm run probe:canada-post-label
 *   npm run probe:canada-post-label -- samples/us-shipment-nptc.json USA.EP
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNoTransmitOnCreate,
  buildCanadaPostUsCreateShipmentBody,
  canadaPostConversionFromCad,
  createCanadaPostUsLabel,
  voidCanadaPostShipment,
} from '../src/canada-post-label.js';
import { canadaPostAuthHeaders } from '../src/canada-post-auth.js';
import {
  assertCanadaPostShippingUrl,
  canadaPostAllowCreate,
  canadaPostAllowProdCreateVoid,
  canadaPostCustomerNumber,
  canadaPostIsProduction,
  canadaPostShippingBaseUrl,
  canadaPostTransmitEnabled,
  zonosAccountKey,
} from '../src/canada-post-config.js';
import { assertSingleDeclaredCurrency } from '../src/currency.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sampleArg = process.argv[2];
const serviceArg = process.argv[3] || 'USA.EP';
const samplePath = resolve(root, sampleArg || 'samples/us-shipment-nptc.json');

if (canadaPostIsProduction() && !canadaPostAllowProdCreateVoid()) {
  console.error(
    'REFUSING: production create/void requires CANADA_POST_ALLOW_PROD_CREATE_VOID=true. Transmit stays disabled.',
  );
  process.exit(2);
}

if (!canadaPostAllowCreate()) {
  console.error(
    'REFUSING: set CANADA_POST_ALLOW_TEST_CREATE=true for this probe only. Transmit remains disabled.',
  );
  process.exit(2);
}

if (canadaPostTransmitEnabled()) {
  console.error('REFUSING: CANADA_POST_TRANSMIT_ENABLED must stay false for this probe.');
  process.exit(2);
}

if (!zonosAccountKey()) {
  console.error(
    'REFUSING: ZONOS_ACCOUNT_KEY is missing. Copy Account key from Zonos Dashboard → Settings → Integrations.',
  );
  process.exit(2);
}

const shipment = JSON.parse(readFileSync(samplePath, 'utf8'));
if (!shipment.orderNumber) {
  shipment.orderNumber = `PROBE-US-CP-${Date.now()}`;
}

const conversionFromCad = await canadaPostConversionFromCad(
  assertSingleDeclaredCurrency(shipment.items, shipment),
);
const dryBody = buildCanadaPostUsCreateShipmentBody(shipment, {
  serviceCode: serviceArg,
  conversionFromCad: conversionFromCad ?? undefined,
});
assertNoTransmitOnCreate(dryBody);

console.log('=== CANADA POST US LABEL PROBE (create → PDF → void, NO TRANSMIT) ===');
console.log(`Mode: ${canadaPostIsProduction() ? 'PRODUCTION' : 'TEST'}`);
console.log(`Sample: ${samplePath}`);
console.log(`Service: ${serviceArg}`);
console.log(`Order: ${shipment.orderNumber}`);
console.log(
  `Ship: ${shipment.from.city}, ${shipment.from.state} → ${shipment.to.city}, ${shipment.to.state} ${shipment.to.postalCode}`,
);
console.log(
  `groupId=${dryBody.groupId} conversionFromCad=${dryBody.deliverySpec?.customs?.conversionFromCad ?? 'n/a (CAD)'} Zonos header=yes`,
);

function pdfPageSizes(pdfBytes) {
  const s = pdfBytes.toString('latin1');
  const sizes = [];
  const re = /MediaBox\s*\[\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*\]/g;
  let m;
  while ((m = re.exec(s))) {
    const wIn = Math.round((Number(m[3]) / 72) * 100) / 100;
    const hIn = Math.round((Number(m[4]) / 72) * 100) / 100;
    sizes.push(`${wIn}x${hIn}in`);
  }
  return [...new Set(sizes)];
}

let voided = false;
let pdfPath = null;
/** @type {string | null} */
let shipmentId = null;

try {
  const result = await createCanadaPostUsLabel(shipment, {
    serviceCode: serviceArg,
    timeoutMs: 45000,
  });
  shipmentId = result.shipmentId;
  console.log('shipmentId=', result.shipmentId);
  console.log('trackingPin=', result.trackingPin);
  console.log('service=', result.serviceName);
  console.log('PDF bytes=', result.pdfBytes.length);
  console.log('PDF page sizes:', pdfPageSizes(result.pdfBytes).join(', ') || 'unknown');

  const outDir = resolve(root, 'public', 'labels');
  mkdirSync(outDir, { recursive: true });
  const prefix = canadaPostIsProduction() ? 'probe-us-cp-prod' : 'probe-us-cp';
  pdfPath = resolve(
    outDir,
    `${prefix}-${result.trackingPin || result.shipmentId || Date.now()}.pdf`,
  );
  writeFileSync(pdfPath, result.pdfBytes);
  console.log('Saved sample PDF:', pdfPath);

  const raw = result.createResponse || {};
  const jsonPath = resolve(
    outDir,
    `${prefix}-${result.trackingPin || result.shipmentId}-create.json`,
  );
  writeFileSync(jsonPath, JSON.stringify(raw, null, 2));
  console.log('Saved create JSON:', jsonPath);
  console.log('Create response keys:', Object.keys(raw).join(', ') || '(none)');
  console.log(
    'Duty-ish fields:',
    JSON.stringify(
      {
        usDeclarationId: raw.usDeclarationId || raw.us_declaration_id || raw.declarationId,
        dutiesAndTaxesPrepaid:
          raw.dutiesAndTaxesPrepaid || raw.duties_and_taxes_prepaid,
        shipmentPrice: raw.shipmentPrice || raw.shipment_price || null,
        billedAmount: raw.billedAmount || raw.dueAmount || null,
      },
      null,
      2,
    ),
  );
  const links = Array.isArray(raw.links) ? raw.links : [];
  for (const link of links) {
    console.log(`link rel=${link.rel} media=${link.mediaType || ''} href=${link.href || ''}`);
  }

  const headers = await canadaPostAuthHeaders(45000);
  const customer = canadaPostCustomerNumber();
  const detailsUrl = `${canadaPostShippingBaseUrl()}/${customer}/${customer}/shipments/${encodeURIComponent(result.shipmentId)}`;
  assertCanadaPostShippingUrl(detailsUrl);
  const detailsRes = await fetch(detailsUrl, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(45000),
  });
  const detailsText = await detailsRes.text();
  const detailsPath = resolve(
    outDir,
    `${prefix}-${result.trackingPin || result.shipmentId}-details.json`,
  );
  writeFileSync(detailsPath, detailsText);
  console.log(`Get shipment HTTP ${detailsRes.status} saved:`, detailsPath);

  for (const link of links) {
    const rel = String(link.rel || '').toLowerCase();
    if (!['price', 'details', 'receipt', 'commercialinvoice'].includes(rel)) continue;
    if (!link.href) continue;
    try {
      const extra = await fetch(String(link.href), {
        method: 'GET',
        headers: {
          ...headers,
          Accept: link.mediaType || headers.Accept,
        },
        signal: AbortSignal.timeout(45000),
      });
      const extraText = await extra.text();
      const extraPath = resolve(
        outDir,
        `${prefix}-${result.trackingPin || result.shipmentId}-${rel}.json`,
      );
      writeFileSync(extraPath, extraText);
      console.log(`GET ${rel} HTTP ${extra.status} saved:`, extraPath);
    } catch (linkErr) {
      console.warn(`GET ${rel} failed:`, linkErr instanceof Error ? linkErr.message : linkErr);
    }
  }
} catch (err) {
  console.error('Create/artifact failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  if (shipmentId) {
    try {
      await voidCanadaPostShipment(shipmentId);
      voided = true;
      console.log('Voided shipment', shipmentId);
    } catch (err) {
      console.error(
        'Void failed — clean up manually in Canada Post portal if needed:',
        err instanceof Error ? err.message : err,
      );
      process.exitCode = 1;
    }
  }
}

console.log('Probe complete. transmitCalled=false voided=', voided, 'pdf=', pdfPath);
process.exit(voided && pdfPath ? 0 : 1);
