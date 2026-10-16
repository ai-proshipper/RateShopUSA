import assert from 'node:assert/strict';
import {
  FREAK_ATHLETE_ACCOUNT_ID,
  FREAK_ATHLETE_MAX_LABEL_COST,
  MAX_LABEL_COST,
  isFreakAthleteClient,
  maxLabelCostForRequest,
  shipHeroAccountId,
} from '../src/config.js';
import { assertLabelCostAllowed } from '../src/shiphero-response.js';

assert.equal(FREAK_ATHLETE_MAX_LABEL_COST, 200);
assert.equal(FREAK_ATHLETE_ACCOUNT_ID, '100970');
assert.ok(MAX_LABEL_COST <= FREAK_ATHLETE_MAX_LABEL_COST);

assert.equal(shipHeroAccountId('QWNjb3VudDoxMDA5NzA='), '100970');
assert.equal(isFreakAthleteClient({ account_id: 100970 }), true);
assert.equal(isFreakAthleteClient({ account_id: 79902 }), false);
assert.equal(maxLabelCostForRequest({ account_id: 100970 }), 200);
assert.equal(maxLabelCostForRequest({ account_id: 79902 }), MAX_LABEL_COST);

assert.doesNotThrow(() => assertLabelCostAllowed(150, maxLabelCostForRequest({})));
assert.throws(
  () => assertLabelCostAllowed(MAX_LABEL_COST + 0.01, maxLabelCostForRequest({})),
  /Label cost too high/,
);
assert.doesNotThrow(() =>
  assertLabelCostAllowed(200, maxLabelCostForRequest({ account_id: 100970 })),
);
assert.throws(
  () => assertLabelCostAllowed(200.01, maxLabelCostForRequest({ account_id: 100970 })),
  /Label cost too high/,
);

console.log('test-max-label-cost: ok');
