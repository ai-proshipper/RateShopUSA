/**
 * Purchase-only USA label router. Creates and keeps the winning label.
 * Probes still void; this path must not.
 */
import { canadaPostServiceDisplayName, canadaPostTrackingUrl } from './canada-post-config.js';
import { createCanadaPostUsLabel } from './canada-post-label.js';
import { LABEL_TIMEOUT_MS } from './config.js';
import { saveLabelPdf } from './label-storage.js';
import { isPdfBytes, isPngBytes } from './pdf-utils.js';
import { normalizeShipHeroLabelResponse } from './shiphero-response.js';
import { printCostForRow } from './compare-quotes.js';
import { shipmentGoesToPoBox } from './po-box.js';
import { stallionEnabled } from './stallion-config.js';
import { createStallionUsLabel } from './stallion-label.js';
import { createUpsUsLabel } from './ups-label.js';
import { upsServiceName, upsTrackingUrl } from './ups-config.js';

const SHIPHERO_MAX_URL = 255;

function stallionTrackingUrl(trackingId, lastMileCarrier) {
  const id = String(trackingId || '').trim();
  if (!id) return '';
  const encoded = encodeURIComponent(id);
  const override = process.env.STALLION_TRACKING_URL?.trim();
  const template =
    override ||
    (() => {
      const lastMile = String(lastMileCarrier || '').toLowerCase();
      if (lastMile.includes('ups')) {
        return 'https://www.ups.com/track?tracknum={tracking_id}';
      }
      if (lastMile.includes('fedex')) {
        return 'https://www.fedex.com/fedextrack/?trknbr={tracking_id}';
      }
      if (lastMile.includes('osm')) {
        return 'https://tracking.osmworldwide.com/?trackingNumber={tracking_id}';
      }
      return 'https://tools.usps.com/go/TrackConfirmAction?tLabels={tracking_id}';
    })();
  const url = template.includes('{tracking_id}')
    ? template.replace('{tracking_id}', encoded)
    : `${template}${encoded}`;
  return url.length > SHIPHERO_MAX_URL ? '' : url;
}

function safePdfName(tracking) {
  const id = String(tracking || '').replace(/[^a-zA-Z0-9._-]/g, '_') || `usa-${Date.now()}`;
  return `${id}.pdf`;
}

function safeCustomsName(tracking, ext) {
  const id = String(tracking || '').replace(/[^a-zA-Z0-9._-]/g, '_') || `usa-${Date.now()}`;
  const suffix = ext === 'png' ? 'png' : 'pdf';
  return `${id}-customs.${suffix}`;
}

/**
 * Host the carrier customs PDF/PNG if they returned one. Empty string otherwise.
 * @param {string} tracking
 * @param {Record<string, unknown>} created
 * @param {Record<string, string|undefined>} forwardHeaders
 */
async function saveCarrierCustomsInfo(tracking, created, forwardHeaders) {
  const bytes = created?.customsPdfBytes;
  if (!bytes || bytes.length < 100) return '';
  const ext = created.customsExt === 'png' ? 'png' : 'pdf';
  if (ext === 'pdf' && !isPdfBytes(bytes)) return '';
  if (ext === 'png' && !isPngBytes(bytes)) return '';
  try {
    const url = await saveLabelPdf(safeCustomsName(tracking, ext), bytes, { forwardHeaders });
    if (url.length > SHIPHERO_MAX_URL) {
      console.warn(`[usa-label] customs document URL exceeds ${SHIPHERO_MAX_URL} chars — omitting`);
      return '';
    }
    return url;
  } catch (err) {
    console.warn(
      `[usa-label] failed to save carrier customs document: ${
        err instanceof Error ? err.message : err
      }`,
    );
    return '';
  }
}

/**
 * @param {Record<string, unknown>} winner
 * @param {Record<string, unknown>} created
 */
