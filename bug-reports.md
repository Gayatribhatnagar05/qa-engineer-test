# Bug Reports

**Tester:** Gayatri
**Environment:** Node.js v24.16.0, Windows 11, API running on `http://localhost:3000`, tested with PowerShell (`Invoke-RestMethod` / `Invoke-WebRequest`)
**Result:** 7 of 7 bugs found (A–G) plus 4 additional observations.

## Setup used for every bug

The seeded account `merchant@test.com` cannot log in (see "Additional findings"), so I registered my own merchant:

```powershell
npm start
$reg = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/auth/register -ContentType "application/json" -Body '{"email":"qa@test.com","password":"SecurePass123!","business_name":"QA Co"}'
$token = $reg.token
```

The database is in memory, so every server restart wipes it and the account has to be registered again.

---

## Bug A: Payment amount returned as a string

**Location:** `src/routes/payment.routes.js` (approx lines 16 and 52)
**Severity:** Medium
**Component:** Payment API

**How to Reproduce:**

1. Start the server and set `$token` (see Setup).
2. Create a payment:
```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/payments -Headers @{Authorization="Bearer $token"} -ContentType "application/json" -Body '{"amount":25.5,"currency":"EUR","customer_email":"test@test.com"}'
```
3. List payments:
```powershell
(Invoke-WebRequest -UseBasicParsing -Uri http://localhost:3000/api/payments -Headers @{Authorization="Bearer $token"}).Content
```
4. Compare the `amount` field in both responses.

**Expected Behavior:** `amount` is a number everywhere (`25.5`).

**Actual Behavior:** `POST /api/payments` returns `"amount":25.5` (number), but `GET /api/payments` and `GET /api/payments/:id` return `"amount":"25.5"` (string).

**Impact:** The same field has two different types depending on the endpoint. A client doing math on the string breaks (`"25.5" + 10` gives `"25.510"`), and totals or sorting become wrong.

**Root Cause:** The list and single-payment handlers format the response with `p.amount.toString()` and `payment.amount.toString()`.

**Suggested Fix:** Return `parseFloat(p.amount)` in both handlers so the type is consistent.

---

## Bug B: No maximum payment amount

**Location:** `src/routes/payment.routes.js` (approx lines 75–77, `POST /api/payments`)
**Severity:** High
**Component:** Payment API

**How to Reproduce:**

1. Start the server and set `$token`.
2. Send a huge amount:
```powershell
Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://localhost:3000/api/payments -Headers @{Authorization="Bearer $token"} -ContentType "application/json" -Body '{"amount":999999999,"currency":"EUR","customer_email":"test@test.com"}'
```

**Expected Behavior:** `400 Bad Request` with a message that the amount is over the maximum (the code comments suggest €50,000).

**Actual Behavior:** `201` with `"Payment created"` and a payment of €999,999,999 (payment id 4 in my run).

**Impact:** A typo or a malicious request can create an absurd payment. In production it would reach the payment provider and could cause failed transactions, fraud exposure or reconciliation problems.

**Root Cause:** The validation only checks that the amount is a positive number. The maximum-amount check exists only as a comment.

**Suggested Fix:** Reject `parseFloat(amount) > 50000` with a 400 error. Keep exactly 50,000 valid.

---

## Bug C: Email validation accepts addresses without a domain extension

**Location:** `src/routes/auth.routes.js` (approx lines 9–13, `validateEmail`)
**Severity:** Medium
**Component:** Auth API

**How to Reproduce:**

1. Start the server.
2. Register with an invalid email:
```powershell
Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://localhost:3000/api/auth/register -ContentType "application/json" -Body '{"email":"user@domain","password":"SecurePass123!","business_name":"Bad Email Co"}'
```

**Expected Behavior:** `400 Invalid email format`.

**Actual Behavior:** `"Registration successful"` and a JWT token (user id 3 in my run).

**Impact:** Accounts can be created with undeliverable addresses. Password resets, invoices and receipts sent to them are lost, and the user database fills with junk.

**Root Cause:** The regex `/^[^\s@]+@[^\s@]+$/` never requires a dot or a top-level domain.

**Suggested Fix:** Require a dot and a domain extension: `/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/`.

---

## Bug D: Webhook signature is never verified

**Location:** `src/routes/webhook.routes.js` (approx lines 21–32, `POST /api/webhooks/payment-status`)
**Severity:** Critical
**Component:** Webhooks

**How to Reproduce:**

1. Start the server, register a merchant and create a payment (id `3` in my run).
2. Send a webhook with a made-up signature:
```powershell
(Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://localhost:3000/api/webhooks/payment-status -Headers @{"x-webhook-signature"="fake-signature"} -ContentType "application/json" -Body '{"payment_id":"3","status":"completed","event_id":"evt_001"}').Content
```

**Expected Behavior:** `401 Invalid signature`, payment unchanged.

**Actual Behavior:** `{"success":true,"message":"Webhook processed","payment_id":"3","new_status":"completed"}`. The payment was marked as completed.

**Impact:** Anyone who knows the URL and a payment id can mark any payment as paid without paying. This is direct financial fraud.

