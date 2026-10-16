/**
 * Stallion US Create Label + PDF + Void probe.
 *
 * Safety:
 * - Production requires BOTH:
 *     STALLION_ALLOW_PROD_CREATE_VOID=true
 *     STALLION_ALLOW_TEST_CREATE=true
 * - Sandbox requires STALLION_ALLOW_TEST_CREATE=true
 * - STALLION_ALLOW_CREATE must stay false in .env
 * - Always voids the created shipment when possible
 * - Stallion bills credits on purchase — void is a request, not instant
 * - Credits typically return within 14 days if the label was never scanned
 * - Never buys non-trackable services (trackable must be true)
 * - Optional carrier allowlist: STALLION_LABEL_CARRIERS (empty = any trackable)
 * - Optional service allowlist: STALLION_LABEL_SERVICES
 *
 * Token scopes: labels:create + shipments:void (rates:read is not enough)
 *
 * Usage (PowerShell):
 *   $env:STALLION_ALLOW_PROD_CREATE_VOID='true'
 *   $env:STALLION_ALLOW_TEST_CREATE='true'
 *   npm run probe:stallion-label
 *   npm run probe:stallion-label -- samples/us-shipment.json usps.ground_advantage
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildStallionLabelBody,
  createStallionUsLabel,
  resolveStallionLabelService,
  voidStallionShipment,
} from '../src/stallion-label.js';
import {
  stallionAllowCreate,
  stallionAllowProdCreateVoid,
  stallionIsProduction,
  stallionLabelCarriers,
  stallionLabelServices,
  stallionLabelsUrl,
} from '../src/stallion-config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sampleArg = process.argv[2];
const serviceArg = process.argv[3] || '';
const samplePath = resolve(root, sampleArg || 'samples/us-shipment.json');

if (stallionIsProduction() && !stallionAllowProdCreateVoid()) {
  console.error(
    'REFUSING: production create/void requires STALLION_ALLOW_PROD_CREATE_VOID=true.',
  );
  process.exit(2);
}

if (!stallionAllowCreate()) {
  console.error(
    stallionIsProduction()
      ? 'REFUSING: set STALLION_ALLOW_TEST_CREATE=true for this probe only. Leave STALLION_ALLOW_CREATE=false in .env.'
      : 'REFUSING: set STALLION_ALLOW_TEST_CREATE=true for this sandbox probe.',
  );
  process.exit(2);
}

if (String(process.env.STALLION_ALLOW_CREATE || '').toLowerCase() === 'true') {
  console.warn(
    'NOTE: STALLION_ALLOW_CREATE is true in env. Probe still voids; keep this false until the webhook is live.',
  );
}

const shipment = JSON.parse(readFileSync(samplePath, 'utf8'));
shipment.orderNumber = `PROBE-US-STALLION-${Date.now()}`;

let resolved;
try {
  resolved = await resolveStallionLabelService(shipment, serviceArg, 45000);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
}

const dryBody = buildStallionLabelBody(shipment, { service: resolved.service });

console.log('=== STALLION US LABEL PROBE (create → PDF → void) ===');
console.log(`Mode: ${stallionIsProduction() ? 'PRODUCTION' : 'SANDBOX'} (gated create+void)`);
console.log(`Sample: ${samplePath}`);
console.log(`Service: ${resolved.service} ${resolved.serviceName || ''}`.trim());
console.log(`Order: ${shipment.orderNumber}`);
console.log(
  `Ship: ${shipment.from.city}, ${shipment.from.state} → ${shipment.to.city}, ${shipment.to.state} ${shipment.to.postalCode}`,
);
console.log(`URL: ${stallionLabelsUrl()}`);
const listedCarriers = stallionLabelCarriers();
console.log(
  `Allowlist carriers: ${listedCarriers.length ? listedCarriers.join(', ') : 'any trackable'}`,
);
const serviceAllow = stallionLabelServices();
if (serviceAllow.length) console.log(`Allowlist services: ${serviceAllow.join(', ')}`);
console.log('NOTE: Stallion charges credits now. Void is a request; refund may take up to 14 days.');
console.log(`Booked service=${dryBody.service} from_address=yes`);

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
  const result = await createStallionUsLabel(shipment, {
    service: resolved.service,
    timeoutMs: 45000,
  });
  shipmentId = result.shipmentId;
  console.log('shipmentId=', result.shipmentId);
  console.log('shipCode=', result.shipCode || 'n/a');
  console.log('tracking=', result.trackingNumber);
  console.log('service=', result.serviceName);
  console.log(
    'postage=',
    result.cost == null ? 'n/a' : `${result.currency || ''} ${Number(result.cost).toFixed(2)}`.trim(),
  );
  console.log('PDF bytes=', result.pdfBytes.length);
  console.log('PDF page sizes:', pdfPageSizes(result.pdfBytes).join(', ') || 'unknown');

  const outDir = resolve(root, 'public', 'labels');
  mkdirSync(outDir, { recursive: true });
  const prefix = stallionIsProduction() ? 'probe-us-stallion' : 'probe-us-stallion-sandbox';
  pdfPath = resolve(
    outDir,
    `${prefix}-${result.trackingNumber || result.shipmentId || Date.now()}.pdf`,
  );
  writeFileSync(pdfPath, result.pdfBytes);
  console.log('Saved sample PDF:', pdfPath);
} catch (err) {
  console.error('Create/artifact failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  if (shipmentId) {
    try {
      await voidStallionShipment(shipmentId);
      voided = true;
      console.log('Void requested for shipment', shipmentId);
      console.log('Credits typically return within 14 days if the label was never scanned.');
    } catch (err) {
      console.error(
        'Void failed — void manually in Stallion to recover credits:',
        err instanceof Error ? err.message : err,
      );
      process.exitCode = 1;
    }
  }
}

console.log('Probe complete. voided=', voided, 'pdf=', pdfPath);
process.exit(voided && pdfPath ? 0 : 1);
