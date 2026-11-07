# Changelog

`@nearpay/spec` and `@nearpay-internal/spec` share one version. Within a version line changes are
additive only (`pnpm compat` gates every release against `test/compat/baseline/`, the last release).

## Unreleased

### payments

Stage 2, step 2.1 (`nearpay-brain/lld/payments.md` §17). All additive: new routes, objects, events,
webhook types and error codes; new fields on existing objects are optional; no request field became
required. Money stays base-unit strings with an explicit asset (INV-5).

- **Refunds** (`re_…`, public module `refunds`): `createRefund` (`POST /v1/refunds`; optional
  `payment_attempt` refunds an overpayment), `getRefund`, `listRefunds` (`payment_intent`, `status`,
  `created`), `prepareRefund`, `submitRefundTx` (`{tx_hash}` or `{signed_intent}`), `cancelRefund`,
  `updateRefundRecipient` (owner + step-up, INV-7), test helper `simulateRefundDeposit`. Objects
  `Refund`, `RefundLeg`, `RefundRecipient`, `RefundNextAction` = `RefundSignAndSend` |
  `RefundSignIntent` (exact payload the dashboard / SDK signer signs; NEP-413 arguments and the
  ERC-191 / raw-ed25519 string), `RefundSubmission`, `TokenRef`. Producer: **nearpay-payments**.
  Readers: **nearpay-dashboard**, **nearpay-node**, **nearpay-console**.
- Refund events `evt.payments.refund.{created,requires_action,pending,succeeded,failed,canceled}`
  (object `Refund`; consumers webhooks, + notify on `succeeded`) and webhook types `refund.*` (incl.
  `refund.pending`). Readers: **nearpay-webhooks**, **nearpay-notify**.
- Rails refund legs: `createRefundExecution` (`POST /internal/refund_executions`, body
  `CreateRefundExecution`: `route_quote` with `EXACT_INPUT`/`EXACT_OUTPUT`, or `intents_transfer`);
  `Execution.refund` (`ExecutionRefund`: swap type, amounts, source `token`, `RefundTransfer` for
  Intents sources) and `Execution.reference` (`ExecutionReference`); optional
  `CreateExecution.reference`. Implementer: **nearpay-rails**; readers: payments, agentpay,
  compliance (copies `reference.payment_intent` into reviews).
- agentpay `relaySignedIntent`: optional `kind` (`checkout` | `refund`) and `refund`; refund payloads
  are one merchant-signed transfer matching `Execution.refund.transfer`. Implementer:
  **nearpay-agentpay**.
- Sandbox: `SandboxQuoteRequest.scenario_group` / `scenario_kind` (scenario `06` duplicates stay
  within one payment or one refund) and `sandboxSimulateIntentsTransfer`
  (`POST /sim/intents/transfers`). Implementer: **nearpay-sandbox**.
- **Payment links** (`plink_…`): `createPaymentLink`, `getPaymentLink`, `listPaymentLinks`
  (`active`), `updatePaymentLink` (PATCH; pricing immutable); payer routes `getPublicPaymentLink`
  and `createPaymentLinkSession` (anonymous, `GET|POST /v1/payment_links/{id}/public/**`). Readers:
  **nearpay-checkout** (`/l/:id`), dashboard, node.
- **Customers** (`cus_…`): `createCustomer`, `getCustomer`, `listCustomers` (`email`),
  `updateCustomer` (PATCH), `deleteCustomer`. `customer` on `CheckoutSessionCreate`, and optional
  `customer` / `payment_link` on `CheckoutSession` and `PaymentIntent`.
