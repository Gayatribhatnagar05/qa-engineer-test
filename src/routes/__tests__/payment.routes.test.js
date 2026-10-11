import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startApp, stopApp, registerMerchant, authHeaders } from './helpers.js';

/**
 * Payment Routes Tests
 * Covers Bug A (amount returned as a number) and Bug B (maximum amount).
 */

let base;
let merchant;

const validPayment = {
  amount: 25.5,
  currency: 'EUR',
  customer_email: 'customer@test.com'
};

before(async () => {
  base = await startApp(3101);
  merchant = await registerMerchant(base);
});

after(() => stopApp());

function createPayment(body, headers = authHeaders(merchant.token)) {
  return fetch(`${base}/api/payments`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
}

test('Bug A: GET /payments returns amount as a number', async () => {
  await createPayment(validPayment);

  const res = await fetch(`${base}/api/payments`, { headers: authHeaders(merchant.token) });
  const data = await res.json();

  assert.strictEqual(res.status, 200);
  assert.strictEqual(typeof data.data[0].amount, 'number');
  assert.strictEqual(data.data[0].amount, 25.5);
});

test('Bug A: GET /payments/:id returns amount as a number', async () => {
  const created = await (await createPayment(validPayment)).json();

  const res = await fetch(`${base}/api/payments/${created.data.id}`, {
    headers: authHeaders(merchant.token)
  });
  const data = await res.json();

  assert.strictEqual(res.status, 200);
  assert.strictEqual(typeof data.data.amount, 'number');
});

test('POST /payments with valid data creates a payment', async () => {
  const res = await createPayment(validPayment);
  const data = await res.json();

  assert.strictEqual(res.status, 201);
  assert.strictEqual(data.data.status, 'pending');
  assert.strictEqual(data.data.amount, 25.5);
});

test('Bug B: POST /payments rejects an amount over 50,000', async () => {
  const res = await createPayment({ ...validPayment, amount: 999999999 });
  const data = await res.json();

  assert.strictEqual(res.status, 400);
  assert.ok(data.error.includes('maximum'));
});

test('Bug B: POST /payments rejects an amount just over the limit', async () => {
  const res = await createPayment({ ...validPayment, amount: 50000.01 });
  assert.strictEqual(res.status, 400);
});

test('Bug B: POST /payments accepts exactly 50,000 (boundary)', async () => {
  const res = await createPayment({ ...validPayment, amount: 50000 });
  assert.strictEqual(res.status, 201);
});

test('POST /payments rejects a negative amount', async () => {
  const res = await createPayment({ ...validPayment, amount: -10 });
  assert.strictEqual(res.status, 400);
});

test('POST /payments rejects a zero amount', async () => {
  const res = await createPayment({ ...validPayment, amount: 0 });
  assert.strictEqual(res.status, 400);
});

test('POST /payments without authentication is rejected', async () => {
  const res = await createPayment(validPayment, { 'Content-Type': 'application/json' });
  assert.ok([401, 403].includes(res.status));
});