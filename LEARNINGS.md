# RateShop-USA — What We Learned

Simple notes from building US-bound rate shop (Stallion, UPS, Canada Post + Zonos).

---

## Goal

Compare **CAD landed totals**: shipping + duties/fees for shipments into the US.

Carriers:

1. **Stallion** — shipping + duty + fees in one rates API (tote SKUs / ShipHero items)
2. **UPS** — Rating (shipping) + **Zonos duties** (from the Canada Post quote) + our contract disbursement
3. **Canada Post** — CP rates + **Zonos GraphQL** for duty/fee estimates; labels use CP’s linked Zonos account

**Customs values from ShipHero are USD.** Postage and ranked landed totals are CAD. Do not inherit `shipment.currency` (order/postage CAD) as the customs currency.

---

## Print path (ShipHero Generate Label)

One **Rate Shop** method. One webhook URL. Dest country chooses the shop.

Packers keep using **API → Rate Shop**. Weight/dims come from the Generate Label payload at print time (no GraphQL on the hot path).

| Where | What |
|------|------|
| **Production (CAD RateShopping)** | Same URL. `to_address` **US** → `handleUsaGenerateLabel` in-process (`rateshop-usa` package). **CA** → existing CAD carriers. Intelcom URL profile stays CAD-only. |
| **Local USA tests** | Optional standalone `npm start` in RateShop-USA (port 3457). Do **not** register that URL with ShipHero. |

```js
// RateShopping src/webhook-handler.js
import { handleUsaGenerateLabel } from 'rateshop-usa';

if (profile === 'rate-shop' && dest === 'US') {
  return handleUsaGenerateLabel(payload, headers);
}
// else existing CAD handleGenerateLabelWebhook body
```

Embed notes:

- `LABELS_PUBLIC_DIR` is set by CAD `server.js` to CAD `public/labels` so PDFs are served at the shared `PUBLIC_BASE_URL`.
- USA caps: `USA_MAX_LABEL_COST` / `USA_MAX_LANDED_COST` (defaults 150 / 500) so CAD's `MAX_LABEL_COST` (often 100) is not inherited.
- US CP services: `CANADA_POST_USA_SERVICE_CODES` (CAD keeps `CANADA_POST_SERVICE_CODES=DOM.*`).

USA handler:

1. Parse payload → USA shipment (customs **USD**, reject non-US dest, single package).
2. Quote Stallion + UPS 08/12 + CP USA+Zonos in parallel (~9s budget).
3. Auto-pick cheapest **CAD landed** that is **buyable** (skip non-trackable / non-allowlisted Stallion).
4. Canada Post quote timeout: tries 1–2 fail the print (`Canada Post quote timed out. Please try again.`) so the packer retries. Try 3+ bypasses CP and ranks Stallion/UPS. Same as CAD Rate Shop.
5. Buy that label only (do not void; do not CP transmit). Re-host PDF at `/labels/{tracking}.pdf`.
6. Return CAD-identical JSON: `{ code:"200", shipping_method, shipping_carrier, tracking_number, cost, label, tracking_url }`.

`cost` is amount charged at print (Stallion billed total; UPS/CP postage). Ranking uses landed. Caps: `USA_MAX_LABEL_COST` / `USA_MAX_LANDED_COST` (or `MAX_*` fallbacks).

Local test payload: `samples/us-webhook.json`.

---

## Big rule: duties should match, APIs often don’t

Legal duty (same HS, origin, value, date) **should be constant**.

These APIs are **separate duty estimators**, not CBP. They disagree — especially on **Section 301** and **Section 232**.

| Engine | What we see |
|--------|-------------|
| **Zonos** | Clearest. Itemized duties (MFN, 301, 232). Best for understanding special tariffs. Used for live CP and UPS quotes. |
| **UPS Landed Cost** | Diagnostic only (`src/ups-landed-cost.js`). Often understates. Misses or under-applies 301/232. Sometimes rewrites HS codes. **Not used** by `quoteUps` / `compareQuotes`. |
| **Stallion** | Gives a single `duty` number. No rate formula. Only works if HS is in their **rates tariff DB**. |

