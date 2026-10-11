import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startApp, stopApp, registerMerchant } from './helpers.js';

/**
 * Auth Routes Tests
 * Covers Bug C (email validation) plus basic register/login behaviour.
 */

let base;
let merchant;

before(async () => {
  base = await startApp(3102);
  merchant = await registerMerchant(base);
});

after(() => stopApp());

function post(path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function register(email, overrides = {}) {
  return post('/api/auth/register', {
    email,
    password: 'SecurePass123!',
    business_name: 'Test Co',
    ...overrides
  });
}

test('Bug C: register rejects an email without a domain extension (user@domain)', async () => {
  const res = await register('user@domain');
  const data = await res.json();

  assert.strictEqual(res.status, 400);
  assert.strictEqual(data.error, 'Invalid email format');
});

test('Bug C: register rejects an email ending with a dot (user@domain.)', async () => {
  const res = await register('user@domain.');
  assert.strictEqual(res.status, 400);
});

test('register rejects an email without @', async () => {
  const res = await register('userdomain.com');
  assert.strictEqual(res.status, 400);
});

test('Bug C: register still accepts a valid email', async () => {
  const res = await register(`valid-${Date.now()}@test.com`);
  const data = await res.json();

  assert.strictEqual(res.status, 201);
  assert.ok(data.token);
});

test('register rejects a password shorter than 8 characters', async () => {
  const res = await register(`short-${Date.now()}@test.com`, { password: 'abc' });
  assert.strictEqual(res.status, 400);
});

test('register rejects a missing business name', async () => {
  const res = await register(`nobiz-${Date.now()}@test.com`, { business_name: '' });
  assert.strictEqual(res.status, 400);
});

test('register rejects an email that is already registered', async () => {
  const res = await register(merchant.email);
  assert.strictEqual(res.status, 409);
});

test('login with correct credentials returns a token', async () => {
  const res = await post('/api/auth/login', {
    email: merchant.email,
    password: 'SecurePass123!'
  });
  const data = await res.json();

  assert.strictEqual(res.status, 200);
  assert.ok(data.token);
});

test('login with a wrong password is rejected', async () => {
  const res = await post('/api/auth/login', {
    email: merchant.email,
    password: 'WrongPassword!'
  });
  assert.strictEqual(res.status, 401);
});

test('login with an unknown email is rejected', async () => {
  const res = await post('/api/auth/login', {
    email: 'nobody@test.com',
    password: 'SecurePass123!'
  });
  assert.strictEqual(res.status, 401);
});