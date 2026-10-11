import { test, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { startApp, stopApp, registerMerchant, authHeaders } from './helpers.js';

/**
 * Webhook Routes Tests
 * Covers Bug D (signature verification) and Bug E (idempotency).
 */

const WEBHOOK_SECRET = 'test-webhook-secret-key';

let base;
let merchant;
let eventCounter = 0;

before(async () => {
  base = await startApp(3103);
  merchant = await registerMerchant(base);
});

after(() => stopApp());

// Every test uses its own event_id so tests do not affect each other
function nextEventId() {
  eventCounter += 1;
  return `evt_test_${Date.now()}_${eventCounter}`;
}

// HMAC-SHA256 of the JSON body, the same way the API verifies it
function sign(body) {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(JSON.stringify(body)).digest('hex');
}

function sendWebhook(body, { signature = sign(body), omitSignature = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (!omitSignature) headers['x-webhook-signature'] = signature;

  return fetch(`${base}/api/webhooks/payment-status`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
}

async function createPaymentId() {
  const res = await fetch(`${base}/api/payments`, {
    method: 'POST',
    headers: authHeaders(merchant.token),
    body: JSON.stringify({ amount: 25.5, currency: 'EUR', customer_email: 'customer@test.com' })
  });
  const data = await res.json();
  return data.data.id;
}

async function getPaymentStatus(id) {
  const res = await fetch(`${base}/api/payments/${id}`, { headers: authHeaders(merchant.token) });
  const data = await res.json();
  return data.data.status;
}

test('Bug D: webhook without a signature is rejected', async () => {
  const id = await createPaymentId();
  const res = await sendWebhook(
    { payment_id: id, status: 'completed', event_id: nextEventId() },
    { omitSignature: true }
  );

  assert.strictEqual(res.status, 401);
  assert.strictEqual(await getPaymentStatus(id), 'pending');
});

test('Bug D: webhook with a fake signature is rejected', async () => {
  const id = await createPaymentId();
  const res = await sendWebhook(
    { payment_id: id, status: 'completed', event_id: nextEventId() },
    { signature: 'fake-signature' }
  );
  const data = await res.json();

  assert.strictEqual(res.status, 401);
  assert.strictEqual(data.error, 'Invalid signature');
  assert.strictEqual(await getPaymentStatus(id), 'pending');
});

test('Bug D: webhook whose body was changed after signing is rejected', async () => {
  const id = await createPaymentId();
  const signedBody = { payment_id: id, status: 'failed', event_id: nextEventId() };
  const tamperedBody = { ...signedBody, status: 'completed' };

  const res = await sendWebhook(tamperedBody, { signature: sign(signedBody) });

  assert.strictEqual(res.status, 401);
  assert.strictEqual(await getPaymentStatus(id), 'pending');
});

test('Bug D: webhook with a valid signature updates the payment', async () => {
  const id = await createPaymentId();
  const res = await sendWebhook({ payment_id: id, status: 'completed', event_id: nextEventId() });
  const data = await res.json();

  assert.strictEqual(res.status, 200);
  assert.strictEqual(data.new_status, 'completed');
  assert.strictEqual(await getPaymentStatus(id), 'completed');
});

test('Bug E: the same event sent twice is processed only once', async () => {
  const id = await createPaymentId();
  const body = { payment_id: id, status: 'completed', event_id: nextEventId() };

  const first = await sendWebhook(body);
  const second = await sendWebhook(body);
  const secondData = await second.json();

  assert.strictEqual(first.status, 200);
  assert.strictEqual(second.status, 200);
  assert.strictEqual(secondData.message, 'Already processed');
});

test('Bug E: replaying an old event does not overwrite the payment status', async () => {
  const id = await createPaymentId();
  const eventId = nextEventId();

  await sendWebhook({ payment_id: id, status: 'completed', event_id: eventId });
  // Same event_id replayed with a different status (a replay attack)
  const replay = await sendWebhook({ payment_id: id, status: 'failed', event_id: eventId });
  const replayData = await replay.json();

  assert.strictEqual(replayData.message, 'Already processed');
  assert.strictEqual(await getPaymentStatus(id), 'completed');
});

test('Bug E: different event_ids for the same payment are both processed', async () => {
  const id = await createPaymentId();

  await sendWebhook({ payment_id: id, status: 'processing', event_id: nextEventId() });
  assert.strictEqual(await getPaymentStatus(id), 'processing');

  await sendWebhook({ payment_id: id, status: 'completed', event_id: nextEventId() });
  assert.strictEqual(await getPaymentStatus(id), 'completed');
});

test('webhook without event_id is rejected', async () => {
  const id = await createPaymentId();
  const res = await sendWebhook({ payment_id: id, status: 'completed' });
  assert.strictEqual(res.status, 400);
});

test('webhook with missing payment_id or status is rejected', async () => {
  const res = await sendWebhook({ event_id: nextEventId() });
  assert.strictEqual(res.status, 400);
});

test('webhook for a payment that does not exist returns 404', async () => {
  const res = await sendWebhook({
    payment_id: 'does-not-exist',
    status: 'completed',
    event_id: nextEventId()
  });
  assert.strictEqual(res.status, 404);
});