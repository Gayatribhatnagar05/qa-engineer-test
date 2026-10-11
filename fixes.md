# Fixes

All 7 bugs were fixed without renaming or removing any endpoint. Only invalid or duplicate requests now get a `400`, `401` or `409` instead of a success response (see "API contract notes" at the end).

Verification: every fix was checked by hand against a restarted server, and then covered by automated tests (`npm test`: 49 tests, 49 passing).

---

## Fix 1: Payment amount data type (Bug A)

**Bug:** `amount` was returned as a string by the list and single-payment endpoints.

**Files Changed:**

- `src/routes/payment.routes.js` (lines 16 and 52)

**Code Changes:**
```diff
- amount: p.amount.toString(), // ← BUG: Should be number, not string
+ amount: parseFloat(p.amount), // FIX Bug A: return amount as a number, not a string
```
```diff
- amount: payment.amount.toString(), // Same bug as above
+ amount: parseFloat(payment.amount), // FIX Bug A
```

**Why This Fix:** The create endpoint already returned a number, so the other two endpoints are now consistent with it. Clients can do arithmetic on the value without converting it first.

**Testing:**
```powershell
(Invoke-WebRequest -UseBasicParsing -Uri http://localhost:3000/api/payments -Headers @{Authorization="Bearer $token"}).Content
# Response: "amount":25.5  (no quotes)
```
Automated: `payment.routes.test.js` → "Bug A: GET /payments returns amount as a number", "Bug A: GET /payments/:id returns amount as a number".

---

## Fix 2: Maximum payment amount (Bug B)

**Bug:** Any amount was accepted, including €999,999,999.

**Files Changed:**

- `src/routes/payment.routes.js` (line 78, inside `POST /api/payments`)

**Code Changes:**
```diff
+ if (amount > 50000) { return res.status(400).json({ error: 'Amount exceeds the maximum allowed per transaction (50,000)' }); } // FIX Bug B
```

**Why This Fix:** The limit comes from the comment in the original code (€50,000 per transaction). The check uses `>` so exactly 50,000 stays valid, and it runs before the payment is created. It uses the same `400` + `{ error }` shape as the other validations in this route.

**Testing:**
```powershell
Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://localhost:3000/api/payments -Headers @{Authorization="Bearer $token"} -ContentType "application/json" -Body '{"amount":999999999,"currency":"EUR","customer_email":"test@test.com"}'
# Response: 400 {"error":"Amount exceeds the maximum allowed per transaction (50,000)"}
```
Automated: "Bug B: POST /payments rejects an amount over 50,000", "...just over the limit" (50000.01), "...accepts exactly 50,000 (boundary)".

---

## Fix 3: Email validation (Bug C)

**Bug:** `user@domain` (no domain extension) was accepted.

**Files Changed:**

- `src/routes/auth.routes.js` (line 12, `validateEmail`)

**Code Changes:**
```diff
- const emailRegex = /^[^\s@]+@[^\s@]+$/;
+ const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/; // FIX Bug C: require a domain extension, e.g. user@domain.com
```

**Why This Fix:** The new pattern requires a dot after the `@` followed by at least 2 characters, and still blocks spaces and a second `@`. I kept it a simple regex on purpose: it blocks the reported case without rejecting real addresses. Full RFC-level validation is not practical with a regex, and the real proof of a valid address is a confirmation email.

**Testing:**
```powershell
Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://localhost:3000/api/auth/register -ContentType "application/json" -Body '{"email":"user@domain","password":"SecurePass123!","business_name":"Bad Email Co"}'
# Response: 400 {"error":"Invalid email format"}
```
Automated: `auth.routes.test.js` → "Bug C: register rejects an email without a domain extension (user@domain)", "...ending with a dot", "...still accepts a valid email".

---

## Fix 4: Webhook signature verification (Bug D)

**Bug:** The `x-webhook-signature` header was never checked, so anyone could mark a payment as completed.

**Files Changed:**

- `src/routes/webhook.routes.js` (`POST /api/webhooks/payment-status`)

**Code Changes:**
```diff
- // BUG D: No signature verification
- // const expectedSignature = crypto
- //   .createHmac('sha256', WEBHOOK_SECRET)
- //   ...
+ // FIX Bug D: verify the HMAC-SHA256 signature before trusting the webhook
+ const expectedSignature = crypto
+   .createHmac('sha256', WEBHOOK_SECRET)
+   .update(JSON.stringify(req.body))
+   .digest('hex');
+
+ const signatureBuffer = Buffer.from(String(signature || ''));
+ const expectedBuffer = Buffer.from(expectedSignature);
+
+ // Constant-time comparison avoids timing attacks; lengths must match first
+ if (
+   signatureBuffer.length !== expectedBuffer.length ||
+   !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
+ ) {
+   return res.status(401).json({ error: 'Invalid signature' });
+ }
```

**Why This Fix:** The signature is checked first, before any payment lookup or status change. `crypto.timingSafeEqual` is used instead of `!==` so response timing cannot be used to guess the signature byte by byte (it throws on different lengths, so the length check comes first). A missing header becomes an empty string and is rejected the same way.

**Testing:**
```powershell
Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://localhost:3000/api/webhooks/payment-status -Headers @{"x-webhook-signature"="fake-signature"} -ContentType "application/json" -Body '{"payment_id":"3","status":"completed","event_id":"evt_101"}'
# Response: 401 {"error":"Invalid signature"}
```
A webhook signed with the real secret still returns `Webhook processed`.
Automated: `webhook.routes.test.js` → "Bug D: webhook without a signature is rejected", "...with a fake signature is rejected", "...whose body was changed after signing is rejected", "...with a valid signature updates the payment".

