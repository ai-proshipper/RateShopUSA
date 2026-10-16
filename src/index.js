/**
 * Public entry for CAD RateShopping dest-country branch.
 * CAD calls handleUsaGenerateLabel in-process (not HTTP) for US dest.
 */
export { handleUsaGenerateLabel, runUsaGenerateLabelDetailed } from './usa-webhook-handler.js';
export { parseGenerateLabelPayload } from './shiphero-webhook.js';
export { compareQuotes, pickBuyableWinner, isBuyableWinner, usaIncompleteShopError } from './compare-quotes.js';
export { normalizeCountryCode } from './shiphero-webhook.js';
export {
  getCanadaPostAccessToken as getUsaCanadaPostAccessToken,
  startCanadaPostTokenRefresh as startUsaCanadaPostTokenRefresh,
} from './canada-post-auth.js';
export {
  getShipHeroAccessToken,
  startShipHeroTokenRefresh,
  shipHeroAuthConfigured,
} from './shiphero-auth.js';
