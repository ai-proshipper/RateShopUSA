import crypto from 'node:crypto';

/**
 * Verify ShipHero `x-shiphero-hmac-sha256` header against raw request body.
 * @param {{ rawBodyBytes: Buffer, signatureHeader: string|undefined, secret: string }}
 */
export function verifyShipHeroHmac({ rawBodyBytes, signatureHeader, secret }) {
  if (!secret) return false;

  const computedHex = crypto
    .createHmac('sha256', secret)
    .update(rawBodyBytes)
    .digest('hex')
    .toLowerCase();

  const computedBase64 = crypto
    .createHmac('sha256', secret)
    .update(rawBodyBytes)
    .digest('base64');

  const normalizedSig = String(signatureHeader || '').trim();
  if (!normalizedSig) return false;

  const sigNoPrefix = normalizedSig.toLowerCase().startsWith('sha256=')
    ? normalizedSig.slice('sha256='.length).toLowerCase()
    : normalizedSig.toLowerCase();

  const normalizedBase64 = normalizedSig.trim().replace(/^sha256=/i, '');

  return sigNoPrefix === computedHex || normalizedBase64 === computedBase64;
}