---

## Fix 5: Webhook idempotency (Bug E)

**Bug:** The same `event_id` was processed every time it was delivered.

**Files Changed:**

- `src/routes/webhook.routes.js`

**Code Changes:**
```diff
+ // FIX Bug E: remember which webhook events were already handled (idempotency)
+ const processedEvents = new Set();
```
```diff
+ // FIX Bug E: event_id is needed to detect duplicate deliveries
+ if (!event_id) {
+   return res.status(400).json({ error: 'event_id required' });
+ }
+
+ // FIX Bug E: if this event was already processed, acknowledge without changing anything
+ if (processedEvents.has(event_id)) {
+   return res.status(200).json({ message: 'Already processed' });
+ }
```
```diff
- // db.processed_webhooks.push(event_id);
+ // FIX Bug E: mark as processed only after a successful update
+ processedEvents.add(event_id);
```

**Why This Fix:** Duplicates return `200` (not an error) because providers treat non-2xx as "failed" and keep retrying. The event is recorded only after the payment is updated, so a failed attempt (for example payment not found) can still be retried. A replayed `event_id` with a different status cannot overwrite the current one.

**Known limitation:** The set lives in memory, so it is cleared on restart and is not shared between server instances. The original code commented on `db.processed_webhooks`, which does not exist in this in-memory database. In production this should be a persistent store (a database table with a unique constraint on `event_id`, or Redis `SET NX`) so the check and the write are atomic across instances.

**Testing:** Send the same signed event twice.
```
1st response: {"success":true,"message":"Webhook processed",...}
2nd response: {"message":"Already processed"}
```
Automated: "Bug E: the same event sent twice is processed only once", "Bug E: replaying an old event does not overwrite the payment status", "Bug E: different event_ids for the same payment are both processed".

---

## Fix 6: Duplicate table orders (Bug F)

**Bug:** Two identical pending orders could be created for the same table.

**Files Changed:**

- `src/routes/table-order.routes.js` (lines 48–55)

**Code Changes:**
```diff
- // const existingOrder = (db.table_orders || []).find(
- //   o => o.merchant_id === merchant_id &&
- //        o.table_number === table_number &&
- //        o.status === 'pending'
- // );
- // if (existingOrder) {
- //   return res.status(409).json({ error: 'Table already has a pending order' });
- // }
+ const existingOrder = (db.table_orders || []).find(
+   o => o.merchant_id === merchant_id &&
+        o.table_number === table_number &&
+        o.status === 'pending'
+ );
+ if (existingOrder) {
+   return res.status(409).json({ error: 'Table already has a pending order' });
+ }
```

**Why This Fix:** The check is scoped to the same merchant, the same table and status `pending`. This means: two different merchants can both use table 5, and a table can be ordered again once its previous order is `served` or `cancelled`. `409 Conflict` is the correct status for "this conflicts with the current state".

**Testing:**
```powershell
# Send the same order twice
# 1st response: "Table order created"
# 2nd response: 409 {"error":"Table already has a pending order"}
```
Automated: `table-order.routes.test.js` → "Bug F: a second order for a table with a pending order is rejected", "...does not create a second order", "...different tables can each have a pending order", "...a table can be ordered again once its order is no longer pending", "...the same table number for a different merchant is allowed".

---

## Fix 7: Duplicate e-invoice submissions (Bug G)

**Bug:** The same invoice could be submitted to the tax authority repeatedly, each time with a new submission id.

**Files Changed:**

- `src/routes/einvoice.routes.js` (lines 54–58)

**Code Changes:**
```diff
- // if (invoice.einvoice_status === 'submitted' || invoice.einvoice_status === 'accepted') {
- //   return res.status(409).json({
- //     error: 'Invoice already submitted to tax authority'
- //   });
- // }
+ if (invoice.einvoice_status === 'submitted' || invoice.einvoice_status === 'accepted') {
+   return res.status(409).json({
+     error: 'Invoice already submitted to tax authority'
+   });
+ }
```

**Why This Fix:** The check runs after ownership and SIRET validation and before a new `submission_id` is generated, so a rejected duplicate leaves the original submission id untouched. Both `submitted` and `accepted` count as already sent.

**Testing:**
```powershell
# Submit INV-001 twice
# 1st response: "Invoice submitted to tax authority"
# 2nd response: 409 {"error":"Invoice already submitted to tax authority"}
```
Automated: `einvoice.routes.test.js` → "Bug G: submitting the same invoice twice is rejected", "...a rejected duplicate keeps the original submission id", "...different invoices can each be submitted".

---

## API contract notes

- No endpoint was renamed or removed, and successful responses keep the same shape.
- Newly rejected requests: payments over 50,000 (`400`), emails without a domain extension (`400`), webhooks with a missing or wrong signature (`401`), duplicate pending table orders (`409`) and duplicate e-invoice submissions (`409`).
- **One behavioural change to flag:** `POST /api/webhooks/payment-status` now requires `event_id` (`400` if missing). It was effectively required before, because the idempotency check needs it, and the README's own webhook example sends it.

## Things I deliberately did not change

- The malformed seeded password hash for `merchant@test.com` (see `bug-reports.md`, additional finding 1).
- `POST /api/table-orders` is still unauthenticated, and `POST /api/webhooks/e-invoice` has no signature check. They are outside the 7 listed bugs and changing them would change API contracts. Both are documented in `bug-reports.md`.
- The webhook signature is calculated over `JSON.stringify(req.body)`. A production system should sign and verify the **raw request bytes**, because re-serialising parsed JSON can differ from what the provider signed.