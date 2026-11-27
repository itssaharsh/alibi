import { context, trace, SpanStatusCode } from '@opentelemetry/api';
import express from 'express';
import pg from 'pg';
import { DefaultFlag, Flagsmith } from 'flagsmith-nodejs';
import { evaluateFlag, inSpan, runFlagged } from '@alibi/otel-helpers';
import { stableCoupon, stablePrice, v2Coupon, v2Price } from './pricing.js';

const FLAG = 'checkout_v2';
const STABLE = 'stable';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 2000);

class RequestTimeout extends Error {
  constructor(ms) {
    super(`The request took longer than ${ms} ms`);
    this.name = 'RequestTimeout';
  }
}

const pool = new pg.Pool({
  connectionString: process.env.SHOP_DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 1500,
  idleTimeoutMillis: 30000,
});
pool.on('error', (error) => console.error(`shop-db connection lost: ${error.message}`));

// A plain flag read. If Flagsmith cannot answer, the SDK serves this default: the stable checkout.
const flagsmith = new Flagsmith({
  environmentKey: process.env.FLAGSMITH_SERVER_KEY,
  apiUrl: process.env.FLAGSMITH_API_URL,
  requestTimeoutSeconds: 1.5,
  enableAnalytics: false,
  defaultFlagHandler: () => new DefaultFlag(STABLE, false),
});

const tracer = trace.getTracer('shop');
const app = express();
app.use(express.json());

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// The server's own time limit. It answers from outside the flagged path and leaves its own error span.
app.use((req, res, next) => {
  const parent = context.active();
  const timer = setTimeout(() => {
    if (res.headersSent) return;
    req.timedOut = true;
    const span = tracer.startSpan('request_timeout', {}, parent);
    const error = new RequestTimeout(REQUEST_TIMEOUT_MS);
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.end();
    res.status(504).json({ error: error.name, message: error.message, checkout: req.checkout ?? null });
  }, REQUEST_TIMEOUT_MS);
  res.on('close', () => clearTimeout(timer));
  next();
});

function stillWanted(req) {
  if (req.timedOut) throw new RequestTimeout(REQUEST_TIMEOUT_MS);
}

async function loadProducts() {
  return inSpan('load_products', {}, async () => {
    const { rows } = await pool.query('SELECT sku, name, category, price_cents FROM products ORDER BY sku');
    return rows;
  });
}

async function writeOrder({ userId, checkout, coupon, total, items }) {
  return inSpan('write_order', {}, async () => {
    const { rows } = await pool.query(
      'INSERT INTO orders (user_id, checkout, coupon, total_cents, items) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [userId, checkout, coupon, total, JSON.stringify(items)],
    );
    return rows[0].id;
  });
}

async function runStable(items, coupon, catalogue, bySku) {
  const subtotal = await stablePrice(items, bySku);
  return stableCoupon(subtotal, coupon);
}

async function runV2(items, coupon, catalogue, bySku) {
  return runFlagged(FLAG, FLAG, async () => {
    const subtotal = await v2Price(items, catalogue, bySku);
    return v2Coupon(subtotal, coupon);
  });
}

app.post('/checkout', async (req, res) => {
  const { userId, items, coupon = null } = req.body ?? {};
  const valid =
    typeof userId === 'string' &&
    Array.isArray(items) &&
    items.length > 0 &&
    items.every((i) => typeof i?.sku === 'string' && Number.isInteger(i.qty) && i.qty > 0) &&
    (coupon === null || typeof coupon === 'string');
  if (!valid) {
    res.status(400).json({ error: 'BadRequest', message: 'Send userId, items [{sku, qty}] and an optional coupon.' });
    return;
  }

  try {
    const body = await inSpan('checkout', { 'enduser.id': userId }, async () => {
      const variation = await evaluateFlag({ flagsmith, flag: FLAG, userId, fallback: STABLE });
      req.checkout = variation;
      stillWanted(req);

      const catalogue = await loadProducts();
      stillWanted(req);
      const bySku = new Map(catalogue.map((p) => [p.sku, p]));

      const total = await (variation === STABLE ? runStable : runV2)(items, coupon, catalogue, bySku);
      stillWanted(req);

      const orderId = await writeOrder({ userId, checkout: req.checkout, coupon, total, items });
      return { orderId, checkout: req.checkout, totalCents: total };
    });
    if (!res.headersSent) res.json(body);
  } catch (error) {
    if (res.headersSent) return;
    res.status(500).json({ error: error.name, message: error.message, checkout: req.checkout ?? null });
  }
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => console.log(`shop listening on ${port}`));
