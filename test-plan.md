# Test Plan: Webhook Payment Flow

**Feature under test:** `POST /api/webhooks/payment-status`, a payment provider (like Powens) tells the API that a payment changed status, and the API updates the payment.
**Author:** Gayatri

---

## 1. Test Scope

**In scope (end-to-end payment webhook flow):**

- Creating a payment (`POST /api/payments`) and reading it back (`GET /api/payments/:id`)
- Sending a webhook for that payment and checking the new status
- Signature verification (HMAC-SHA256, header `x-webhook-signature`)
- Idempotency (`event_id`), replays and duplicate deliveries
- Input validation of the webhook body (`payment_id`, `status`, `event_id`)
- Error handling for unknown payments and malformed requests

**Out of scope:**

- UI / mobile app behaviour
- Performance, load and stress testing
- The other webhook (`/api/webhooks/e-invoice`) and the real payment provider (the provider is simulated with PowerShell / Node `fetch`)
- Infrastructure (network, TLS, rate limiting at the gateway)

---

## 2. Test Environment

| Item | Value |
|---|---|
| API | `http://localhost:3000` (manual) and ports 3101–3105 (automated tests start their own copy) |
| Runtime | Node.js v24.16.0 |
| Webhook simulator | PowerShell `Invoke-WebRequest` for manual runs, Node `fetch` + `crypto` for automated runs |
| Database | In-memory, reset on every server restart |
| Test runner | Node built-in runner: `npm test` |
| Test data | A new merchant is registered per test file (the seeded `merchant@test.com` cannot log in) |
| Webhook secret | `test-webhook-secret-key` (hardcoded test value) |

**How a valid webhook is built:** signature = hex `HMAC-SHA256(secret, JSON.stringify(body))`, sent in the `x-webhook-signature` header.

---

## 3. Test Scenarios

**Status legend:** **Automated** = covered by a test in `src/routes/__tests__/webhook.routes.test.js` (all passing). **Planned** = designed, not yet automated or run.

| ID | Scenario | Steps | Expected result | Status |
|---|---|---|---|---|
| WH-01 | Valid webhook with correct signature | Create payment, send signed `completed` event | `200 Webhook processed`, payment status is `completed` | Automated |
| WH-02 | Invalid signature | Send a webhook with `x-webhook-signature: fake-signature` | `401 Invalid signature`, payment stays `pending` | Automated |
| WH-03 | Missing signature header | Send a webhook with no signature header | `401`, payment unchanged | Automated |
| WH-04 | Duplicate webhook (same `event_id` twice) | Send the same signed event twice | 1st: processed. 2nd: `200 Already processed` | Automated |
| WH-05 | Webhook for a non-existent payment | Signed webhook with an unknown `payment_id` | `404 Payment not found` | Automated |
| WH-06 | Webhook arrives before the payment is created | Send webhook for an id that does not exist yet, then create it, then re-send the same event | 1st: `404`. After the payment exists, the same event is accepted (a failed attempt must not be recorded as processed) | Planned |
| WH-07 | Multiple webhooks for the same payment, different statuses | Send `processing` (event 1), then `completed` (event 2) | Both processed, final status `completed` | Automated |
| WH-08 | Missing fields | Signed body without `payment_id` / `status` | `400 payment_id and status required` | Automated |
| WH-09 | Missing `event_id` | Signed body without `event_id` | `400 event_id required` | Automated |
| WH-10 | Malformed JSON body | Send `{"payment_id": ` (broken JSON) | `400` with a clear error. **To verify:** the global error handler returns a generic `500`, which would be a bug | Planned |
| WH-11 | Concurrent webhooks (race condition) | Fire 20 identical signed webhooks in parallel | Exactly one `Webhook processed`, the other 19 `Already processed` | Planned |
| WH-12 | SQL injection in `payment_id` | Signed body with `payment_id: "1' OR '1'='1"` | `404` (no match). Never `500`, never a changed payment | Planned |
| WH-13 | Timing attack on the signature | Compare response times for signatures that differ at the first vs the last character | No measurable difference (constant-time compare, `crypto.timingSafeEqual`) | Planned (code-reviewed) |
| WH-14 | Replay attack (old `event_id`) | Replay a captured event with a different status | `Already processed`, status not overwritten | Automated |
| WH-15 | Body tampered after signing | Sign `failed`, send `completed` with that signature | `401`, payment unchanged | Automated |

---

## 4. Security Tests

