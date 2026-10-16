import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

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

loadEnv(resolve('.env'));

const file =
  process.argv[2] || './samples/order-111-8209310-3352207-may20-invoice-check.json';
const shipment = JSON.parse(readFileSync(file, 'utf8'));

console.log('=== INPUT ===');
console.log(
  JSON.stringify(
    {
      customs: shipment.customs_value,
      currency: shipment.currency,
      items: shipment.items?.map((i) => ({
        sku: i.sku,
        value: i.value,
        currency: i.currency,
        hs: i.hs_code,
        coo: i.country_of_origin,
        qty: i.quantity,
      })),
    },
    null,
    2,
  ),
);

const { quoteStallion } = await import('../src/stallion-rate.js');
const { quoteUpsLandedCost } = await import('../src/ups-landed-cost.js');
const { quoteZonosLandedCost } = await import('../src/zonos-landed-cost.js');

const [st, ups, zon] = await Promise.all([
  quoteStallion(shipment),
  quoteUpsLandedCost(shipment),
  quoteZonosLandedCost(shipment, {
    shipping: 30,
    currency: 'CAD',
    serviceCode: 'USA.EP',
    serviceName: 'Expedited Parcel',
  }),
]);

const r0 = st.raw?.data?.[0];
console.log('\n=== STALLION ===');
console.log(
  JSON.stringify(
    {
      duty: r0?.duty,
      duty_tax: r0?.duty_tax,
      tax: r0?.tax,
      base: r0?.base_rate,
      total: r0?.total,
      add_ons: r0?.add_ons,
    },
    null,
    2,
  ),
);

console.log('\n=== UPS LANDED COST ===');
const products = ups.raw?.shipment?.product || ups.raw?.product || [];
console.log(
  JSON.stringify(
    {
      totalDuties: ups.totalDuties,
      totalDutyAndTax: ups.totalDutyAndTax,
      totalVAT: ups.totalVAT,
      normalizedItems: ups.items,
      products: products.map((p) => ({
        hs:
          p.commodity?.tariffInfo?.htsCode ||
          p.tariffInfo?.htsCode ||
          p.htsCode,
        commodityDuty: p.commodityDuty ?? p.commodity?.commodityDuty,
        commodityVAT: p.commodityVAT ?? p.commodity?.commodityVAT,
        totalCommodityDutyandTax:
          p.totalCommodityDutyandTax ?? p.commodity?.totalCommodityDutyandTax,
        dutyRate: p.dutyRate ?? p.commodity?.dutyRate,
        tariffInfo: p.tariffInfo || p.commodity?.tariffInfo,
        dutyCalculationInfo:
          p.dutyCalculationInfo || p.commodity?.dutyCalculationInfo,
        allKeys: Object.keys(p),
      })),
      shipmentLevel: {
        totalDuties: ups.raw?.shipment?.totalDuties,
        totalDutyandTax: ups.raw?.shipment?.totalDutyandTax,
        totalVAT: ups.raw?.shipment?.totalVAT,
        totalFees: ups.raw?.shipment?.totalFees,
        totalBrokerageFees: ups.raw?.shipment?.totalBrokerageFees,
      },
    },
    null,
    2,
  ),
);

console.log('\n=== ZONOS ===');
console.log(
  JSON.stringify(
    {
      duties: zon.duties,
      taxes: zon.taxes,
      fees: zon.fees,
      dutyItems: zon.dutyItems,
      taxItems: zon.taxItems,
      feeItems: zon.feeItems,
      clearanceFeeItems: zon.clearanceFeeItems,
    },
    null,
    2,
  ),
);
