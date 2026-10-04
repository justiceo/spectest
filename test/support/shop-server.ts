// Stateful mock of test/fixtures/arazzo/shop.openapi.yaml (served under /api).
import { startMockServer, type MockServer, type RecordedRequest, type MockReply } from './harness.js';

export interface ShopOptions {
  /** GET /payments/{id} reports `processing` this many times before `succeeded`. */
  pollsUntilSucceeded?: number;
  /** GET /flaky answers 503 (Retry-After: 0) this many times first. */
  flakyFailures?: number;
}

const products = [
  { id: 1, name: 'Dalmatian', price: 300, tags: ['puppy', 'spotty'] },
  { id: 2, name: 'Tabby', price: 120, tags: ['kitten'] },
  { id: 3, name: 'Goldfish', price: 5, tags: [] },
];

export async function startShopServer(options: ShopOptions = {}): Promise<MockServer> {
  let orderSeq = 0;
  let paymentSeq = 0;
  let flakyCalls = 0;
  const orders = new Map<string, any>();
  const payments = new Map<string, any>();
  const idempotency = new Map<string, string>();
  const authorized = (req: RecordedRequest) => /^Bearer (tok-|cc-token|refreshed-)/.test(String(req.headers.authorization || ''));

  const handler = (req: RecordedRequest): MockReply => {
    const route = req.path.replace(/^\/api/, '');
    const parts = route.split('/').filter(Boolean);
    const form = () => new URLSearchParams(req.body);

    if (req.method === 'POST' && route === '/auth/login') {
      const { username, password } = req.json || {};
      if (password !== 'secret') return { status: 401, json: { error: 'bad credentials' } };
      return { status: 200, headers: { 'X-Session-Expires': '3600' }, json: { token: `tok-${username}`, refreshToken: 'ref-1' } };
    }
    if (req.method === 'POST' && route === '/oauth/token') {
      const body = form();
      if (body.get('grant_type') === 'client_credentials' && body.get('client_id') === 'id' && body.get('client_secret') === 'sec') {
        return { json: { access_token: 'cc-token', token_type: 'bearer' } };
      }
      if (body.get('grant_type') === 'refresh_token' && body.get('refresh_token')) {
        return { json: { access_token: `refreshed-${body.get('refresh_token')}`, token_type: 'bearer' } };
      }
      return { status: 400, json: { error: 'invalid_grant' } };
    }
    if (req.method === 'GET' && route === '/me') {
      if (!authorized(req)) return { status: 401, json: { error: 'unauthorized' } };
      return { json: { id: 1, email: 'ada@example.com' } };
    }
    if (req.method === 'GET' && route === '/products') {
      const tags = req.query.getAll('tag');
      const list = tags.length ? products.filter((p) => p.tags.some((t) => tags.includes(t))) : products;
      return { json: list };
    }
    if (req.method === 'GET' && parts[0] === 'products' && parts.length === 2) {
      const product = products.find((p) => String(p.id) === parts[1]);
      return product ? { json: product } : { status: 404, json: { error: 'not found' } };
    }
    if (req.method === 'GET' && route === '/search') {
      return { json: { query: req.url.split('?')[1] || '', params: Object.fromEntries(req.query) } };
    }
    if (req.method === 'POST' && route === '/orders') {
      if (!authorized(req)) return { status: 401, json: { error: 'unauthorized' } };
      const { productId, quantity, couponCode } = req.json || {};
      const product = products.find((p) => p.id === productId);
      if (!product || typeof quantity !== 'number') return { status: 400, json: { error: 'invalid order' } };
      const id = `ord-${++orderSeq}`;
      const order = { id, productId, quantity, couponCode: couponCode ?? null, status: 'placed', total: product.price * quantity };
      orders.set(id, order);
      return { status: 201, headers: { Location: `/api/orders/${id}` }, json: order };
    }
    if (parts[0] === 'orders' && parts.length === 2) {
      const order = orders.get(parts[1]);
      if (req.method === 'GET') return order ? { json: order } : { status: 404, json: { error: 'not found' } };
      if (req.method === 'DELETE') {
        orders.delete(parts[1]);
        return { status: 204 };
      }
    }
    if (req.method === 'POST' && route === '/payments') {
      const key = String(req.headers['idempotency-key'] || '');
      if (!key) return { status: 400, json: { error: 'missing Idempotency-Key' } };
      if (idempotency.has(key)) return { status: 201, json: payments.get(idempotency.get(key)!) };
      const { orderId, amount } = req.json || {};
      if (amount > 1000) return { status: 402, json: { error: 'declined' } };
      const id = `pay-${++paymentSeq}`;
      const payment = { id, orderId, amount, status: 'processing', polls: 0 };
      payments.set(id, payment);
      idempotency.set(key, id);
      return { status: 201, json: { id, orderId, amount, status: 'processing' } };
    }
    if (parts[0] === 'payments' && parts.length === 2 && req.method === 'GET') {
      const payment = payments.get(parts[1]);
      if (!payment) return { status: 404, json: { error: 'not found' } };
      payment.polls += 1;
      if (payment.status === 'processing' && payment.polls >= (options.pollsUntilSucceeded ?? 2)) payment.status = 'succeeded';
      return { json: { id: payment.id, orderId: payment.orderId, amount: payment.amount, status: payment.status } };
    }
    if (parts[0] === 'payments' && parts[2] === 'refunds' && req.method === 'POST') {
      const payment = payments.get(parts[1]);
      if (!payment) return { status: 404, json: { error: 'not found' } };
      payment.status = 'refunded';
      return { status: 201, json: { id: `ref-${payment.id}`, status: 'refunded' } };
    }
    if (req.method === 'GET' && route === '/flaky') {
      flakyCalls += 1;
      if (flakyCalls <= (options.flakyFailures ?? 2)) return { status: 503, headers: { 'Retry-After': '0' }, text: '' };
      return { json: { ok: true, calls: flakyCalls } };
    }
    if (req.method === 'GET' && route === '/inventory') {
      return {
        headers: { 'content-type': 'application/xml' },
        text: '<inventory><item sku="A"><qty>3</qty></item><item sku="B"><qty>0</qty></item></inventory>',
      };
    }
    if (req.method === 'POST' && route === '/xml/echo') {
      return { headers: { 'content-type': 'application/xml' }, text: req.body };
    }
    if (req.method === 'POST' && route === '/echo') {
      return {
        json: {
          contentType: req.headers['content-type'] || null,
          headers: { cookie: req.headers.cookie || null, 'x-trace': req.headers['x-trace'] || null },
          query: Object.fromEntries(req.query),
          body: req.json ?? req.body,
        },
      };
    }
    if (req.method === 'GET' && route === '/undocumented-status') {
      return { status: 418, json: { error: 'teapot' } };
    }
    return { status: 404, json: { error: `no route ${req.method} ${req.path}` } };
  };
  return startMockServer(handler);
}