| Test | Approach | Expected |
|---|---|---|
| **Signature verification (HMAC-SHA256)** | Missing, fake, wrong-length, and tampered-body signatures (WH-02, WH-03, WH-15) | All rejected with 401, state never changed |
| **Replay attack prevention** | Re-send a captured valid event (WH-14) | Ignored thanks to `event_id` tracking |
| **SQL injection in the payload** | Injection strings in `payment_id`, `status`, `event_id` (WH-12) | No error, no data change. The store is an in-memory object (no SQL), but this protects against a future database migration |
| **XSS in the `status` field** | Signed body with `status: "<script>alert(1)</script>"` | **Expected:** `400` (status must be one of a fixed list). **Known gap:** the route stores any string as the status, so this is stored as-is. Dashboards that render it unescaped would be exposed |
| **Signature timing** | WH-13 | Constant-time comparison is used in the code |
| **Unauthenticated access** | The route is intentionally public (providers do not send a JWT), so the signature is the only protection | Covered by the signature tests above |

---

## 5. Edge Cases

| Case | Expected |
|---|---|
| Very large `payment_id` (10,000 characters) | `404`, no crash, no slow response |
| Unicode / emoji in `status` (e.g. `"complété ✅"`) | Either rejected by validation or stored safely and returned unchanged |
| `null` or empty-string `event_id` | `400 event_id required` |
| `event_id` as a number vs a string (`123` vs `"123"`) | Decide and test one rule. A `Set` treats them as different values, so both could be processed |
| Future-dated timestamps in the body | Ignored today (no timestamp is used). If a timestamp field is added, it should be bounded |
| Signature with uppercase hex | Currently rejected (comparison is on lowercase hex). Document the expected format with the provider |
| Empty body `{}` | `400` (the signature of `{}` is valid but fields are missing) |
| Extra unknown fields in the body | Part of the signed body, accepted and ignored |

---

## 6. Integration Tests

| Flow | Steps | Expected | Status |
|---|---|---|---|
| **Webhook → payment status update → persistence** | Create payment, send signed webhook, `GET /api/payments/:id` | The new status is returned by the read endpoint | Automated (WH-01, WH-07) |
| **Webhook → Socket.IO event** | Join the merchant room, send a webhook, listen for an event | A real-time event reaches the merchant. **Gap found:** the webhook route does not emit any Socket.IO event, so this cannot pass until it is implemented | Planned (blocked) |
| **Failed webhook → retry** | Send a webhook that fails (payment not found), create the payment, re-send the same event | The retry succeeds, because only successful events are recorded as processed (WH-06). The API has no retry logic of its own, retries come from the provider | Planned |
| **Ownership** | Webhook for a payment of merchant A | The payment of merchant A updates. There is no merchant check in the webhook, the payment id is the only key, so ids must not be guessable | Planned |

---

## 7. Risk Assessment

| Risk | Likelihood | Impact | Detection | Mitigation |
|---|---|---|---|---|
| **Forged webhooks mark payments as paid** (the original Bug D) | Was certain, now low | Critical (financial loss) | Alert on any `401 Invalid signature` spike. Reconcile payment status with the provider's dashboard daily | HMAC verification (done), rotate the secret regularly, keep the secret out of source code |
| **Secret leak** (the secret is hardcoded) | Medium | Critical | Secret scanning in CI | Load from environment variables or a secrets manager |
| **Duplicate or retried webhooks processed twice** (the original Bug E) | High (providers retry by design) | High | Log every `Already processed`. Compare event counts with the provider | `event_id` tracking (done) |
| **Idempotency store lives in memory** | High in production | High | Duplicates after a restart or on a second server instance | Persistent store with a unique constraint on `event_id`, or Redis `SET NX` |
| **No timestamp tolerance** (a captured valid webhook with a new `event_id` cannot be forged, but old ones are replayable if event ids are not unique to the provider) | Low | Medium | Monitor webhook age vs arrival time | Include a timestamp in the signed payload and reject anything older than ~5 minutes |
| **Signature calculated over re-serialised JSON** | Medium | Medium (valid webhooks rejected after a provider formatting change) | Spike in `401` for known-good provider traffic | Verify the signature over the raw request bytes |
| **Any status string is accepted** | Medium | Medium (data integrity, XSS in dashboards) | Query for unexpected status values | Validate against an allow-list (`pending`, `processing`, `completed`, `failed`, `refunded`) and block invalid transitions (e.g. `completed` → `pending`) |
| **Malformed requests return a generic 500** | Medium | Low | Error-rate monitoring | Return `400` for parse errors in the global error handler |
| **Missing real-time update** (no Socket.IO emit) | High | Medium (merchant UI does not update live) | Integration test (blocked, see section 6) | Emit `order_status_changed` / payment event after the update |