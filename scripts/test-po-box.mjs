import assert from 'node:assert/strict';
import {
  pickBuyableWinner,
  pickPoBoxWinner,
  usaCarriersMissingLandedRates,
  usaIncompleteShopError,
  CANADA_POST_QUOTE_TIMEOUT_MSG,
} from '../src/compare-quotes.js';
import {
  canadaPostPoBoxUnavailableMessage,
  isPoBoxAddress,
  shipmentGoesToPoBox,
  textLooksLikePoBox,
} from '../src/po-box.js';

assert.equal(isPoBoxAddress({ address1: '123 Main St' }), false);
assert.equal(isPoBoxAddress({ address1: 'Unit 5, 88 King St W' }), false);
assert.equal(isPoBoxAddress({ address1: 'PO Box 123' }), true);
assert.equal(isPoBoxAddress({ address1: 'P.O. Box 45' }), true);
assert.equal(isPoBoxAddress({ address1: 'p.o.box 9' }), true);
assert.equal(isPoBoxAddress({ address1: 'Post Office Box 200' }), true);
assert.equal(isPoBoxAddress({ address1: 'POBOX 77' }), true);
assert.equal(isPoBoxAddress({ address1: '12 Queen St', address2: 'PO Box 8' }), true);
assert.equal(isPoBoxAddress({ address1: 'c/o Warehouse', company: 'PO Box 11' }), true);
assert.equal(isPoBoxAddress({ address1: 'Case postale 44' }), true);
assert.equal(isPoBoxAddress({ address1: 'C.P. 321' }), true);
assert.equal(isPoBoxAddress({ address1: 'CP 99' }), true);
assert.equal(textLooksLikePoBox('Boite postale 12'), true);
assert.equal(
  isPoBoxAddress({ address1: '27 HIGHVIEW RD', address2: 'BOX 620' }),
  true,
);
assert.equal(isPoBoxAddress({ address1: 'Box #45' }), true);
assert.equal(textLooksLikePoBox('BOX620'), true);

assert.equal(isPoBoxAddress({ address1: 'CP Rail Yard' }), false);
assert.equal(isPoBoxAddress({ address1: 'Box Elder Lane' }), false);
assert.equal(isPoBoxAddress({ address1: 'Boxwood 12' }), false);
assert.equal(isPoBoxAddress({ address1: 'Porto Street' }), false);
assert.equal(isPoBoxAddress({ address1: '' }), false);
assert.equal(isPoBoxAddress(null), false);
assert.equal(shipmentGoesToPoBox({ to: { address1: 'PO Box 4' } }), true);
assert.equal(shipmentGoesToPoBox({ to: { address1: '88 King St' } }), false);

const streetShop = {
  ups: { status: 'ok', rates: [{ landedTotal: 12, shipping: 12 }] },
  canadaPost: { status: 'ok', rates: [{ landedTotal: 14, shipping: 14 }] },
};
assert.deepEqual(usaCarriersMissingLandedRates(streetShop), []);

const poBoxShop = {
  poBox: true,
  stallion: { status: 'skipped', rates: [], message: 'PO Box — Canada Post only' },
  ups: { status: 'skipped', rates: [] },
  canadaPost: {
    status: 'ok',
    rates: [{ landedTotal: 18, shipping: 12, duty: 6, duty_source: 'api' }],
  },
};
assert.deepEqual(usaCarriersMissingLandedRates(poBoxShop), []);

const poBoxNoService = {
  poBox: true,
  ups: { status: 'skipped', rates: [] },
  canadaPost: {
    status: 'no_rate',
    rates: [],
    ratingError: 'No service for this destination',
  },
};
assert.deepEqual(usaCarriersMissingLandedRates(poBoxNoService), ['Canada Post']);
assert.equal(
  usaIncompleteShopError(poBoxNoService, []),
  canadaPostPoBoxUnavailableMessage(poBoxNoService.canadaPost),
);
assert.match(
  usaIncompleteShopError(poBoxNoService, [
    { carrier: 'UPS', service: 'UPS Standard', landedTotal: 10, printCost: 10 },
  ]),
  /PO Box shipment, so Canada Post is required/,
);

const poBoxTimeout = {
  poBox: true,
  ups: { status: 'skipped', rates: [] },
  canadaPost: { status: 'error', rates: [], ratingError: 'This operation was aborted' },
};
assert.equal(usaIncompleteShopError(poBoxTimeout, []), CANADA_POST_QUOTE_TIMEOUT_MSG);

const ranked = [
  { carrier: 'UPS', serviceCode: '11', landedTotal: 10, shipping: 10 },
  { carrier: 'Stallion', serviceCode: 'USPS', lastMileCarrier: 'USPS', trackable: true, landedTotal: 12, shipping: 12 },
  { carrier: 'Canada Post', serviceCode: 'USA.EP', landedTotal: 20, shipping: 16 },
];
assert.equal(pickBuyableWinner(ranked).carrier, 'UPS');
assert.equal(pickPoBoxWinner(ranked).carrier, 'Canada Post');
assert.equal(pickPoBoxWinner(ranked).serviceCode, 'USA.EP');
assert.equal(pickPoBoxWinner([{ carrier: 'UPS', serviceCode: '11', landedTotal: 10 }]), null);

console.log('test-po-box: ok');
