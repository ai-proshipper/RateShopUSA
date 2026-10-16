import { randomUUID } from 'node:crypto';
import {
  assertUpsQuoteCredentials,
  assertUpsQuoteOnlyUrl,
  upsAccountNumber,
  upsClientId,
  upsClientSecret,
  upsTokenUrl,
  upsTransactionSrc,
} from './ups-config.js';

/** @type {{ token: string, expiresAt: number } | null} */
let cachedToken = null;

function upsError(data, fallback) {
  return (
    data?.response?.errors?.[0]?.message ||
    data?.error_description ||
    data?.error ||
    fallback
  );
}

export async function getUpsAccessToken(timeoutMs = 10000) {
  assertUpsQuoteCredentials();
  if (cachedToken?.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const url = upsTokenUrl();
  assertUpsQuoteOnlyUrl(url, 'oauth');
  const basic = Buffer.from(
    `${upsClientId()}:${upsClientSecret()}`,
    'utf8',
  ).toString('base64');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'x-merchant-id': upsAccountNumber(),
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`UPS OAuth returned non-JSON (HTTP ${response.status})`);
  }
  if (!response.ok) {
    throw new Error(
      `UPS OAuth failed: ${upsError(data, `HTTP ${response.status}`)}`,
    );
  }
  if (!data.access_token) {
    throw new Error('UPS OAuth response did not include an access token');
  }

  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 14399) * 1000,
  };
  return cachedToken.token;
}

export async function upsQuoteHeaders(timeoutMs = 10000) {
  const token = await getUpsAccessToken(timeoutMs);
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    transId: randomUUID().replaceAll('-', '').slice(0, 32),
    transactionSrc: upsTransactionSrc(),
  };
}

export function clearUpsTokenCache() {
  cachedToken = null;
}
