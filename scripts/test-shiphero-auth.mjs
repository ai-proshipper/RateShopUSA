/**
 * Unit tests for ShipHero access/refresh token helpers.
 */
import assert from 'node:assert/strict';
import {
  _resetShipHeroAuthForTests,
  getShipHeroAccessToken,
  shipHeroAuthConfigured,
  shipHeroTokenExpiresAtMs,
  shipHeroTokenNeedsRefresh,
} from '../src/shiphero-auth.js';

const savedAccess = process.env.SHIPHERO_API_TOKEN;
const savedRefresh = process.env.SHIPHERO_REFRESH_TOKEN;

function restoreEnv() {
  _resetShipHeroAuthForTests();
  if (savedAccess === undefined) delete process.env.SHIPHERO_API_TOKEN;
  else process.env.SHIPHERO_API_TOKEN = savedAccess;
  if (savedRefresh === undefined) delete process.env.SHIPHERO_REFRESH_TOKEN;
  else process.env.SHIPHERO_REFRESH_TOKEN = savedRefresh;
}

function fakeJwt(expSec) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url');
  return `${header}.${payload}.sig`;
}

_resetShipHeroAuthForTests();
delete process.env.SHIPHERO_API_TOKEN;
delete process.env.SHIPHERO_REFRESH_TOKEN;
assert.equal(shipHeroAuthConfigured(), false);

process.env.SHIPHERO_API_TOKEN = 'opaque-test-token';
assert.equal(shipHeroAuthConfigured(), true);
assert.equal(shipHeroTokenExpiresAtMs('opaque-test-token'), null);
assert.equal(shipHeroTokenNeedsRefresh('opaque-test-token'), false);
assert.equal(await getShipHeroAccessToken(), 'opaque-test-token');

const past = fakeJwt(Math.floor(Date.now() / 1000) - 60);
assert.equal(shipHeroTokenNeedsRefresh(past), true);

const future = fakeJwt(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60);
assert.equal(shipHeroTokenNeedsRefresh(future), false);

_resetShipHeroAuthForTests();
process.env.SHIPHERO_API_TOKEN = past;
process.env.SHIPHERO_REFRESH_TOKEN = 'refresh-abc';
let refreshCalls = 0;
const token = await getShipHeroAccessToken({
  fetchImpl: async (url, init) => {
    refreshCalls += 1;
    assert.match(String(url), /auth\/refresh$/);
    const body = JSON.parse(init.body);
    assert.equal(body.refresh_token, 'refresh-abc');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: future,
        expires_in: 2419200,
        token_type: 'Bearer',
      }),
    };
  },
});
assert.equal(token, future);
assert.equal(refreshCalls, 1);
assert.equal(process.env.SHIPHERO_API_TOKEN, future);

const cached = await getShipHeroAccessToken({
  fetchImpl: async () => {
    throw new Error('should use cache');
  },
});
assert.equal(cached, future);

restoreEnv();
console.log('shiphero-auth tests passed');
