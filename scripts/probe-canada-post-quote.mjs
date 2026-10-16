/**
 * Canada Post + Zonos production rates probe.
 * RATE-ONLY — CP /prices + Zonos GraphQL landed cost. Never creates labels/shipments.
 *
 * Usage:
 *   npm run probe:canada-post-quote
 *   npm run probe:canada-post-quote -- samples/us-shipment-nptc.json
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quoteCanadaPostUs } from '../src/canada-post-quote.js';
import {
  assertCanadaPostQuoteCredentials,
  CANADA_POST_QUOTE_TIMEOUT_MS,
} from '../src/canada-post-config.js';
import { assertZonosCredentials } from '../src/zonos-landed-cost.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sampleArg = process.argv[2];
const samplePath = resolve(
  root,
  sampleArg || 'samples/us-shipment-nptc.json',
);
const shipment = JSON.parse(readFileSync(samplePath, 'utf8'));

console.log('=== CANADA POST + ZONOS RATE-ONLY PROBE (NO LABELS / NO SHIPMENTS) ===');
console.log(`Sample: ${samplePath}`);
console.log('Flow: Canada Post /prices → Zonos landed cost per service');
console.log(
  `Ship: ${shipment.from.city}, ${shipment.from.state} → ` +
    `${shipment.to.city}, ${shipment.to.state} ${shipment.to.postalCode}`,
);
const item = shipment.items?.[0];
if (item) {
  console.log(
    `Item: ${item.sku} customs=${item.value} ${item.currency || shipment.currency} ` +
      `(US quotes declare numeric value as USD) HS=${item.hs_code} origin=${item.country_of_origin}`,
  );
}

try {
  assertCanadaPostQuoteCredentials();
  assertZonosCredentials();
} catch (error) {
  console.error(`\nREFUSING: ${error.message}`);
  process.exitCode = 2;
}

if (process.exitCode !== 2) {
  const result = await quoteCanadaPostUs(shipment, CANADA_POST_QUOTE_TIMEOUT_MS);

  if (result.rates.length) {
    console.log(
      '\nService                              Shipping     Duty  Clearance  Guarantee   Remit    Landed  Currency',
    );
    console.log('-'.repeat(112));
    for (const rate of result.rates) {
      const service = String(rate.serviceName || rate.serviceCode)
        .padEnd(34)
        .slice(0, 34);
      const shipping = `$${Number(rate.shipping).toFixed(2)}`.padStart(9);
      const duty =
        rate.duty == null ? '—'.padStart(8) : `$${Number(rate.duty).toFixed(2)}`.padStart(8);
      const clearance =
        rate.clearanceFees == null
          ? '—'.padStart(9)
          : `$${Number(rate.clearanceFees).toFixed(2)}`.padStart(9);
      const guarantee =
        rate.guaranteeFee == null
          ? '—'.padStart(9)
          : `$${Number(rate.guaranteeFee).toFixed(2)}`.padStart(9);
      const remit =
        rate.importCharges == null
          ? '—'.padStart(8)
          : `$${Number(rate.importCharges).toFixed(2)}`.padStart(8);
      const landed =
        rate.landedTotal == null
          ? '—'.padStart(8)
          : `$${Number(rate.landedTotal).toFixed(2)}`.padStart(8);
      console.log(
        `${service} ${shipping} ${duty} ${clearance} ${guarantee} ${remit} ${landed}  ${rate.currency}`,
      );
      if (rate.landedError) {
        console.log(`  zonos: ${rate.landedError}`);
      }
      if (rate.feeItems?.length) {
        for (const fee of rate.feeItems) {
          const tag = fee.isGuarantee ? 'GUARANTEE' : 'CLEARANCE';
          console.log(
            `  fee[${tag}] type=${fee.type || '—'} ` +
              `$${Number(fee.amount).toFixed(2)} ` +
              `desc=${fee.description || fee.note || '—'} ` +
              `formula=${fee.formula || '—'}`,
          );
        }
      }
      const zonosService =
        rate.zonosRequest?.shipmentRating?.serviceLevelCode || '—';
      const itemCurrency =
        rate.zonosRequest?.items?.[0]?.currencyCode || '—';
      console.log(
        `  zonosRequest: serviceLevel=${zonosService} itemCurrency=${itemCurrency}`,
      );
    }
  } else {
    console.error(
      `\nNo Canada Post shipping rates: ${result.ratingError || result.status}`,
    );
  }

  console.log('\nDiagnostic JSON:\n' + JSON.stringify(result, null, 2));
  process.exitCode = result.rates.length ? 0 : 1;
}
