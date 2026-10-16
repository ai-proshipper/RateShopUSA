/**
 * USA Generate Label path. Same inbound/outbound JSON as CAD Rate Shop.
 * CAD RateShopping calls runUsaGenerateLabelDetailed in-process for US dest
 * so quotes can be audited. Do not import from ../RateShopping (one-way).
 */
import {
  AUTO_SELECT_WINNER,
  QUOTE_ONLY,
  WEBHOOK_DEADLINE_MS,
  labelPhaseBudgetMs,
  maxLabelCostForRequest,
  quotePhaseBudgetMs,
} from './config.js';
import {
  compareQuotes,
  isBuyableWinner,
  isCanadaPostNoService,
  isCanadaPostQuoteTimeout,
  pickBuyableWinner,
  pickPoBoxWinner,
  postageCompareFromRanked,
  printCostForRow,
  usaCanadaPostTimeoutShopError,
  usaCarriersMissingLandedRates,
  usaIncompleteShopError,
} from './compare-quotes.js';
import { purchaseUsaLabel } from './label-router.js';
import { scheduleUsaCustomsAttachment } from './shiphero-order-attachment.js';
import {
  assertLabelCostAllowed,
  assertLandedCostAllowed,
} from './shiphero-response.js';
import { enrichUsaShipmentCustomsFromShipHero } from './shiphero-product-customs.js';
import { canadaPostPoBoxUnavailableMessage, shipmentGoesToPoBox } from './po-box.js';
import { parseGenerateLabelPayload, normalizeCountryCode } from './shiphero-webhook.js';
import { elapsedMs, logTimings, nowMs } from './timing.js';
import { orderDedupKey, withOrderDedup } from './webhook-dedup.js';

function isMultiPackagePayload(rawPayload) {
  const packages = Array.isArray(rawPayload?.packages) ? rawPayload.packages : [];
  return packages.length > 1;
}

function quoteFailureSummary(comparison) {
  const bits = [];
  const stallion = comparison.stallion;
  if (stallion?.status && stallion.status !== 'ok' && stallion.status !== 'skipped') {
    bits.push(`Stallion: ${stallion?.message || stallion?.status || 'no rates'}`);
  }
  const ups = comparison.ups;
  if (ups?.status === 'error' || !(ups?.rates || []).some((r) => r.landedTotal != null)) {
    bits.push(
      `UPS: ${
        ups?.error ||
        ups?.ratingError ||
        ups?.zonosDuty?.error ||
        (ups?.rates || []).find((r) => r?.landedError)?.landedError ||
        ups?.status ||
        'no rates'
      }`,
    );
  }
  const cp = comparison.canadaPost;
  if (cp?.status === 'error' || !(cp?.rates || []).some((r) => r.landedTotal != null)) {
    bits.push(`Canada Post: ${cp?.ratingError || cp?.zonosError || cp?.status || 'no rates'}`);
  }
  return bits.join('; ') || 'no buyable rates';
}

function logRanked(orderRef, ranked, winner) {
  const lines = (ranked || []).map((row, i) => {
    const mark = winner && row === winner ? ' *' : '';
    const skipped = isBuyableWinner(row) ? '' : ' skip';
    const extras = [];
    if (row.tax != null) extras.push(`tax=${row.tax}`);
    if (row.duty_tax != null) extras.push(`duty_tax=${row.duty_tax}`);
    if (row.taxes != null) extras.push(`taxes=${row.taxes}`);
    if (row.fees != null) extras.push(`fees=${row.fees}`);
    if (row.brokerage != null) extras.push(`brokerage=${row.brokerage}`);
    if (row.importCharges != null) extras.push(`import=${row.importCharges}`);
    const extraBit = extras.length ? ` ${extras.join(' ')}` : '';
    return (
      `  ${i + 1}. ${row.carrier} ${row.service || row.serviceCode}` +
      ` ship=${row.shipping} duty=${row.duty}${extraBit} landed=${row.landedTotal}` +
      `${row.compareMode === 'postage' && row.fullLandedTotal != null ? ` fullLanded=${row.fullLandedTotal}` : ''}` +
      `${row.compareMode === 'postage' ? ' postage' : ''}` +
      `${skipped}${mark}`
    );
  });
  console.log(`[usa-rate-shop] ${orderRef} ranked:\n${lines.join('\n') || '  (empty)'}`);
}

