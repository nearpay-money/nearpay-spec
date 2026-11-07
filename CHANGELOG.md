# Changelog

`@nearpay/spec` and `@nearpay-internal/spec` share one version. Within a version line changes are
additive only (`pnpm compat` gates every release against `test/compat/baseline/`, the last release).

## 0.2.0 — 2026-11-07

Stage 2 contract freeze (step 2.1, `nearpay-brain/roadmap/development-plan.md` §4; owner decisions
2026-11-07, ADR-0020). Additive over 0.1.5 by construction: no route, field or enum value was removed
or renamed, no request field became required and no existing response type was tightened (the oasdiff
gate against the 0.1.5 baseline runs in CI before the baseline moves). The new minor marks the
Stage 2 freeze; every Stage 2 error code carries `since: "0.2.0"`. Totals: 102 public, 48 internal
and 47 console routes (+39 / +12 / +47), 54 domain event subjects (+15), 21 webhook types (+9),
77 error codes (+17), 38 ID prefixes (+5: `inv`, `aud`, `opa`, `bl`, `rcn`).

### contracts integration

Cross-topic follow-ups applied when merging the three step 2.1 branches (all on routes, objects and
events new in this release, so renames are safe).

- **Reconciliation on the console table.** payments' `/internal/reconciliation_runs*` routes (ops
  scopes on `/internal`, which the gateway never routes) are now ops routes served by payments:
  `listOpsReconciliationRuns` `GET /ops/reconciliation_runs` (`account`, `livemode`, `status`,
  `day`, `day[gte|lte]`, `unresolved`, cursor paging), `getOpsReconciliationRun`
  `GET /ops/reconciliation_runs/{id}` (`ops:payments.read`), `createOpsReconciliationRun`
  `POST /ops/reconciliation_runs` and `resolveOpsReconciliationRun`
  `POST /ops/reconciliation_runs/{id}/resolution` (step-up) (`ops:payments.reconcile`); all
  `opsRoles` `ops | ops_admin`. `getOpsRefund` `GET /ops/refunds/{id}` (`ops:payments.read`) for the
  console; `getInternalRefund` is service-only (`service:payments.read`). Implementer:
  **nearpay-payments**; reader: **nearpay-console**.
- **Reconciliation diffs become compliance cases.** `createInternalCase` `POST /internal/cases`
  (compliance, `service:compliance.cases.write`, new service scope held by payments): opens a
  `reconciliation_diff` `ComplianceCase` for a `reconciliation_run` (`rcn_…`), idempotent on
  `rcn:<run id>`. The case schemas (`CaseKind`, `CaseSeverity`, `CaseStatus`, `CaseResolution`,
  `ComplianceCase`) moved to `src/internal/cases.ts` (same exports). Implementer:
  **nearpay-compliance**; caller: **nearpay-payments**.
- **Executions explorer** (rails, `/ops/executions…`): `listOpsExecutions` requires `livemode`
  (INV-8) and types `state` as `AttemptStatus`; new `listOpsExecutionObservations`
  `GET /ops/executions/{id}/observations` → `ProviderObservationPage` (`ops:rails.read`) and
  `reverifyOpsExecution` `POST /ops/executions/{id}/reverify` (`ops:rails.verify`, new ops scope,
  step-up; sets `verify_at = now()` for a `held`/`verifying` execution, never forces a state —
  INV-2). `ObservationPageQuery` and `ProviderObservationPage` are exported schemas.
  `ExecutionRefund.token` reuses `TokenContract`. Implementer: **nearpay-rails**.
- **Unified console audit trail (T-12).** Subjects `evt.compliance.ops_action.recorded` and
  `evt.sentinel.ops_action.recorded` (object `OpsActionEvent`: action `id`, `actor {sub, ops_role}`,
  `action`, `target {type, id}`, `account_id`, `approval`, `occurred_at`; ids only), consumer
  identity (copies them into `audit_events`). Producers: **nearpay-compliance**,
  **nearpay-sentinel**; consumer: **nearpay-identity**. `AggregateType` documents `membership`,
  `ops_approval` and `ops_action`.
- **Error `since`.** `ErrorDefinition.since` is any `major.minor.patch`; every Stage 2 code is
  stamped `0.2.0`.
- `DeletedCustomer.livemode` (every merchant object carries its mode).
- payments consumes `evt.sentinel.kill_switch.engaged` / `.released` (lead decision: the kill switch
  blocks new live refund legs and live refund relays, fail closed; refunds resume on release).
- **Review webhooks deduplicated:** `review.opened` / `review.closed` carry `PublicReview`
  (payments); the bus `Review` stays in `@nearpay-internal/spec` (identity-console had moved it to
  the public package — reverted).

### identity-console

Stage 2 step 2.1 contracts for identity, compliance, webhooks, notify, sentinel and the console
(owner decisions 2026-11-07, ADR-0020). All additive; Stage 1 routes, fields and enum values are unchanged.

