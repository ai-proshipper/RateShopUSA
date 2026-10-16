/**
 * Canada Post USA EP/XP size and weight limits.
 * Used only after a quote error to decide whether to skip CP (print next cheapest).
 */
import assert from 'node:assert/strict';
import {
  CANADA_POST_US_OVERSIZE_NO_SERVICE_MSG,
  canadaPostUsLengthPlusGirthCm,
  canadaPostUsParcelExceedsShoppedServices,
  canadaPostUsParcelMetricsFromPackage,
  canadaPostUsServiceAccepts,
  sortCanadaPostUsSidesCm,
} from '../src/canada-post-us-limits.js';
import { canadaPostUsShouldSkipOversizeError } from '../src/canada-post-rate.js';
import { isCanadaPostNoService, usaCarriersMissingLandedRates } from '../src/compare-quotes.js';

assert.deepEqual(sortCanadaPostUsSidesCm(50, 100, 50), [100, 50, 50]);

const girthExample = canadaPostUsParcelMetricsFromPackage({
  weight: 5,
  weight_unit: 'kg',
  lengthIn: 100 / 2.54,
  widthIn: 50 / 2.54,
  heightIn: 50 / 2.54,
});
assert.ok(girthExample);
assert.equal(Math.round(canadaPostUsLengthPlusGirthCm(girthExample)), 300);
assert.equal(canadaPostUsServiceAccepts('USA.EP', girthExample), false);
assert.equal(canadaPostUsServiceAccepts('USA.XP', girthExample), false);
assert.equal(
  canadaPostUsParcelExceedsShoppedServices(['USA.EP', 'USA.XP', 'USA.TP'], girthExample),
  true,
);

const okEp = canadaPostUsParcelMetricsFromPackage({
  weightOz: 16,
  lengthIn: 10,
  widthIn: 8,
  heightIn: 4,
});
assert.ok(okEp);
assert.equal(canadaPostUsServiceAccepts('USA.EP', okEp), true);
assert.equal(canadaPostUsServiceAccepts('USA.XP', okEp), true);

const tooHeavy = { weightKg: 31, lengthCm: 30, widthCm: 20, heightCm: 15 };
assert.equal(canadaPostUsServiceAccepts('USA.EP', tooHeavy), false);
assert.equal(canadaPostUsServiceAccepts('USA.XP', tooHeavy), false);

const xpTooLong = { weightKg: 5, lengthCm: 151, widthCm: 20, heightCm: 15 };
assert.equal(canadaPostUsServiceAccepts('USA.XP', xpTooLong), false);
assert.equal(canadaPostUsServiceAccepts('USA.EP', xpTooLong), true);

const oversizeShipment = {
  packages: [
    {
      weight: 5,
      weight_unit: 'kg',
      lengthIn: 100 / 2.54,
      widthIn: 50 / 2.54,
      heightIn: 50 / 2.54,
    },
  ],
};
const okShipment = {
  packages: [{ weightOz: 16, lengthIn: 10, widthIn: 8, heightIn: 4 }],
};

assert.equal(
  canadaPostUsShouldSkipOversizeError(
    'Errors occurred while processing the request.',
    oversizeShipment,
  ),
  true,
);
assert.equal(
  canadaPostUsShouldSkipOversizeError(
    'Errors occurred while processing the request.',
    okShipment,
  ),
  false,
);
assert.equal(
  canadaPostUsShouldSkipOversizeError('This operation was aborted', oversizeShipment),
  false,
);

const oversizeQuote = {
  canadaPost: {
    status: 'no_rate',
    rates: [],
    ratingError: CANADA_POST_US_OVERSIZE_NO_SERVICE_MSG,
  },
  ups: { status: 'ok', rates: [{ landedTotal: 90.95 }] },
  stallion: { status: 'skipped', rates: [] },
};
assert.equal(isCanadaPostNoService(oversizeQuote), true);
assert.deepEqual(usaCarriersMissingLandedRates(oversizeQuote), []);

console.log('canada-post-us-limits tests passed');