function shipHeroDestinationCountry(rawPayload) {
  const to = rawPayload?.to_address;
  if (!to || typeof to !== 'object') return '';
  const a = /** @type {Record<string, unknown>} */ (to);
  const raw = a.country ?? a.country_code ?? a.countryCode;
  return normalizeCountryCode(raw, '');
}

function attachUsaAudit(err, audit) {
  const error = err instanceof Error ? err : new Error(String(err));
  error.usaAudit = audit;
  return error;
}

function assertUsaDestination(rawPayload) {
  const dest = shipHeroDestinationCountry(rawPayload);
  if (dest !== 'US') {
    throw new Error(
      `USA Rate Shop only handles US destinations (got ${dest || 'missing'}). ` +
        'Canada dest belongs on the CAD Rate Shop path.',
    );
  }
}

function assertSinglePackage(rawPayload) {
  if (!isMultiPackagePayload(rawPayload)) return;
  const packageCount = Array.isArray(rawPayload.packages) ? rawPayload.packages.length : 0;
  const orderRef = rawPayload.order_number || rawPayload.order_id || 'unknown';
  console.error(
    `[multi-package] order ${orderRef}: ${packageCount} packages — rejected (rate shop supports one package only)`,
  );
  throw new Error('Rate Shop supports one package per shipment only');
}

/**
 * Quote + buy a US label and return audit fields for CAD rate-audit sessions.
 * @param {Record<string, unknown>} rawPayload
 * @param {Record<string, string|undefined>} [forwardHeaders]
 * @param {string|null} [dedupKey]
 */
