import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startApp, stopApp, registerMerchant, authHeaders } from './helpers.js';

/**
 * Table Order Routes Tests
 * Covers Bug F (duplicate pending order for the same table).
 */

let base;
let merchant;
let otherMerchant;

before(async () => {
  base = await startApp(3104);
  merchant = await registerMerchant(base);
  otherMerchant = await registerMerchant(base);
});

after(() => stopApp());

function orderBody(tableNumber, overrides = {}) {
  return {
    merchant_id: merchant.id,
    table_number: tableNumber,
    items: [{ name: 'Pizza', quantity: 1, price: 10 }],
    customer_name: 'Test',
    order_type: 'dine_in',
    ...overrides
  };
}

function createOrder(body) {
  return fetch(`${base}/api/table-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function updateStatus(orderId, status, token = merchant.token) {
  return fetch(`${base}/api/table-orders/${orderId}/status`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({ status })
  });
}

test('creating a table order succeeds', async () => {
  const res = await createOrder(orderBody(11));
  const data = await res.json();

  assert.strictEqual(res.status, 201);
  assert.strictEqual(data.data.status, 'pending');
  assert.strictEqual(data.data.table_number, 11);
});

test('Bug F: a second order for a table with a pending order is rejected', async () => {
  const first = await createOrder(orderBody(12));
  const second = await createOrder(orderBody(12));
  const secondData = await second.json();

  assert.strictEqual(first.status, 201);
  assert.strictEqual(second.status, 409);
  assert.strictEqual(secondData.error, 'Table already has a pending order');
});

test('Bug F: a rejected duplicate does not create a second order', async () => {
  await createOrder(orderBody(13));
  await createOrder(orderBody(13));

  const res = await fetch(`${base}/api/table-orders`, { headers: authHeaders(merchant.token) });
  const data = await res.json();
  const ordersForTable = data.data.filter((o) => o.table_number === 13);

  assert.strictEqual(ordersForTable.length, 1);
});

test('Bug F: different tables can each have a pending order', async () => {
  const a = await createOrder(orderBody(14));
  const b = await createOrder(orderBody(15));

  assert.strictEqual(a.status, 201);
  assert.strictEqual(b.status, 201);
});

test('Bug F: a table can be ordered again once its order is no longer pending', async () => {
  const first = await (await createOrder(orderBody(16))).json();

  const update = await updateStatus(first.data.id, 'served');
  assert.strictEqual(update.status, 200);

  const second = await createOrder(orderBody(16));
  assert.strictEqual(second.status, 201);
});

test('Bug F: the same table number for a different merchant is allowed', async () => {
  const mine = await createOrder(orderBody(17));
  const theirs = await createOrder(orderBody(17, { merchant_id: otherMerchant.id }));

  assert.strictEqual(mine.status, 201);
  assert.strictEqual(theirs.status, 201);
});

test('order total is calculated from price and quantity', async () => {
  const res = await createOrder(
    orderBody(18, {
      items: [
        { name: 'Pizza', quantity: 2, price: 10 },
        { name: 'Cola', quantity: 1, price: 5 }
      ]
    })
  );
  const data = await res.json();

  assert.strictEqual(res.status, 201);
  assert.strictEqual(data.data.total, 25);
});

test('order with an empty items list is rejected', async () => {
  const res = await createOrder(orderBody(19, { items: [] }));
  assert.strictEqual(res.status, 400);
});

test('order with missing required fields is rejected', async () => {
  const res = await createOrder({ merchant_id: merchant.id });
  assert.strictEqual(res.status, 400);
});

test('updating an order with an invalid status is rejected', async () => {
  const created = await (await createOrder(orderBody(20))).json();
  const res = await updateStatus(created.data.id, 'not-a-real-status');
  assert.strictEqual(res.status, 400);
});

test("a merchant cannot change another merchant's order status", async () => {
  const created = await (await createOrder(orderBody(21))).json();
  const res = await updateStatus(created.data.id, 'served', otherMerchant.token);
  assert.strictEqual(res.status, 403);
});