**Root Cause:** The HMAC-SHA256 verification is only present as commented-out code. The `x-webhook-signature` header is read but never checked.

**Suggested Fix:** Compute `HMAC-SHA256(secret, body)` and compare it with the header using a constant-time comparison (`crypto.timingSafeEqual`). Reject missing or wrong signatures with 401.

---

## Bug E: Webhook has no idempotency

**Location:** `src/routes/webhook.routes.js` (approx lines 38–44 and 55–56)
**Severity:** High
**Component:** Webhooks

**How to Reproduce:**

1. Start the server and create a payment (id `4` in my run).
2. Send the exact same event twice:
```powershell
$b = '{"payment_id":"4","status":"completed","event_id":"evt_002"}'
(Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://localhost:3000/api/webhooks/payment-status -Headers @{"x-webhook-signature"="fake-signature"} -ContentType "application/json" -Body $b).Content
(Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://localhost:3000/api/webhooks/payment-status -Headers @{"x-webhook-signature"="fake-signature"} -ContentType "application/json" -Body $b).Content
```
(This was tested before Bug D was fixed, which is why a fake signature was accepted.)

**Expected Behavior:** The second call is recognised as a duplicate and ignored (`Already processed`).

**Actual Behavior:** Both calls return `"Webhook processed"`.

**Impact:** Payment providers retry webhooks. Without an idempotency check, a retry can run the same side effects twice (duplicate receipts, double fulfilment) or replay an old event over a newer status.

**Root Cause:** `event_id` is read from the body but never stored or checked. The "processed" bookkeeping exists only as comments.

**Suggested Fix:** Keep a record of processed `event_id` values, return `200 Already processed` for repeats, and only record an event after a successful update.

---

## Bug F: Duplicate pending orders for the same table

**Location:** `src/routes/table-order.routes.js` (approx lines 44–55, `POST /api/table-orders`)
**Severity:** Medium
**Component:** Table Orders

**How to Reproduce:**

1. Start the server and register a merchant (`$reg.user.id` is the merchant id).
2. Send the same order twice:
```powershell
$order = '{"merchant_id":"' + $reg.user.id + '","table_number":5,"items":[{"name":"Pizza","quantity":1,"price":10}],"customer_name":"Test","order_type":"dine_in"}'
(Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://localhost:3000/api/table-orders -ContentType "application/json" -Body $order).Content
(Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://localhost:3000/api/table-orders -ContentType "application/json" -Body $order).Content
```

**Expected Behavior:** The second request is rejected with `409 Table already has a pending order`.

**Actual Behavior:** Both succeed with different order ids (`ed60dc41-…` and `43d657c9-…` in my run).

**Impact:** A double tap or a retry sends the kitchen two identical orders and charges the table twice.

**Root Cause:** The duplicate check for pending orders on the same merchant and table exists only as a comment.

**Suggested Fix:** Before creating the order, look for an existing `pending` order with the same `merchant_id` and `table_number`, and return 409 if there is one.

---

## Bug G: Same e-invoice can be submitted twice

**Location:** `src/routes/einvoice.routes.js` (approx lines 50–58, `POST /api/einvoice/submit`)
**Severity:** Medium
**Component:** E-Invoice

**How to Reproduce:**

1. Start the server and set `$token`.
2. Submit the same invoice twice:
```powershell
$inv = '{"invoice_id":"INV-001","customer_siret":"12345678901234"}'
(Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://localhost:3000/api/einvoice/submit -Headers @{Authorization="Bearer $token"} -ContentType "application/json" -Body $inv).Content
(Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://localhost:3000/api/einvoice/submit -Headers @{Authorization="Bearer $token"} -ContentType "application/json" -Body $inv).Content
```

**Expected Behavior:** The second submission is rejected with `409 Invoice already submitted to tax authority`.

**Actual Behavior:** Both succeed with different submission ids (`SUB-e427177f-…` and `SUB-e478300e-…`).

**Impact:** Duplicate filings to the tax authority for one invoice can cause compliance problems and incorrect VAT records.

**Root Cause:** The check on `einvoice_status` (`submitted` / `accepted`) exists only as a comment.

**Suggested Fix:** Return 409 when the invoice already has status `submitted` or `accepted`, before creating a new submission id.

---

## Additional findings (not part of the 7 bugs)

These are noted but **not changed**, to avoid breaking API contracts or going beyond the scope of the assignment.

1. **Seeded merchant cannot log in.** `src/db/database.js` (line 19) stores a malformed bcrypt hash for `merchant@test.com`, so `Test123!` from the README always returns `Invalid credentials`. Setup problem; I registered a new merchant instead.
2. **`POST /api/table-orders` has no authentication.** The route does not use the `authenticate` middleware and trusts `merchant_id` from the request body, so anyone can create orders for any merchant. Suggested fix: add `authenticate` and use `req.user.id`.
3. **`POST /api/webhooks/e-invoice` has no signature verification.** It has the same weakness as Bug D and lets anyone change an invoice's status.
4. **Hardcoded secrets.** `JWT_SECRET` (`auth.routes.js`) and `WEBHOOK_SECRET` (`webhook.routes.js`) are hardcoded. They should come from environment variables.