export async function runUsaGenerateLabelDetailed(
  rawPayload,
  forwardHeaders = {},
  dedupKey = null,
) {
  assertUsaDestination(rawPayload);
  assertSinglePackage(rawPayload);

  const startedAt = nowMs();
  const timings = { parseMs: 0, quoteTotalMs: 0, labelMs: 0, totalMs: 0, carriers: {} };
  /** @type {Record<string, unknown>} */
  const audit = {
    shipment: null,
    ranked: [],
    winner: null,
    comparison: null,
    timings,
  };

  try {
    const parseStart = nowMs();
    const shipment = parseGenerateLabelPayload(rawPayload);
    await enrichUsaShipmentCustomsFromShipHero(shipment);
    audit.shipment = shipment;
    timings.parseMs = elapsedMs(parseStart);
    const orderRef = shipment.orderNumber || shipment.orderId || 'unknown';

    const poBox = shipmentGoesToPoBox(shipment);
    const quoteBudgetMs = quotePhaseBudgetMs(timings.parseMs);
    const quoteStart = nowMs();
    const comparison = await compareQuotes(shipment, quoteBudgetMs);
    timings.quoteTotalMs = elapsedMs(quoteStart);
    audit.comparison = comparison;
    audit.ranked = comparison.ranked || [];

    let winner = poBox
      ? pickPoBoxWinner(comparison.ranked)
      : pickBuyableWinner(comparison.ranked);
    audit.winner = winner;
    audit.postageCompare = postageCompareFromRanked(comparison.ranked);
    if (comparison.compareMode === 'postage') {
      const why =
        comparison.compareReason === 'duty_delta'
          ? 'Stallion vs Zonos duties diverge >50%'
          : comparison.compareReason === 'zonos_unavailable'
            ? 'Zonos duties unavailable'
            : 'postage compare';
      console.warn(`[usa-rate-shop] ${orderRef} ranking by postage (${why})`);
    }
    logRanked(orderRef, comparison.ranked, winner);

    logTimings(`print-label ${orderRef} profile=usa`, {
      parse: timings.parseMs,
      quoteTotal: timings.quoteTotalMs,
      total: elapsedMs(startedAt),
    });

    if (!poBox && isCanadaPostNoService(comparison)) {
      const why =
        comparison.canadaPost?.ratingError || comparison.canadaPost?.status || 'no rates';
      console.warn(`[usa-rate-shop] ${orderRef} Canada Post no service (${why}) — ignored`);
    }

    const ignoreCanadaPost = poBox ? false : isCanadaPostNoService(comparison);
    if (isCanadaPostQuoteTimeout(comparison)) {
      console.warn(`[usa-rate-shop] ${orderRef} Canada Post quote timeout`);
      audit.winner = null;
      throw new Error(usaCanadaPostTimeoutShopError());
    }

    const missingRates = usaCarriersMissingLandedRates(comparison, {
      ignoreCanadaPost,
      poBox,
    });
    if (missingRates.length) {
      const shopError = poBox
        ? canadaPostPoBoxUnavailableMessage(comparison.canadaPost)
        : usaIncompleteShopError(comparison, comparison.ranked, {
            ignoreCanadaPost,
          });
      console.error(`[usa-rate-shop] ${orderRef} ${shopError}`);
      throw new Error(shopError);
    }
    if (!winner) {
      if (poBox) {
        const shopError = canadaPostPoBoxUnavailableMessage(comparison.canadaPost);
        console.error(`[usa-rate-shop] ${orderRef} ${shopError}`);
        throw new Error(shopError);
      }
      throw new Error(`No valid carrier quotes (${quoteFailureSummary(comparison)})`);
    }

    if (QUOTE_ONLY) {
      const who = winner
        ? `${winner.carrier} ${winner.service || winner.serviceCode} landed=${Number(winner.landedTotal).toFixed(2)}`
        : 'none';
      throw new Error(
        `Rate shop is in quote-only mode — set QUOTE_ONLY=false to purchase labels (winner: ${who})`,
      );
    }

    if (!AUTO_SELECT_WINNER) {
      throw new Error('Manual carrier selection is not enabled in v1 (set AUTO_SELECT_WINNER=true)');
    }

    if (elapsedMs(startedAt) > WEBHOOK_DEADLINE_MS) {
      throw new Error('Rate shop timed out before label purchase — try again');
    }

    assertLandedCostAllowed(winner.landedTotal);
    const maxLabelCost = maxLabelCostForRequest(rawPayload);
    assertLabelCostAllowed(printCostForRow(winner), maxLabelCost);

    const labelBudgetMs = labelPhaseBudgetMs(elapsedMs(startedAt));
    if (labelBudgetMs < 2500) {
      throw new Error('Rate shop timed out before label purchase — try again');
    }

    const labelStart = nowMs();
    const purchased = await purchaseUsaLabel(
      winner,
      shipment,
      labelBudgetMs,
      forwardHeaders,
      { maxLabelCost },
    );
    const shipHeroResponse = purchased.shipHeroResponse;
    scheduleUsaCustomsAttachment({
      orderId: shipment.orderId,
      customsUrl: purchased.customsUrl,
      tracking: purchased.tracking,
      fileType: purchased.customsExt,
    });
    timings.labelMs = elapsedMs(labelStart);
    timings.totalMs = elapsedMs(startedAt);
    audit.timings = timings;

    logTimings(`print-label ${orderRef} profile=usa (done)`, {
      parse: timings.parseMs,
      quoteTotal: timings.quoteTotalMs,
      label: timings.labelMs,
      total: timings.totalMs,
      winner: `${winner.carrier}/${winner.serviceCode}`,
    });

    return {
      shipHeroResponse,
      shipment,
      ranked: audit.ranked,
      winner,
      comparison,
      timings,
    };
  } catch (err) {
    timings.totalMs = elapsedMs(startedAt);
    audit.timings = timings;
    throw attachUsaAudit(err, audit);
  }
}

/**
 * Quote + buy a US label. Returns ShipHero JSON (standalone USA server).
 * Production CAD path uses runUsaGenerateLabelDetailed so it can audit quotes.
 * @param {Record<string, unknown>} rawPayload
 * @param {Record<string, string|undefined>} [forwardHeaders]
 */
export async function handleUsaGenerateLabel(rawPayload, forwardHeaders = {}) {
  assertUsaDestination(rawPayload);
  assertSinglePackage(rawPayload);

  const dedupKey = orderDedupKey(rawPayload);
  return withOrderDedup(dedupKey, async () => {
    const result = await runUsaGenerateLabelDetailed(rawPayload, forwardHeaders, dedupKey);
    return result.shipHeroResponse;
  });
}
