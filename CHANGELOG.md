# Changelog

`@nearpay/spec` and `@nearpay-internal/spec` share one version. Within a version line changes are
additive only (`pnpm compat` gates every release against `test/compat/baseline/`, the last release).

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