**For invoice truth:** trust what was actually billed on the entry, not the rate-shop duty fields.

---

## UPS

### Rep / contract facts

- UPS Landed Cost brokerage is **list**, not negotiated — ignored on live quotes.
- Disbursement fee (contract): **$4.80 CAD**.
- **Entry Prep does not apply** on:
  - UPS Worldwide Expedited (`08`)
  - UPS 3 Day Select (`12`)

### How we quote UPS

```
landed = shipping (Rating) + Zonos duties (from CP quote) + $4.80
```

- Live path does **not** call UPS Landed Cost (it understates 301/232).
- Ignore Landed Cost `totalBrokerageFees` / `grandTotal` (list fees ~$33) if you run the diagnostic module.
- Quote services `08`, `12`, and `11` (UPS Standard, always).
- Rank UPS Standard with **+$10 CAD** on postage; print cost stays the Rating amount.
- Sanitize SKU `+` → `-` in commodity IDs (UPS rejects `+`).

### UPS Landed Cost fields (diagnostic module)

| Field | Notes |
|-------|--------|
| `totalDuties` | Shipment-level “duties” |
| `totalDutyandTax` | Same amount often |
| `commodityDuty` | Sometimes **0** even when shipment duties &gt; 0 |
| `totalCommodityDutyandTax` | Where the amount often sits on the line |

Treat UPS Landed Cost as a **duty/tax bucket**, not a clean commodity duty line.

### Example gap (KNX51722A)

| Source | Duties |
|--------|-------:|
| UPS Landed Cost | ~$10.95 |
| Zonos | ~$93.78 (includes 232 aluminum **200%** ≈ $81.59) |

That gap is why live UPS quotes use Zonos duties, not UPS Landed Cost.

---

## Stallion

### Tote SKUs, not catalog rewrite

- Quotes and labels send the **shipment items** (what is in the tote / ShipHero lines).
- Do **not** replace HS, origin, or value from `GET /products/{sku}`, and do not drop SKUs missing from the Stallion catalog.
- Format HS as dotted 10-digit (`8425.49.00.00`) for `POST /rates`.
- `POST /rates` still uses Stallion’s **rates tariff DB**. Many HS codes fail with “not in our tariff database.”
- Oversized packages often return `ok` with **empty rates**.

Codes that have worked for rates + duty (examples): `8425.49.00.00`, `6306.12.00.00`.

Catalog `GET /products` remains a read-only diagnostic (`scripts/probe-stallion-hs.mjs`). Product catalog “Approved” HS is a different DB from rates.

### Rate response fields (`data[]`)

| Field | Meaning |
|-------|---------|
| `base_rate` | Shipping |
| `duty` | Duty (same across services on a quote) |
| `duty_tax` | Tax on duty |
| `tax`, `gst`, `pst`, `hst`, `qst` | Tax splits |
| `add_ons[]` | Fees (e.g. Admin Fee, Brokerage Fee) — `name`, `cost`, `currency` |
| `subtotal` / `total` | Totals |
| `currency` | Usually CAD |
| `carrier`, `service`, `service_name` | Service identity |
| `postage_type_id` | Internal id |
| `trackable`, `estimated_delivery_days` | Meta |

Also: `meta.excluded_services[]` with reasons.

**Math check:** `base_rate + duty + add_ons ≈ total` (when taxes are 0).

No HS / tariff formula breakdown — only the `duty` number.

### Labels (gated probe)

- `POST /labels` buys postage (credits charged immediately).
- `POST /shipments/{id}/void` is a **request**, not instant cancel. Unused tracked labels refund as credits in **up to 14 days**.
- Non-trackable services (e.g. USPS First Class Mail) **cannot** be voided — the probe refuses them.
- Token needs `labels:create` + `shipments:void` (rates-only token is not enough).
- Label buy is allowlisted: `STALLION_LABEL_CARRIERS` (default `USPS`) and optional `STALLION_LABEL_SERVICES`. Quotes stay unfiltered. `trackable` must be `true`.

