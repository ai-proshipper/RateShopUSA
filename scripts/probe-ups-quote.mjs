import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quoteUps } from '../src/ups-quote.js';
import {
  assertUpsQuoteCredentials,
  UPS_DISBURSEMENT_FEE_CAD,
  UPS_QUOTE_TIMEOUT_MS,
} from '../src/ups-config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shipment = JSON.parse(
  readFileSync(resolve(root, 'samples', 'us-shipment.json'), 'utf8'),
);

console.log('=== UPS RATE-ONLY PROBE (NO LABELS / NO SHIPMENTS) ===');
console.log(
  'Services: UPS Worldwide Expedited (08), UPS 3 Day Select (12), UPS Standard (11) always (Standard ranked +$10 CAD postage pad)',
);
console.log(
  `UPS Rating Shop + Zonos duties (from Canada Post quote) + $${UPS_DISBURSEMENT_FEE_CAD.toFixed(2)} disbursement`,
);
console.log(
  `Ship: ${shipment.from.city}, ${shipment.from.state} → ` +
    `${shipment.to.city}, ${shipment.to.state} ${shipment.to.postalCode}`,
);

try {
  assertUpsQuoteCredentials();
} catch (error) {
  console.error(`\nREFUSING: ${error.message}`);
  process.exitCode = 2;
}

if (process.exitCode !== 2) {
  const result = await quoteUps(shipment, UPS_QUOTE_TIMEOUT_MS);

  if (result.rates.length) {
    console.log(
      '\nService                         Shipping      Duty  Disburse   Import     Landed    Currency',
    );
    console.log('-'.repeat(101));
    for (const rate of result.rates) {
      const service = String(rate.serviceName).padEnd(31).slice(0, 31);
      const shipping = `$${rate.shipping.toFixed(2)}`.padStart(9);
      const duty =
        rate.duty == null
          ? '—'.padStart(9)
          : `$${rate.duty.toFixed(2)}`.padStart(9);
      const brokerage =
        rate.brokerage == null
          ? '—'.padStart(9)
          : `$${rate.brokerage.toFixed(2)}`.padStart(9);
      const imports =
        rate.importCharges == null
          ? '—'.padStart(9)
          : `$${rate.importCharges.toFixed(2)}`.padStart(9);
      const landed =
        rate.landedTotal == null
          ? '—'.padStart(9)
          : `$${rate.landedTotal.toFixed(2)}`.padStart(9);
      console.log(
        `${service} ${shipping} ${duty} ${brokerage} ${imports} ${landed}  ${rate.currency}`,
      );
    }
  } else {
    console.error(`\nNo UPS shipping rates: ${result.ratingError || result.status}`);
  }

  if (result.zonosDuty?.status !== 'ok') {
    console.warn(
      `\nZonos duties ${result.zonosDuty?.status || 'unavailable'}: ` +
        `${result.zonosDuty?.error || 'Canada Post Zonos duties unavailable'}`,
    );
  } else {
    const zd = result.zonosDuty;
    const quoted = result.rates.find((rate) => rate.importCharges != null);
    console.log(
      `\nQuote import charges: Zonos duties $${zd.duties.toFixed(2)} ` +
        `(CP ${zd.sourceService || 'rate'}) ` +
        `+ disbursement $${UPS_DISBURSEMENT_FEE_CAD.toFixed(2)}` +
        (quoted
          ? ` = $${quoted.importCharges.toFixed(2)} ${quoted.landedCurrency}`
          : ''),
    );
  }

  console.log('\nDiagnostic JSON:\n' + JSON.stringify(result, null, 2));
  process.exitCode = result.rates.length ? 0 : 1;
}