export function shippingFieldsForWinner(winner, created) {
  const carrier = String(winner.carrier || '').toLowerCase();
  if (carrier === 'stallion') {
    const lastMile = String(winner.lastMileCarrier || created.lastMileCarrier || 'usps').toLowerCase();
    return {
      shipping_method: String(created.serviceName || winner.service || 'Stallion').slice(0, 45),
      shipping_carrier: lastMile || 'stallion',
      tracking_url: stallionTrackingUrl(created.trackingNumber, lastMile),
    };
  }
  if (carrier === 'ups') {
    return {
      shipping_method: String(
        created.serviceName || upsServiceName(winner.serviceCode) || winner.service || 'UPS',
      ).slice(0, 45),
      shipping_carrier: 'ups',
      tracking_url: created.trackingUrl || upsTrackingUrl(created.trackingNumber),
    };
  }
  if (carrier === 'canada post' || carrier === 'canadapost') {
    const pin = created.trackingPin || created.trackingNumber;
    return {
      shipping_method: String(
        created.serviceName ||
          canadaPostServiceDisplayName(winner.serviceCode) ||
          winner.service ||
          'Canada Post',
      ).slice(0, 45),
      shipping_carrier: 'canada post',
      tracking_url: created.trackingUrl || canadaPostTrackingUrl(pin),
    };
  }
  return {
    shipping_method: String(winner.service || winner.carrier || 'API Shipping').slice(0, 45),
    shipping_carrier: 'api',
    tracking_url: '',
  };
}

/**
 * Buy the winning USA label.
 * Never voids. Never transmits Canada Post.
 * customs_info is always empty — customs PDF is attached after print, not printed.
 * @param {Record<string, unknown>} winner
 * @param {Record<string, unknown>} shipment
 * @param {number} [timeoutMs]
 * @param {Record<string, string|undefined>} [forwardHeaders]
 * @param {{ maxLabelCost?: number }} [opts]
 * @returns {Promise<{ shipHeroResponse: Record<string, string>, customsUrl: string, tracking: string, customsExt: string }>}
 */
export async function purchaseUsaLabel(
  winner,
  shipment,
  timeoutMs = LABEL_TIMEOUT_MS,
  forwardHeaders = {},
  opts = {},
) {
  const carrier = String(winner.carrier || '').toLowerCase();
  const budget = timeoutMs || LABEL_TIMEOUT_MS;

  if (shipmentGoesToPoBox(shipment) && carrier !== 'canada post' && carrier !== 'canadapost') {
    throw new Error(
      'NO LABEL PRINTED. This is a PO Box shipment, so Canada Post is required.',
    );
  }

  let created;
  if (carrier === 'stallion') {
    if (!stallionEnabled()) {
      throw new Error('Stallion is disabled (STALLION_ENABLED=false)');
    }
    created = await createStallionUsLabel(shipment, {
      service: String(winner.serviceCode || ''),
      timeoutMs: budget,
      quotedRate: {
        service: winner.serviceCode,
        service_name: winner.service,
        carrier: winner.lastMileCarrier,
        trackable: winner.trackable,
      },
    });
  } else if (carrier === 'ups') {
    created = await createUpsUsLabel(shipment, {
      serviceCode: String(winner.serviceCode || ''),
      timeoutMs: budget,
    });
  } else if (carrier === 'canada post' || carrier === 'canadapost') {
    created = await createCanadaPostUsLabel(shipment, {
      serviceCode: String(winner.serviceCode || ''),
      timeoutMs: budget,
    });
  } else {
    throw new Error(`Unknown USA winner for label purchase: ${winner.carrier}`);
  }

  const tracking =
    created.trackingNumber || created.trackingPin || created.shipmentId || `usa-${Date.now()}`;
  if (!created.pdfBytes || created.pdfBytes.length < 100) {
    throw new Error(`${winner.carrier} label PDF missing after create`);
  }

  const label = await saveLabelPdf(safePdfName(tracking), created.pdfBytes, { forwardHeaders });
  const customsInfo = await saveCarrierCustomsInfo(tracking, created, forwardHeaders);
  const fields = shippingFieldsForWinner(winner, created);
  const printCost = Number.isFinite(Number(created.cost))
    ? Number(created.cost)
    : printCostForRow(winner);

  if (customsInfo) {
    console.log(`[usa-label] customs document saved (${winner.carrier}): ${customsInfo}`);
  }

  const shipHeroResponse = normalizeShipHeroLabelResponse(
    {
      shipping_method: fields.shipping_method,
      shipping_carrier: fields.shipping_carrier,
      tracking_number: tracking,
      cost: printCost,
      label,
      tracking_url: fields.tracking_url,
      customs_info: '',
    },
    { maxLabelCost: opts.maxLabelCost },
  );

  return {
    shipHeroResponse,
    customsUrl: customsInfo,
    tracking: String(tracking),
    customsExt: created.customsExt === 'png' ? 'png' : 'pdf',
  };
}