- **Payment intents:** `createPaymentIntent` (`POST /v1/payment_intents` → `CreatedPaymentIntent`
  with the headless session's `client_secret`); `reviewPaymentIntent`
  (`POST /v1/payment_intents/{id}/review`, `accept` only for `short_settlement` — INV-2); optional
  `amount_refund_pending`, `refunds`, `review_decision` on `PaymentIntent`; `listPaymentIntents`
  filters `amount[gte|gt|lte|lt]`, `currency`, `asset_id`, `settlement_asset_id`, `source`,
  `customer`, `payment_link`, `checkout_session`, `metadata[key]` (ADR-0018; helper
  `withMetadataFilter` / `metadataFilters`, emitted as a `deepObject` parameter).
- Statement: optional `refund_leg`, `received`, `fee_adjustment` on `BalanceTransaction`;
  `listBalanceTransactions` filter `refund`.
- **Reviews** as webhooks: `PublicReview` and types `review.opened` / `review.closed` (from
  `evt.compliance.review.*`, now also consumed by webhooks); bus `Review.payment_intent` (optional) and
  `toPublicReview()` rendering. Producer: **nearpay-compliance** (fill `payment_intent`); renderer:
  **nearpay-webhooks**.
- Internal payments: `getInternalRefund`, `getRefundReceiptContext` (notify `refund.receipt`),
  reconciliation runs (`rcn_…`, new ID prefix) `listReconciliationRuns`, `getReconciliationRun`,
  `createReconciliationRun`, `resolveReconciliationRun` (objects `ReconciliationRun`,
  `ReconciliationTotals`, `ReconciliationDiff`, `ReconciliationResolution`); ops scope
  `payments.reconcile`. Reader: **nearpay-console**.
- Error codes: `intent_not_succeeded`, `attempt_not_settled`, `amount_exceeds_refundable`,
  `leg_expired`, `signed_intent_mismatch`, `review_requires_evidence`, `link_inactive`,
  `customer_deleted`, `reconciliation_day_open`.

## 0.1.5 — Stage 1, step 1.4 (change requests from steps 1.2/1.3)

All changes are additive (`pnpm compat`: no breaking change since 0.1.4; oasdiff reports info-level changes only).
Request IDs refer to `nearpay-brain/roadmap/open-questions.md` ("Planned `@nearpay/spec` 0.1.5").

- `PublicCheckoutSession.payment_intent` (`pi_…`, required; also in the `session` event of
  `streamCheckoutSession`) — the embedded checkout's `np:complete` reports the intent id without
  waiting for an SSE `intent` event (CR-15-05). Producer: **nearpay-payments** (must set it before
  readers upgrade). Readers: **nearpay-checkout**, **nearpay-js**, **nearpay-agentpay** (parses the
  public session).
- x402 `SettleResponse.replayed?: boolean` — true when the same payment payload was settled before and
  the response repeats that result (CR-15-12). Producer: **nearpay-agentpay**. Readers:
  **nearpay-agentkit**, **nearpay-testbed** (deliver the resource once per settlement).
- x402 `X402IntentsTransferExtra.deadline?: string` (RFC 3339) — the absolute expiry of the issued
  requirement (the binding's `expires_at`) (CR-15-11). Producer: **nearpay-agentpay**
  (`POST /x402/requirements`). Readers: **nearpay-agentkit**, **nearpay-testbed** (sign a Verifier
  deadline at or before it; fall back to `maxTimeoutSeconds` when absent).
- `createWebhookEndpoint` / `updateWebhookEndpoint`: `enabled_events` items accept any string
  (1–100 chars) besides `*` and the typed `WebhookTypeSchema` values, so an unknown type reaches the
  service and is answered with `event_type_unknown` instead of `400 invalid_request` (CR-15-08).
  `WebhookEndpoint.enabled_events` (responses) is unchanged. Implementer: **nearpay-webhooks**
  (already maps unknown types); readers: **nearpay-dashboard**, **nearpay-node**.
- `sequence` (integer ≥ 0, optional) on `CheckoutSession` (and the bus object `CheckoutSessionEvent`)
  and `AgentPayment` (CR-15-09). Optional in 0.1.x only so 0.1.4 readers stay compatible: servers MUST
  send it (it increases with every change; use the aggregate version, as webhooks does today).
  Producers: **nearpay-payments**, **nearpay-agentpay**. Reader: **nearpay-webhooks** (stop injecting
  `aggregate.version` once producers send it), **nearpay-node**.
- `getDashboardSession` — `GET /v1/auth/session` → the current `DashboardSession` (with `csrf_token`)
  for the session cookie; session auth, any role, sets no cookie (CR-15-01). Implementer:
  **nearpay-identity** (re-issue the CSRF token from `csrf_enc`). Reader: **nearpay-dashboard**
  (recover the session on reload instead of `sessionStorage`).
- `listWebhookEndpointDeliveries` — `GET /v1/webhook_endpoints/{id}/deliveries`, a cursor list of
  `WebhookDelivery` (`whd_…`: `webhook_endpoint`, `event`, `event_type`, `status`
  `pending|succeeded|failed|abandoned`, `attempts`, `last_status_code`, `last_error`,
  `next_attempt_at`, `succeeded_at`, `created`) with the endpoint read auth (CR-15-02).
  New ID prefix `whd_` (webhook delivery, owner webhooks). Implementer: **nearpay-webhooks**.
  Readers: **nearpay-dashboard**, **nearpay-node**.
- `challengeSettlementDestination` — `POST /v1/settlement_destinations/{id}/challenge` returns the
  destination with a fresh `attestation_challenge` (same shape as on create) while it is
  `pending_verification`; session owner/admin with step-up, idempotent; otherwise
  `409 state_conflict`; earlier unused challenges stop being accepted (CR-15-03). The
  `challenge_expired` message now points to requesting a new challenge. Implementer:
  **nearpay-identity**. Reader: **nearpay-dashboard**.
- `safeParseTolerant(schema, input)` / `parseTolerant(schema, input)` — tolerant parsing for SDKs:
  unknown string values of open enums (`openEnum()`) are accepted, kept verbatim and listed in
  `unknown` (with their paths); closed enums, literals and every other rule still fail with the
  strict error (CR-15-13). The schemas themselves are unchanged (servers stay strict). Readers:
  **nearpay-node**, **nearpay-js**, **nearpay-agentkit**, **nearpay-dashboard**.

Not in this release (left open in the brain): CR-15-04 (destination `fingerprint` snapshot, typed
`Event.data.object` union), CR-15-06 (`PaymentOption.token`), CR-15-07, CR-15-10 (`ping`
subscribable), CR-15-15 (internal payer-session route for agentpay); CR-15-14/16/17 are not spec changes.

## 0.1.4 — Stage 1, step 1.2

- ID prefix `ks_` (kill switch, sentinel): the aggregate id of `evt.sentinel.kill_switch.engaged` /
  `.released` (a singleton aggregate whose version orders engage/release for rails and notify).

## 0.1.3 — Stage 1, step 1.2

- `getInternalAsset` and `listInternalOptions` (rails) take an optional `livemode` query parameter:
  rails keeps one token registry per mode (live = 1Click `/v0/tokens`, test = the sandbox registry, so
  test mode works offline). Omitted, the live registry answers, falling back to test.

## 0.1.2 — Stage 1, step 1.2

- ID prefix `pol_` (geo policy, compliance): the aggregate id of `evt.compliance.policy.updated`.
- `Review.subject.type` gains `execution` (open enum): compliance reviews a rails execution (post-screen
  hits, held executions, sentinel audit mismatches); payments maps it to the payment intent.

## 0.1.1 — Stage 1, step 1.2

- `sandboxQuote` (`POST /v0/quote` on nearpay-sandbox) takes `SandboxQuoteRequest`: the 1Click quote
  request plus optional `scenario_amount`, the payment's pricing amount whose last two digits pick
  the test-mode scenario (sandbox LLD §4). The quoted `amount` cannot carry the scenario because it
  is the settlement amount plus the amount tag.

## 0.1.0 — Stage 1, step 1.1

Stage 1 contracts: public and internal routes, domain events, webhook types, error catalogue, x402
`intents-transfer` scheme, NEAR Intents payloads and shared test vectors.
