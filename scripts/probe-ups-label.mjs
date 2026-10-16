/**
 * UPS US Create Shipment + PDF + Void probe.
 *
 * Safety:
 * - Requires BOTH:
 *     UPS_ALLOW_PROD_CREATE_VOID=true
 *     UPS_ALLOW_TEST_CREATE=true
 * - UPS_ALLOW_CREATE must stay false in .env
 * - Always voids the created shipment when possible
 * - UPS bills postage on create — a failed void is real postage
 * - Only services 08 (Worldwide Expedited) and 12 (3 Day Select)
 *
 * Usage (PowerShell):
 *   $env:UPS_ALLOW_PROD_CREATE_VOID='true'
 *   $env:UPS_ALLOW_TEST_CREATE='true'
 *   npm run probe:ups-label
 *   npm run probe:ups-label -- samples/us-shipment.json 08
 *   npm run probe:ups-label -- samples/us-shipment.json 12
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildUpsUsShipBody,
  createUpsUsLabel,
  resolveUpsUsServiceCode,
  voidUpsShipment,
} from '../src/ups-label.js';
import {
  upsAllowCreate,
  upsAllowProdCreateVoid,
  upsShippingUrl,
} from '../src/ups-config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sampleArg = process.argv[2];
const serviceArg = process.argv[3] || '08';
const samplePath = resolve(root, sampleArg || 'samples/us-shipment.json');

if (!upsAllowProdCreateVoid()) {
  console.error(
    'REFUSING: production create/void requires UPS_ALLOW_PROD_CREATE_VOID=true.',
  );
  process.exit(2);
}

if (!upsAllowCreate()) {
  console.error(
    'REFUSING: set UPS_ALLOW_TEST_CREATE=true for this probe only. Leave UPS_ALLOW_CREATE=false in .env.',
  );
  process.exit(2);
}

if (String(process.env.UPS_ALLOW_CREATE || '').toLowerCase() === 'true') {
  console.warn(
    'NOTE: UPS_ALLOW_CREATE is true in env. Probe still voids; keep this false until the webhook is live.',
  );
}

let serviceCode;
try {
  serviceCode = resolveUpsUsServiceCode(serviceArg);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
}

const shipment = JSON.parse(readFileSync(samplePath, 'utf8'));
shipment.orderNumber = `PROBE-US-UPS-${serviceCode}-${Date.now()}`;

const dryBody = buildUpsUsShipBody(shipment, { serviceCode });
const shipService = dryBody.ShipmentRequest.Shipment.Service.Code;

console.log('=== UPS US LABEL PROBE (create → PDF → void) ===');
console.log('Mode: PRODUCTION (gated create+void)');
console.log(`Sample: ${samplePath}`);
console.log(`Service: ${serviceCode} ${dryBody.ShipmentRequest.Shipment.Service.Description}`);
console.log(`Order: ${shipment.orderNumber}`);
console.log(
  `Ship: ${shipment.from.city}, ${shipment.from.state} → ${shipment.to.city}, ${shipment.to.state} ${shipment.to.postalCode}`,
);
console.log(`URL: ${upsShippingUrl()}`);
console.log(`Booked service=${shipService} DDP Type02=yes`);

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
  const result = await createUpsUsLabel(shipment, {
    serviceCode,
    timeoutMs: 45000,
  });
  shipmentId = result.shipmentId;
  console.log('shipmentId=', result.shipmentId);
  console.log('tracking=', result.trackingNumber);
  console.log('service=', result.serviceName);
  console.log('postage=', result.cost == null ? 'n/a' : `$${Number(result.cost).toFixed(2)}`);
  console.log('PDF bytes=', result.pdfBytes.length);
  console.log('PDF page sizes:', pdfPageSizes(result.pdfBytes).join(', ') || 'unknown');

  const outDir = resolve(root, 'public', 'labels');
  mkdirSync(outDir, { recursive: true });
  pdfPath = resolve(
    outDir,
    `probe-us-ups-${serviceCode}-${result.trackingNumber || result.shipmentId || Date.now()}.pdf`,
  );
  writeFileSync(pdfPath, result.pdfBytes);
  console.log('Saved sample PDF:', pdfPath);
} catch (err) {
  console.error('Create/artifact failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  if (shipmentId) {
    try {
      await voidUpsShipment(shipmentId);
      voided = true;
      console.log('Voided shipment', shipmentId);
    } catch (err) {
      console.error(
        'Void failed — void manually in UPS to avoid postage:',
        err instanceof Error ? err.message : err,
      );
      process.exitCode = 1;
    }
  }
}

console.log('Probe complete. voided=', voided, 'pdf=', pdfPath);
process.exit(voided && pdfPath ? 0 : 1);