---

## Zonos

### Quotes (GraphQL)

Used to **estimate** import charges for Canada Post services and to attach the same duty number onto UPS landed totals.

Clear split:

- **`duties[]`** — real duties (notes like “Section 232…”, “Section 301…”)
- **`fees[]`** — clearance / disbursement (not duty)
- **`taxes[]`** — taxes

We map duties → duty; non-guarantee fees → clearance fees.

Service levels: `USA.EP` → `canada_post.expedited_parcel_usa`, `USA.XP` → `canada_post.xpresspost_usa`, `USA.TP` / `USA.TP.LVM` → `canada_post.tracked_packet_usa`.

### Labels

Canada Post Create Shipment **requires** `X-CPC-Zonos-Key` (`ZONOS_ACCOUNT_KEY`) for US destinations (error 8722: Declaration ID or Account Key). The merchant Zonos link still remits duties; the header is what CP uses to attach a Declaration ID on the label. GraphQL (`ZONOS_API_KEY`) remains quote-only.

---

## Worked examples

### SMI6010 (May 20 order `111-8209310-3352207`)

- Customs **USD** $18.88, HS `8425.49.00.00`, origin CA
- Stallion duty: **$9.75** (fees separate in `add_ons`)
- UPS Landed Cost duty/tax: **$11.33** (`commodityDuty: 0`) — diagnostic, not the live quote
- Zonos duty: **$6.58** (232 auto parts **25%**); fees separate (~$2.65)

Same inputs → three different “duties.” Live UPS quotes use the Zonos duty + $4.80.

### May ShipHero addresses

- Older May orders often have **scrubbed** ship-to (null city/street, short ZIP).
- Duty can still be probed with a placeholder US address; shipping rates won’t match the real lane.

---

## Practical takeaways

1. **Shipping** — trust each carrier’s rating API.
2. **Brokerage/fees** — use contract/known fees; don’t trust UPS list brokerage.
3. **Duties** — expect disagreement. Zonos explains special tariffs best; UPS Landed Cost / Stallion are weaker for 301/232-heavy goods.
4. **Stallion** — quote tote SKUs; rates still only work when HS is in the rates tariff DB and the package rates.
5. **Invoice matching** — compare to real billed duty, not API estimates alone.

---

## Code touchpoints

| File | Role |
|------|------|
| `src/usa-webhook-handler.js` | `handleUsaGenerateLabel` — quote, pick, purchase (CAD-identical GLW JSON) |
| `src/canada-post-quote-timeouts.js` | CP quote timeout 2-strike retry (try 1–2 block, try 3+ bypass) |
| `src/index.js` | Public export for CAD dest-country call (`rateshop-usa` package) |
| `src/server.js` | Local Express only (`POST /webhook/shiphero/label`) |
| `src/shiphero-webhook.js` | ShipHero payload → USA shipment (USD customs) |
| `src/compare-quotes.js` | `compareQuotes` + `pickBuyableWinner` |
| `src/label-router.js` | Purchase-only `create*UsLabel` (no void) |
| `src/ups-config.js` | Services `08`/`12`, disbursement `$4.80`, gated ship/void |
| `src/ups-quote.js` | Combines Rating + Zonos duties (from CP) + flat fee |
| `src/ups-landed-cost.js` | Diagnostic Landed Cost call; not used in live quotes |
| `src/ups-label.js` | US create (webhook keeps; probes void; `08`/`12` only) |
| `src/stallion-rate.js` | Stallion `POST /rates` from tote items |
| `src/stallion-config.js` | Host allowlist, gated create/void |
| `src/stallion-label.js` | US create (webhook keeps; probes void) |
| `src/zonos-landed-cost.js` | Zonos GraphQL duties vs fees (quotes only) |
| `src/canada-post-quote.js` | CP + Zonos combine |
| `src/canada-post-label.js` | CP create (webhook keeps; probes void); `X-CPC-Zonos-Key` |

Probe helpers live under `scripts/` (e.g. duty compares, May-order checks).
