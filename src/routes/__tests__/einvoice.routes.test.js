import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startApp, stopApp, registerMerchant, authHeaders } from './helpers.js';

/**
 * E-Invoice Routes Tests
 * Covers Bug G (the same invoice must not be submitted twice).
 */

const VALID_SIRET = '12345678901234';

let base;
let merchant;
let invoiceCounter = 0;

before(async () => {
  base = await startApp(3105);
  merchant = await registerMerchant(base);
});

after(() => stopApp());

// Every test uses its own invoice id so tests do not affect each other
function nextInvoiceId() {
  invoiceCounter += 1;
  return `INV-TEST-${Date.now()}-${invoiceCounter}`;
}

function submit(body, headers = authHeaders(merchant.token)) {
  return fetch(`${base}/api/einvoice/submit`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
}

test('submitting a new invoice succeeds', async () => {
  const res = await submit({ invoice_id: nextInvoiceId(), customer_siret: VALID_SIRET });
  const data = await res.json();

  assert.strictEqual(res.status, 200);
  assert.strictEqual(data.data.status, 'submitted');
  assert.ok(data.data.submission_id.startsWith('SUB-'));
});

test('Bug G: submitting the same invoice twice is rejected', async () => {
  const body = { invoice_id: nextInvoiceId(), customer_siret: VALID_SIRET };

  const first = await submit(body);
  const second = await submit(body);
  const secondData = await second.json();

  assert.strictEqual(first.status, 200);
  assert.strictEqual(second.status, 409);
  assert.strictEqual(secondData.error, 'Invoice already submitted to tax authority');
});

test('Bug G: a rejected duplicate keeps the original submission id', async () => {
  const body = { invoice_id: nextInvoiceId(), customer_siret: VALID_SIRET };

  const first = await (await submit(body)).json();
  await submit(body);

  const statusRes = await fetch(`${base}/api/einvoice/status/${body.invoice_id}`, {
    headers: authHeaders(merchant.token)
  });
  const statusData = await statusRes.json();

  assert.strictEqual(statusData.data.submission_id, first.data.submission_id);
  assert.strictEqual(statusData.data.einvoice_status, 'submitted');
});

test('Bug G: different invoices can each be submitted', async () => {
  const a = await submit({ invoice_id: nextInvoiceId(), customer_siret: VALID_SIRET });
  const b = await submit({ invoice_id: nextInvoiceId(), customer_siret: VALID_SIRET });

  assert.strictEqual(a.status, 200);
  assert.strictEqual(b.status, 200);
});

test('submission without an invoice_id is rejected', async () => {
  const res = await submit({ customer_siret: VALID_SIRET });
  assert.strictEqual(res.status, 400);
});

test('submission with a SIRET that is not 14 digits is rejected', async () => {
  const res = await submit({ invoice_id: nextInvoiceId(), customer_siret: '12345' });
  assert.strictEqual(res.status, 400);
});

test('submission without a SIRET is rejected', async () => {
  const res = await submit({ invoice_id: nextInvoiceId() });
  assert.strictEqual(res.status, 400);
});

test('submission without authentication is rejected', async () => {
  const res = await submit(
    { invoice_id: nextInvoiceId(), customer_siret: VALID_SIRET },
    { 'Content-Type': 'application/json' }
  );
  assert.ok([401, 403].includes(res.status));
});

test('status of an invoice that was never submitted returns 404', async () => {
  const res = await fetch(`${base}/api/einvoice/status/INV-DOES-NOT-EXIST`, {
    headers: authHeaders(merchant.token)
  });
  assert.strictEqual(res.status, 404);
});