- **Console (ops) routes** — new route visibility `ops` (paths `/ops/…`, served by the owning
  service, routed by the gateway only on the console host) and route field `opsRoles`
  (`OPS_ROLES = ops | ops_admin`); `route()` refuses ops routes without `opsRoles`, with merchant
  roles or with non-ops auth (anonymous only under `/ops/auth/`). Exports `OPS_ROUTES` (also part of
  `INTERNAL_ROUTES`, emitted into `openapi/internal/<service>.yaml` with `x-nearpay.visibility: ops`
  and `ops_roles`) and `OPS_ANONYMOUS_ROUTES`. New `OPS_SCOPES`: `console.session`,
  `identity.merchants.read`, `identity.audit.read`, `compliance.read`, `compliance.accounts.write`,
  `compliance.blocklist.write`, `compliance.screen`, `sentinel.read`, `sentinel.findings.write`;
  `OPS_ROLE_SCOPES`; `OPS_SESSION_TTL_SECONDS`; internal JWT claim `ops_role`. Routes: console
  sign-in (enrolment link → hardware passkey with AAGUID allow-list → `__Host-np_ops`), step-up,
  session, logout (identity); merchants search/get and audit log (identity); KYB queue/decision,
  cases list/get/assign/comment/close, blocklist list/add/remove, screening, re-screen, merchant
  suspension with two-person approval (compliance); kill switch get/engage, two-person release
  request/approve/reject, log, findings list/get/acknowledge (sentinel); executions explorer and
  holds (rails, `Execution`). `OpsApproval` (`opa_`): the second approver is an `ops_admin` with a
  different operator id, enforced server-side (`approver_conflict`). `setKillSwitch` declares
  `two_person_required` (single-person release refused when `NP_ENV=server`); `decideKyb` and
  `setKillSwitch` declare `opsRoles`. Implementers: **nearpay-identity**, **nearpay-compliance**,
  **nearpay-sentinel**, **nearpay-rails**; kit (**@nearpay-internal/service**) must check
  `opsRoles` against `ops_role` and accept `stepUp` for ops principals; gateway
  (**nearpay-deploy**) routes `ops.…/api/ops/*`. Reader: **nearpay-console**.
- **Identity** — `startRecovery`, team (`listMembers`, `updateMember`, `removeMember`),
  invitations (`listInvitations`, `createInvitation`, `revokeInvitation`, `acceptInvitation`;
  `inv_`), multi-account sessions (`listMemberships`, `switchSessionAccount`), restricted keys
  (`createApiKey` accepts `type: restricted` + `scopes`; `updateApiKey`), two-approver rule
  (`approveSettlementDestination`, optional `SettlementDestination.approval`), audit export
  (`listAccountAuditEvents`, `AuditEvent`, `aud_`). `Registration` gains optional `purpose` and
  `invitation`. Identity's service client gains `compliance.read` (reads the approved KYB details).
- **Self-declared KYB** — `KybProfile` (legal name, country of incorporation, registration number,
  business type, website, address, representative, expected monthly volume band), `getKyb`,
  `updateKybProfile`, `submitKyb` (`kyb_profile_incomplete`); `KybCase` gains optional `profile`,
  `editable`, `requested_info`, `submitted_at`, `decided_at`; `vendor_flow_url` is always null.
  Status values unchanged (`pending` = submitted for review). Event `evt.compliance.kyb.submitted`;
  `KybDecisionEvent.requested_info?`; internal `getInternalKybCase`. `Screening.provider?`
  (`local` | `sandbox`) behind the vendor-neutral interface.
- **Webhooks** — `rotateWebhookEndpointSecret` (overlap ≤ 24 h,
  `WebhookEndpoint.previous_secret_expires_at?`), `resendEvent` (`EventResend`); webhook types
  `account.updated`, `review.opened`, `review.closed` (payload `PublicReview`, see payments; the bus
  `Review` stays in `@nearpay-internal/spec`); webhooks now consumes `evt.identity.account.updated` and
  `evt.compliance.review.*`.
- **Notify / events** — `sendMessage` templates `team.invitation` and `ops.enrolment`; subjects
  `evt.identity.member.added|removed|role_changed`, `evt.identity.settlement_destination.pending_approval`,
  `evt.compliance.account.action_requested`, `evt.sentinel.kill_switch.release_requested` (all → notify).
- Errors: `last_owner`, `member_exists`, `invitation_invalid`, `approver_conflict`,
  `two_person_required`, `authenticator_not_allowed`, `kyb_profile_incomplete`.
- ID prefixes: `inv` (invitation), `aud` (audit event), `opa` (ops approval), `bl` (blocklist entry).

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

### rails-fx

