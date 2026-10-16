/**
 * UPS and Stallion do not deliver to PO Boxes. Canada Post does —
 * same rule as the CAD rate shop: force Canada Post when we detect one.
 */

const PO_BOX_PHRASE =
  /\b(?:p\s*o\s*box|post\s*office\s*box|pobox|case\s*postale|boite\s*postale|boîte\s*postale)\b/i;

/** "PO 123", "P O #45", "CP 12", "C.P. 12" — number required so "CP Rail" does not match. */
const PO_BOX_NUMBERED = /\b(?:p\s*o|c\s*p)\s*(?:box|#)?\s*\d/i;

/** Bare "BOX 620" / "Box #45" with no "PO" prefix. Number required so "Box Elder" does not match. */
const BOX_NUMBERED = /\bbox\s*#?\s*\d/i;

/**
 * Flatten address lines the same way carriers see them.
 * @param {Record<string, unknown> | null | undefined} addr
 */
export function addressTextForPoBoxCheck(addr) {
  if (!addr || typeof addr !== 'object') return '';
  const a = /** @type {Record<string, unknown>} */ (addr);
  return [a.address1, a.address_1, a.address2, a.address_2, a.company, a.company_name]
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .join(' ');
}

function normalizeAddressText(text) {
  return String(text || '')
    .replace(/[.\-_/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} text
 */
export function textLooksLikePoBox(text) {
  const normalized = normalizeAddressText(text);
  if (!normalized) return false;
  return (
    PO_BOX_PHRASE.test(normalized) ||
    PO_BOX_NUMBERED.test(normalized) ||
    BOX_NUMBERED.test(normalized)
  );
}

/**
 * @param {Record<string, unknown> | null | undefined} addr
 */
export function isPoBoxAddress(addr) {
  return textLooksLikePoBox(addressTextForPoBoxCheck(addr));
}

/**
 * @param {Record<string, unknown> | null | undefined} shipment
 */
export function shipmentGoesToPoBox(shipment) {
  return isPoBoxAddress(shipment?.to);
}

/**
 * @param {Record<string, unknown> | null | undefined} cpQuote
 */
export function canadaPostPoBoxUnavailableMessage(cpQuote) {
  const detail = String(
    cpQuote?.ratingError || cpQuote?.error || cpQuote?.zonosError || '',
  ).trim();
  return (
    'NO LABEL PRINTED. This is a PO Box shipment, so Canada Post is required. ' +
    `Canada Post is unavailable right now${detail ? ` (${detail})` : ''}. Please try again later.`
  );
}
