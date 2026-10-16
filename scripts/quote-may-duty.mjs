import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quoteStallion } from '../src/stallion-rate.js';
import { quoteUps } from '../src/ups-quote.js';
import { quoteCanadaPostUs } from '../src/canada-post-quote.js';
import { UPS_DISBURSEMENT_FEE_CAD } from '../src/ups-config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function loadEnv(p) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv(resolve(root, '.env'));

const mayOrders = [
  {
    orderNumber: '112-1408947-9707436',
    shipped: '2026-05-19',
    tracking: '1ZAC88906713596467',
    labelCost: 28.79,
    sku: 'SMI3000',
    customs: 10.08,
    weightLbs: 11.3,
    dims: [21.5, 18.25, 4.25],
  },
  {
    orderNumber: '111-1453041-6057866',
    shipped: '2026-05-25',
    tracking: '1ZAC88906738178961',
    labelCost: 32.19,
    sku: 'SMI3000',
    customs: 10.08,
    weightLbs: 11.3,
    dims: [21.5, 18.25, 4.25],
  },
];

console.log('NOTE: May ShipHero addresses are scrubbed (ZIP truncated, city/street null).');
console.log('Using placeholder US destination for quoting. Duty should still be invoice-checkable.');
console.log('Placeholder to: Boston, MA 02128\n');

for (const o of mayOrders) {
  const shipment = {
    orderNumber: o.orderNumber,
    currency: 'CAD',
    region: 'ON',
    from: {
      name: 'KapscoMoto Warehouse',
      company: 'KapscoMoto',
      address1: '410 Finley Ave',
      city: 'Ajax',
      state: 'ON',
      postalCode: 'L1S 2E3',
      country: 'CA',
      phone: '9055550100',
    },
    to: {
      name: 'Invoice Check',
      address1: '1 Harborside Dr',
      city: 'Boston',
      state: 'MA',
      postalCode: '02128',
      country: 'US',
      phone: '6175550100',
      is_residential: true,
    },
    packages: [
      {
        name: o.sku,
        weightLbs: o.weightLbs,
        lengthIn: o.dims[0],
        widthIn: o.dims[1],
        heightIn: o.dims[2],
        package_contents: 'Iron Motorcycle Lift Stands',
      },
    ],
    items: [
      {
        title: 'Iron Motorcycle Lift Stands',
        sku: o.sku,
        quantity: 1,
        value: o.customs,
        currency: 'USD',
        hs_code: '8425.49.00.00',
        country_of_origin: 'CA',
        customs_description: 'Iron Motorcycle Lift Stands',
      },
    ],
  };

  writeFileSync(
    resolve(root, 'samples', `order-${o.orderNumber}-may-invoice-check.json`),
    JSON.stringify(shipment, null, 2),
  );

  const [stallion, ups, cp] = await Promise.all([
    quoteStallion(shipment),
    quoteUps(shipment),
    quoteCanadaPostUs(shipment),
  ]);

  console.log('==========', o.orderNumber, '==========');
  console.log(
    `Shipped ${o.shipped} | UPS Expedited label $${o.labelCost} | ${o.tracking}`,
  );
  console.log(
    `Item ${o.sku} customs $${o.customs} HS 8425.49.00.00 | pkg ${o.weightLbs} lb ${o.dims.join('x')}`,
  );
  console.log(
    `DUTY  Stallion $${stallion.rates?.[0]?.duty ?? 'n/a'} | UPS $${ups.landedCost?.totalDutyAndTax ?? 'n/a'} | Zonos $${cp.rates?.find((r) => r.duty != null)?.duty ?? 'n/a'}`,
  );
  console.log(`UPS disbursement flat $${UPS_DISBURSEMENT_FEE_CAD} (not duty)`);
  if (stallion.rates?.length) {
    console.log('Stallion:');
    for (const r of stallion.rates) {
      console.log(
        `  ${r.service_name}: base $${r.base_rate} duty $${r.duty} total $${r.total}`,
      );
    }
  } else {
    console.log('Stallion:', stallion.status, stallion.message || 'no rates');
  }
  console.log('UPS:');
  for (const r of ups.rates || []) {
    console.log(
      `  ${r.serviceName}: ship $${r.shipping} duty/tax $${r.dutyAndTax} disburse $${r.brokerage} landed $${r.landedTotal}`,
    );
  }
  console.log('CP+Zonos:');
  for (const r of cp.rates || []) {
    console.log(
      `  ${r.serviceName}: ship $${r.shipping} duty $${r.duty} fees $${r.fees} import $${r.importCharges} landed $${r.landedTotal}`,
    );
  }
  console.log('');
}