Stage 2 step 2.1 contracts for rails pricing/FX, the Explorer feed, the observation archive,
reconciliation evidence, and open change requests (`nearpay-brain` `lld/rails.md`
v1.3, `lld/sandbox.md` v1.3, ADR-0020 decision 5). All additive.

- **1Click live shape (mainnet finding 2026-11-07).** Every optional field of the `OneClick*` schemas is
  now `nullish` (live 1Click sends `null` for unset fields), `OneClickAppFee.limitOrderId` is
  accepted, and `OneClickStatusResponse.quoteResponse` is the new `OneClickStatusQuoteResponse`
  (`OneClickQuoteResponse` with `correlationId` optional — live `GET /v0/status` omits it). The
  recorded live status body (`test/fixtures/oneclick-status-pending-live.json`) parses unmodified.
  Readers: **nearpay-rails**, **nearpay-sentinel** (drop body normalisation; TS types of those
  fields become `T | null | undefined`). Producer: **nearpay-sandbox** (may serve the live shape).
- **Explorer wire schemas** (`@nearpay-internal/spec`): `ExplorerTransactionsQuery`,
  `ExplorerTransaction`, `ExplorerTransactionList`, `ExplorerError`, `EXPLORER_STATUSES` for
  `GET explorer.near-intents.org/api/v0/transactions` (docs read 2026-11-07). Sandbox mirror
  `sandboxExplorerTransactions` — `GET /api/v0/transactions` (stage 2) so the rails Explorer feed runs
  in test mode. Producer: **nearpay-sandbox**; reader: **nearpay-rails**.
- **Exact rates** (`@nearpay-internal/spec`, `src/internal/pricing.ts`): `Ratio` `{num, den}` (integer
  strings), `RateDecimal` (display only), `RateSource` (`oneclick|coingecko|ecb|sandbox|fixed`, open),
  `RateRole`, `PriceRate` (base, quote, kind, role, source, value, decimal, `as_of`, `fetched_at`,
  `valid_until`), `FxRate` (currency, exponent, available, stale, `reference_date`, rate).
- `PriceSnapshot` gains optional `currency`, `par_currency`, `rates[]` (rails 0.2.0+ always sends
  `currency` and `rates`). `InternalAsset` gains optional `peg_currency`, `par_ok`, `prices[]`, `token`.
  `InternalPaymentOption` gains optional `token`. `createExecution` may return `currency_unsupported`
  and `fx_rate_unavailable` (non-USD pricing).
- New rails routes (stage 2): `listFxRates` `GET /internal/fx-rates` (service/ops `rails.read`),
  `estimateSettlement` `GET /internal/settlement-estimate` (service/ops `rails.read`),
  `listExecutionObservations` `GET /internal/executions/{id}/observations` (service/ops `rails.read`),
  `getEvidenceSummary` `GET /internal/evidence/summary` (service/ops `rails.read`). Schemas `FxRates`,
  `SettlementEstimate`, `ObservationSource`, `ProviderObservation`, `ProviderObservationPage`,
  `EvidenceSummary`. Implementer: **nearpay-rails**. Readers: **nearpay-payments** (fx-rates, estimate,
  evidence summary), **nearpay-sentinel** (evidence summary), console via the identity-console `/ops/…`
  routes (which reference `Execution`, `ProviderObservation`, `EvidenceSummary`).
- `listEvidence` accepts optional `states` (`succeeded|refunded|failed`, comma list) and `kind`, and
  `ops:rails.read`; the 0.1.5 query is unchanged in meaning (default: `succeeded`, both kinds).
- New error `fx_rate_unavailable` (503, `rail_unavailable`, retryable).
- **CR-15-06** `TokenContract` `{standard: erc20|native|nep141|spl|other (open), address|null}`;
  optional `PaymentOption.token` (public) and `InternalPaymentOption.token`. Producers: **nearpay-rails**
  → **nearpay-payments**; reader: **nearpay-checkout**.
- **CR-15-07** optional `Attestation.asset` `{asset_id, symbol, decimals}` of the asset the payer sends.
  Producer: **nearpay-sentinel**; reader: **nearpay-checkout**, `@nearpay/agent-signer`.
- **CR-15-04** optional `DestinationSnapshot.fingerprint`; types `WebhookObjectOf<T>`, `TypedEvent` and
  schema `EventDataObject` (typed `data.object` per event type). Producer: **nearpay-payments**;
  readers: **nearpay-dashboard**, **nearpay-node**.
- **CR-15-15** `getPayerCheckoutSession` — `GET /internal/checkout_sessions/{id}/payer` (payments,
  `service:payments.read`, `X-NearPay-Client-Secret` header) → `PayerSessionContext`
  `{account_id, livemode, session: PublicCheckoutSession}`. Implementer: **nearpay-payments**;
  reader: **nearpay-agentpay** (replaces its call to the public session route).
- **CR-15-10** needs no change: `ping` has been a `WebhookTypeSchema` value since 0.1.0 (test added).

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
