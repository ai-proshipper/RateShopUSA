/**
 * Local Express wrapper for USA Rate Shop (standalone tests).
 * Production: CAD RateShopping imports handleUsaGenerateLabel in-process for US dest.
 * Do not register this URL with ShipHero when CAD hosts the shared webhook.
 */
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureLabelsDirectory } from './label-storage.js';
import { verifyShipHeroHmac } from './shiphero-hmac.js';
import { shipHeroErrorResponse } from './shiphero-response.js';
import { handleUsaGenerateLabel } from './usa-webhook-handler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');
const port = Number(process.env.PORT) || 3457;

const app = express();

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'rateshop-usa' });
});

app.use(express.static(publicDir));

async function handleRateShopRequest(req, res) {
  try {
    const rawBodyBytes = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body ?? {}), 'utf8');
    const rawPayload = JSON.parse(rawBodyBytes.toString('utf8') || '{}');

    const verifyHmac = (process.env.SHIPHERO_WEBHOOK_VERIFY_HMAC || '').toLowerCase() === 'true';
    if (verifyHmac) {
      const secret = process.env.SHIPHERO_WEBHOOK_SHARED_SECRET?.trim();
      const ok = verifyShipHeroHmac({
        rawBodyBytes,
        signatureHeader: req.header('x-shiphero-hmac-sha256'),
        secret: secret || '',
      });
      if (!ok) {
        return res.status(401).json(shipHeroErrorResponse('Invalid ShipHero webhook signature', '401'));
      }
    }

    const forwardHeaders = {};
    const hmac = req.header('x-shiphero-hmac-sha256');
    if (hmac) forwardHeaders['x-shiphero-hmac-sha256'] = hmac;
    const fwdProto = req.header('x-forwarded-proto') || req.protocol;
    const fwdHost = req.header('host');
    if (fwdProto) forwardHeaders['x-forwarded-proto'] = fwdProto;
    if (fwdHost) forwardHeaders['x-forwarded-host'] = fwdHost;

    const result = await handleUsaGenerateLabel(rawPayload, forwardHeaders);
    res.status(200).type('application/json').json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).type('application/json').json(shipHeroErrorResponse(message, '500'));
  }
}

const webhookRouter = express.Router();
webhookRouter.use(express.raw({ type: 'application/json' }));
webhookRouter.head('/label', (_req, res) => res.status(200).end());
webhookRouter.post('/label', handleRateShopRequest);
app.use('/webhook/shiphero', webhookRouter);

ensureLabelsDirectory()
  .then(() => {
    app.listen(port, () => {
      console.log(`[rateshop-usa] local test server http://localhost:${port}`);
      console.log(`[rateshop-usa] POST /webhook/shiphero/label  QUOTE_ONLY=${process.env.QUOTE_ONLY ?? 'true'}`);
    });
  })
  .catch((err) => {
    console.error('[rateshop-usa] failed to start', err);
    process.exit(1);
  });
