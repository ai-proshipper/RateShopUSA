/**
 * US customs attachment helpers — does not touch CAD Rate Shop.
 */
import assert from 'node:assert/strict';
import { usaAttachCustomsToOrder } from '../src/config.js';
import { normalizeShipHeroLabelResponse } from '../src/shiphero-response.js';
import {
  attachUsaCustomsToOrder,
  attachmentFileType,
  sanitizeAttachmentFilename,
  shipHeroGraphqlOrderId,
} from '../src/shiphero-order-attachment.js';

const savedToken = process.env.SHIPHERO_API_TOKEN;
const savedRefresh = process.env.SHIPHERO_REFRESH_TOKEN;
const savedAttach = process.env.USA_ATTACH_CUSTOMS_TO_ORDER;

function restoreEnv() {
  if (savedToken === undefined) delete process.env.SHIPHERO_API_TOKEN;
  else process.env.SHIPHERO_API_TOKEN = savedToken;
  if (savedRefresh === undefined) delete process.env.SHIPHERO_REFRESH_TOKEN;
  else process.env.SHIPHERO_REFRESH_TOKEN = savedRefresh;
  if (savedAttach === undefined) delete process.env.USA_ATTACH_CUSTOMS_TO_ORDER;
  else process.env.USA_ATTACH_CUSTOMS_TO_ORDER = savedAttach;
}

assert.equal(shipHeroGraphqlOrderId('242662901'), Buffer.from('Order:242662901', 'utf8').toString('base64'));
assert.equal(shipHeroGraphqlOrderId(' 242662901 '), Buffer.from('Order:242662901', 'utf8').toString('base64'));
assert.equal(shipHeroGraphqlOrderId('T3JkZXI6NzUwNzc0MTY0'), 'T3JkZXI6NzUwNzc0MTY0');
assert.equal(shipHeroGraphqlOrderId(''), '');
assert.equal(shipHeroGraphqlOrderId(null), '');

assert.equal(sanitizeAttachmentFilename('1ZAC88906737322485'), '1ZAC88906737322485-customs');
assert.equal(sanitizeAttachmentFilename('1Z#foo@(bar)'), '1Z_foo__bar_-customs');
assert.equal(sanitizeAttachmentFilename(''), 'usa-customs');

assert.equal(attachmentFileType('png'), 'image/png');
assert.equal(attachmentFileType('pdf'), 'application/pdf');
assert.equal(attachmentFileType(''), 'application/pdf');

const webhook = normalizeShipHeroLabelResponse({
  shipping_method: 'UPS Worldwide Expedited',
  shipping_carrier: 'ups',
  tracking_number: '1ZAC88906737322485',
  cost: '34.42',
  label: 'https://example.com/labels/1ZAC88906737322485.pdf',
  tracking_url: 'https://www.ups.com/track?tracknum=1ZAC88906737322485',
  customs_info: '',
});
assert.equal(webhook.customs_info, '');
assert.match(webhook.label, /\.pdf$/);

process.env.USA_ATTACH_CUSTOMS_TO_ORDER = 'true';
delete process.env.SHIPHERO_API_TOKEN;
delete process.env.SHIPHERO_REFRESH_TOKEN;
let fetchCalls = 0;
const skipToken = await attachUsaCustomsToOrder(
  { orderId: '1', customsUrl: 'https://example.com/a-customs.pdf', tracking: '1Z' },
  { fetchImpl: async () => { fetchCalls += 1; throw new Error('should not fetch'); } },
);
assert.equal(skipToken.skipped, true);
assert.equal(skipToken.reason, 'missing_token');
assert.equal(fetchCalls, 0);

const skipUrl = await attachUsaCustomsToOrder(
  { orderId: '1', customsUrl: '', tracking: '1Z' },
  { fetchImpl: async () => { fetchCalls += 1; throw new Error('should not fetch'); } },
);
assert.equal(skipUrl.skipped, true);
assert.equal(skipUrl.reason, 'missing_order_or_url');

process.env.SHIPHERO_API_TOKEN = 'test-token';
process.env.USA_ATTACH_CUSTOMS_TO_ORDER = 'false';
const skipOff = await attachUsaCustomsToOrder(
  { orderId: '1', customsUrl: 'https://example.com/a-customs.pdf', tracking: '1Z' },
  { fetchImpl: async () => { fetchCalls += 1; throw new Error('should not fetch'); } },
);
assert.equal(skipOff.skipped, true);
assert.equal(skipOff.reason, 'disabled');
assert.equal(usaAttachCustomsToOrder(), false);

process.env.USA_ATTACH_CUSTOMS_TO_ORDER = 'true';
const ok = await attachUsaCustomsToOrder(
  {
    orderId: '242662901',
    customsUrl: 'https://example.com/labels/1Z-customs.pdf',
    tracking: '1ZAC88906737322485',
    fileType: 'pdf',
  },
  {
    fetchImpl: async (_url, init) => {
      fetchCalls += 1;
      const payload = JSON.parse(init.body);
      assert.equal(payload.variables.data.order_id, shipHeroGraphqlOrderId('242662901'));
      assert.equal(payload.variables.data.filename, '1ZAC88906737322485-customs');
      assert.equal(payload.variables.data.file_type, 'application/pdf');
      assert.equal(payload.variables.data.url, 'https://example.com/labels/1Z-customs.pdf');
      return {
        status: 200,
        json: async () => ({
          errors: [{ message: "Int cannot represent non-integer value: ''" }],
          data: {
            order_add_attachment: {
              attachment: { id: 'T3JkZXJBdHRhY2htZW50OjE=', filename: '1ZAC88906737322485-customs' },
            },
          },
        }),
      };
    },
  },
);
assert.equal(ok.ok, true);
assert.equal(ok.attachmentId, 'T3JkZXJBdHRhY2htZW50OjE=');
assert.equal(fetchCalls, 1);

restoreEnv();
console.log('usa customs-attachment tests passed');
