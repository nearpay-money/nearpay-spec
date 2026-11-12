# Changelog

`@nearpay-money/spec` and `@nearpay-internal/spec` share one version. Within a version line changes are
additive only (`pnpm compat` gates every release against `test/compat/baseline/`, the last release).

## 0.5.2 — 2026-11-12

Asset id shapes (incident 2026-11-11 18:58 UTC: sentinel read a genuine `nep141:bnb-0x….omdep.near` deposit as a NEAR asset
and refused it with "R4 deposit chain differs"; ADR-0028). Additive: new pure helpers and constants, one test-vector file;
no route, object, event or error changes.

- **`parseAssetId(assetId)`** → `AssetIdInfo`: PoA bridge ids with either suffix (`omft`, `omdep`; `kind` native / evm /
  hash20 / bridged, Solana SPL hash20 written `sol-<hex>` or `sol-0x<hex>`), `1cs_v1:<chain>:<standard>:<address>`, NEAR
  NEP-141, or `unknown`. Safety rule: a NEP-141 account that looks bridged (`<prefix>-0x<40 hex>.…`, `<chain>.<x>.near`,
  `<chain>[-…].om….near`) is `unknown`, never NEAR.
- **`assetIdBlockchain(assetId)`**: the 1Click `blockchain` code the id names, or null (not derivable — skip a chain
  check, never fail one). **`BRIDGE_PREFIX_ALIASES`** (`bnb` → `bsc`), **`blockchainOfPrefix`**, **`BRIDGE_SUFFIXES`**,
  **`KNOWN_CHAIN_PREFIXES`**.
- `parseOmftAssetId` is unchanged (omft only); use `parseAssetId` to know an asset's chain.
- **Test vectors:** `test-vectors/asset-ids.json` (real ids of the live 1Click list, both suffixes, the `bnb` prefix,
  `1cs_v1`, safety-rule probes).

## 0.5.1 — 2026-11-11

Continue with Google for the merchant dashboard (ADR-0026, owner decisions 2026-11-11; identity LLD §22). Additive:
new routes, objects, error codes, events and constants; one optional response field; three existing routes list
new error codes; the route type admits a `303` redirect.

- **Routes (identity, stage 4):** `getAuthMethods` `GET /v1/auth/methods` (anonymous; `AuthMethods {passkey,
  google}` — the dashboard shows the Google button only when identity has a Google client), `startGoogleSignIn`
  `POST /v1/auth/google/start` (anonymous; body `{intent?: signin|signup, next?}` → `GoogleAuthorization
  {authorization_url, expires_at}` + the flow cookie `__Host-np_google`), `googleCallback` `GET
  /v1/auth/google/callback` (anonymous, Google's redirect target, always a `303` to a dashboard page — success or
  `?google_error=<GoogleSignInError>`; its query is loose because Google appends `scope`, `authuser`, `hd`, …),
  `startGoogleLink` `POST /v1/auth/google/link` (session + step-up), `listLinkedIdentities` `GET
  /v1/auth/linked_identities` (session), `unlinkIdentity` `DELETE /v1/auth/linked_identities/{provider}` (session +
  step-up; refused without a passkey). The three anonymous routes join `PUBLIC_ANONYMOUS_ROUTES`.
- **Objects and constants:** `AuthMethods`, `GoogleAuthorization`, `LinkedIdentity` (+ `LinkedIdentityList`),
  `AuthProvider` / `AUTH_PROVIDERS` (`google`), `GoogleSignInError` / `GOOGLE_SIGNIN_ERRORS` (open),
  `GOOGLE_FLOW_COOKIE`, `GOOGLE_FLOW_TTL_SECONDS` (600), `PASSKEY_SETUP_WINDOW_SECONDS` (600),
  `GOOGLE_CALLBACK_DASHBOARD_PATH` (`/api/auth/google/callback`).
- **`DashboardSession.sign_in`** (optional): `{method: passkey|google|recovery (open), passkeys, google_linked,
  passkey_setup_until}`.
- **Errors:** `google_signin_disabled` (404), `google_already_linked` (409), `passkey_required` (403; also on
  `stepUpOptions` for a user without a passkey), `reauthentication_required` (401; also on
  `passkeyRegistrationOptions` / `passkeyRegistrationVerify`: a Google-only user adds a first passkey only within
  10 minutes of a Google sign-in).
- **Events (`@nearpay-internal/spec`):** `evt.identity.user.google_linked` / `.google_unlinked`
  (`UserSignInMethodEvent {user_id, provider, account_ids, occurred_at}`, ids only; aggregate
  `user_sign_in_methods`, added to the documentation enum `AggregateType`; consumer notify — template follow-up).
- **Route type:** `SuccessStatus` gains `303`; `route()` requires a 303 route to be a bodyless `GET` with
  `responseHeaders`. Servers on kit 0.3.x write such a redirect themselves (the kit binding emits 2xx only).

**Compatibility notes.** New paths, optional response fields, open-enum values (error codes, sign-in method) and
new response codes on three existing routes; no request field became required, nothing was removed or narrowed.
Expected oasdiff result against the 0.4.1 baseline: no findings at `ERR`. `pnpm compat` not run for this release
(oasdiff binary / Docker Hub image unavailable in the build sandbox, as for 0.4.2); every other `pnpm verify` step
passes.

## 0.5.0 — 2026-11-11

Package rename, no contract change (ADR-0025). The public package is published as **`@nearpay-money/spec`**
(npm org `nearpay-money`); the `@nearpay` npm scope belongs to an unrelated company, and the earlier
`@nearpay/spec` versions were only ever on NearPay's local registry, so every reference in this changelog now
uses the new name. `@nearpay-internal/spec` 0.5.0 depends on `@nearpay-money/spec` 0.5.0. Minor bump on 0.x
because consumers must change their dependency name and imports (`@nearpay/spec` → `@nearpay-money/spec`);
schemas, routes, events, webhooks, vectors and error codes are identical to 0.4.2.

- Package metadata for the public registry: `repository`, `homepage`, `bugs`, `keywords`, `author`,
  `publishConfig` (`access: public`, provenance).
- `.github/workflows/release.yml`: on a `v*` tag (or manual run) verifies and publishes `@nearpay-money/spec` to
  npm (skips a version that is already there). `@nearpay-internal/spec` is never published to npm.

## 0.4.2 — 2026-11-11

Confirmation samples brought to ADR-0022 as amended by the owner (2026-11-10 17:10): every chain confirms on
ONE block of its own consensus — EVM 1 block (Ethereum included), Solana `confirmed` commitment, Bitcoin
family 1 confirmation for every amount (no USD tiers by default), NEAR `final` (unchanged). Patch release:
descriptions, examples, test vectors and one new constant; no schema, route, event, webhook type or error
code added or removed.

- **Test vectors** (`chains-solana-bitcoin.json`): Solana profile `finality` `"solana: finalized commitment"`
  → `"solana: confirmed commitment"`; Solana evidence `finality` `finalized` → `confirmed` and the parsing
  `rule` reads at `commitment: 'confirmed'` (`processed` never counts; rails re-checks at `finalized` after
  success). Bitcoin profile `finality` `"bitcoin: 1 confirmation below USD 1,000, else 2"` →
  `"bitcoin: 1 confirmation"`, `confirmation_tiers` → `[{below_usd_micros: null, confirmations: 1}]`;
  `evidence.bitcoin.tiers` / `required_confirmations` are the default (1 for every amount), case 1 ("USD
  1,000 payout, 1 confirmation") now passes with evidence (`required_confirmations: 1`; was `not_final`),
  case 2 records `required_confirmations: 1`. Case order and count unchanged. The Stage 4 USD tiers move to
  the new keys `override_tiers` / `override_required_confirmations` (opt-in profile example).
- **`BITCOIN_DEFAULT_CONFIRMATION_TIERS`** (new export, `[{below_usd_micros: null, confirmations: 1}]`): the
  default rails applies when a profile sets no `confirmation_tiers`. **`BITCOIN_CONFIRMATION_TIERS` is
  unchanged** (1 below USD 1,000, else 2) and documented as the opt-in override; sentinel's independent audit
  keeps using it as a stricter second check.
- **Descriptions:** `Evidence.finality` (which value each chain records), `BitcoinEvidence.required_confirmations`,
  `ChainProfile.finality` and `ChainProfile.confirmation_tiers` (no more "Bitcoin: 1 below USD 1,000, else 2" /
  "Solana `finalized`" / "EVM `finalized`" defaults), `SolanaEvidence` doc comment.
- Open onboarding (ADR-0024, owner decision 2026-11-10; documentation only, previously unreleased):
  `submitKyb`, `KybCase`, `KybProfile`, `OpsKybCase` and `KybSubmittedEvent` describe the automatic decision on
  submission (compliance `NP_KYB_MODE=auto`) and that `registration_number` is optional; the
  `kyb_profile_incomplete` example no longer lists `registration_number`.

**Compatibility notes.** Description text, one new exported constant and test-vector values only; no request
or response shape changed, no required set grew, no enum changed. Expected oasdiff result against the 0.4.1
baseline: no findings at `ERR` (`pnpm compat` not run for this release: oasdiff/Docker Hub unavailable in the
build sandbox). Consumers that assert the old vector values (rails adapted its tests to them) must bump.

## 0.4.1 — 2026-11-09

Stage 4 change requests on top of 0.4.0 (additive; no route, event, webhook type or error code added).

- **`token_asset`** (checkout CR): optional `PricingAssetDisplay` (`asset_id`, `symbol`, `decimals`) on
  `MandateFundingInstructions` (`POST /v1/mandates/prepare`, `POST /v1/invoices/{id}/public/mandate_funding`)
  and `PublicMandate` (`GET /v1/invoices/{id}/public/mandate`), so the funding UI and the hosted invoice page
  render the mandate token without a registry call. Same shape billing already returns on
  `MandateNotificationContext.token_asset`. Optional because billing builds on 0.4.0 do not send it.
- **`MANDATE_FUNDING_PAYER_NOTICE`** text corrected: "You can cancel at any time from any NEAR wallet and get
  the remaining balance back." → "You can cancel at any time from the NEAR account you pay with; the
  remaining balance goes back to it." (the vault accepts `cancel`/`withdraw` only from the paying account).
  The `payer_notice` field description, the `getPublicInvoiceMandate` description and
  `MandateNotificationContext.onchain_id` now say the same.

**Compatibility notes.** Two new optional response properties and description text only; no request
change, no required set grew, no enum changed. Expected oasdiff result against the 0.4.0 baseline: no
findings at `ERR`.

## 0.4.0 — 2026-11-08

Stage 4 contract freeze (step 4.1, `nearpay-brain/roadmap/development-plan.md` §6): auto-debit
(subscription-vault mirror with byte-exact events/errors and shared test vectors, billing mandates,
hosted mandate funding, mandate events/webhooks/emails, the sandbox vault stand-in for test mode —
OQ-T-03) and chain coverage (Solana and Bitcoin as Tier A chains: chain helpers, `Evidence.solana` /
`Evidence.bitcoin`, Solana and BIP-322 destination attestation, chain test vectors). Additive over 0.3.1:
no route, field, parameter, status or enum value was removed or renamed, no request field or parameter
became required, no response field was tightened; every new response field on an existing object is
optional (or nullable). Totals: 151 public (+8), 62 internal (+5) and 47 console routes, 80 domain event
subjects (+9), 41 webhook types (+8), 89 error codes (+2, `since: "0.4.0"`), 41 ID prefixes (unchanged;
`md` was reserved in 0.1.x), 4 new test-vector files.

**Compatibility notes.** `pnpm compat` (oasdiff 1.34.1) against the 0.3.1 baseline reports five
`ERR` findings in `openapi/public.yaml`; internal OpenAPI, `compat/events.yaml` and `compat/webhooks.yaml`
are clean. Each finding was reviewed and is intentional, so the baseline moves to 0.4.0 in the release PR:

- **New event types in the `Event` union** (`GET /v1/events`, `GET /v1/events/{id}`,
  `GET /v1/events/stream`, `POST /v1/webhook_endpoints/{id}/test`: `response-body-one-of-added` /
  `response-property-one-of-added`, 4 findings; +8 variants `mandate.*`). Backward-compatible by api-conventions §1 (clients MUST tolerate
  unknown event types), same finding and ruling as 0.2.0 and 0.3.0.
- **`SubscriptionCreate.collection_method`** `const: send_invoice` → `enum: [send_invoice, auto_debit]`
  (`POST /v1/subscriptions` request; optional, default unchanged). oasdiff reports
  `request-property-became-enum` because it does not read the baseline's `const` as a one-value enum; the
  change is a request widening (every request valid under 0.3.1 stays valid), not a break.
- **`CollectionMethod` += `auto_debit`** in responses (`Invoice.collection_method`,
  `Subscription.collection_method`, list filters). Open enum (`x-extensible-enum`) since 0.3.0: clients
  must tolerate unknown values; not a finding.
- **`attestSettlementDestination.body.standard`** closed request enum += `solana`, `bip322`. Request
  widening; not a finding.
- **`AggregateType` closed enum += `mandate`, `vault_mandate`** (`src/events/catalogue.ts`).
  Documentation only (the envelope's `aggregate.type` is a plain string); TypeScript code that switches
  exhaustively over `AggregateType` gains two cases. Same ruling as 0.2.0/0.3.0.
- Open-enum additions (`ErrorBody.code`, `WebhookDelivery.event_type`, webhook endpoint `enabled_events`,
  `streamEvents` `types`), new optional response fields (`Evidence.solana|bitcoin`, `Subscription.mandate`,
  `Invoice.mandate|mandate_collection`, `PublicInvoice.auto_debit`, `ChainProfile.*`, `SimTx.*`, sandbox
  intents event items) and new operations are additive and not findings.

### autodebit

Stage 4 step 4.1 auto-debit contracts (`lld/billing.md` v1.10 §14, `lld/sandbox.md` v1.6 §3.1/§4.2,
`lld/rails.md` §8.6, `lld/notify.md` §4, `lld/webhooks.md` §4; OQ-T-03 resolved). Additive over 0.3.1.

- **Vault mirror** (`src/vault/contract.ts`, public): `nearpay_vault` NEP-297 event schemas
  (`VaultEvent`: `mandate_created`, `topped_up`, `collected`, `collect_failed`, `canceled`, `withdrawn`,
  `exhausted`), `formatVaultEventLog` / `parseVaultEventLog` (byte-identical to the contract's lines),
  the 17 `ERR_*` strings (`VAULT_ERRORS`, incl. `ERR_UNSUPPORTED_SENDER`, `ERR_GAS`), the
  `ERR_CAP_EXCEEDED: mandate|tvl` log lines, check orders, `vaultErrorCodeOf`, `msg` schemas and
  `vaultMsgJson`, view schemas (`get_mandate`, `get_mandates_by_payer`, `next_collect_at`, `get_config`,
  `get_token_tvl`, NEP-145), limits, gas (`VAULT_GAS`: keeper 250 Tgas, floors 170/50 Tgas), `vaultSplit`,
  `vaultPeriodSecs` (month = 2 629 746 s, year = 31 556 952 s).
- **Test vectors** `test-vectors/vault.json`: every event line, error string, rejection line, view result,
  msg serialisation and the RPC failure/success shapes; `test/fixtures/vault-contract-wire.json` holds the
  same strings produced by the contract's own code (nearpay-contracts `7e2585a`) and the test suite
  asserts byte equality.
- **Mandates** (`src/public/mandates.ts`): `Mandate` (`md_`), `MandateFundingInstructions`
  (`NearTransactionRequest`s, exact `msg`, storage deposit, `payer_notice`), `PublicMandate`,
  `MandateCancelInstructions`, `MandateSimulation`. Routes: `prepareMandate` `POST /v1/mandates/prepare`,
  `getMandate`, `listMandates`, `prepareMandateCancel` `POST /v1/mandates/{id}/prepare_cancel`, hosted page
  `createPublicInvoiceMandateFunding` `POST /v1/invoices/{id}/public/mandate_funding` and
  `getPublicInvoiceMandate` `GET /v1/invoices/{id}/public/mandate` (invoice secret), test helpers
  `simulateMandateFunding` `POST /v1/test_helpers/mandates/fund` and `simulateMandatePayerAction`
  `POST /v1/test_helpers/mandates/{id}/payer_action`. Scopes: `subscriptions.read|write` (no new scopes).
- **Billing objects**: `CollectionMethod` += `auto_debit`; `createSubscription` / `updateSubscription`
  accept `collection_method: auto_debit`; optional `Subscription.mandate`, `Invoice.mandate`,
  `Invoice.mandate_collection`, `PublicInvoice.auto_debit`.
- **Events**: `evt.rails.vault.event` (`VaultEventRecord`: vault, tx, receipt, log index, final block,
  block time, event; rails → billing); `evt.billing.mandate.{activated,collected,insufficient_funds,
  canceled,exhausted,updated,unlinked,released}`; aggregates `mandate`, `vault_mandate`.
- **Webhook types**: `mandate.{activated,collected,insufficient_funds,canceled,exhausted,updated,unlinked,
  released}` (object `Mandate`).
- **Errors** (since 0.4.0): `auto_debit_unavailable`, `vault_cap_exceeded`.
- **Internal**: `getMandateNotificationContext` `GET /internal/mandates/{id}/notification-context`;
  notify templates `mandate.{activated,insufficient_funds,canceled,unlinked,released}`; NEAR JSON-RPC
  subset schemas (`NearRpcRequest`/`NearRpcResponse`, `NearFinalExecutionOutcome`, `nearPanicStatus`);
  keeper rules as data (`VAULT_KEEPER_ON_TX_FAILURE`, `VAULT_KEEPER_RULES`); billing's service client
  gains `sandbox.use`.
- **Sandbox vault stand-in** (OQ-T-03): `sandboxNearRpc` `POST /sim/near-rpc`,
  `sandboxVaultFtTransferCall` `POST /sim/vault/ft_transfer_call`, `sandboxVaultCall`
  `POST /sim/vault/call`, `sandboxVaultAdvance` `POST /sim/vault/advance`; `GET /sim/intents/events`
  items gain optional `receipt_id`, `log_index`, `executor_id`, `block_hash`, `block_timestamp`,
  `receipt_status`; scenarios by `amount_per_period` suffix 91–94 (`vaultSandboxScenarioOf`).

### chains

Stage 4 step 4.1 chain coverage — Solana and Bitcoin as Tier A chains (`lld/rails.md` §21, identity §8.2,
sentinel §16, sandbox §10, checkout §5.4). Additive over 0.3.1: one request enum widened, optional response fields, new schemas/helpers and test vectors. No new routes, events, webhook types or error codes.

- **New module `src/common/chains.ts`** (public): `SOLANA_MAINNET` (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`), `BITCOIN_MAINNET` (`bip122:000000000019d6689c085ae165831e93`), `SolanaAddress`, `SolanaSignature`, `BitcoinTxid`, `BitcoinDestinationAddress` (P2WPKH/P2TR, lower-case), `BitcoinAddressType`, `DESTINATION_SIGNING_STANDARDS`, `SolanaEvidence`, `BitcoinEvidence`, `ConfirmationTier`, `BITCOIN_CONFIRMATION_TIERS` (1 confirmation below USD 1,000, else 2), helpers `formatBaseUnits`, `bip21Uri`, `solanaPayUri`, `parseOmftAssetId`, `requiredConfirmations`.
- **`Evidence.solana` / `Evidence.bitcoin`** (nullable, optional): Solana signature, slot, block time, mint, token program, owner, token accounts, pre/post balance; Bitcoin txid, outputs (`vout`, value, scriptPubKey), block height/hash, confirmations, required confirmations. Flows into every schema embedding `Evidence` (executions, payment intents, refunds, their events and webhooks).
- **`attestSettlementDestination.body.standard`** += `solana`, `bip322` (request enum widened). Signature formats: Solana base58 64-byte ed25519 over the raw challenge bytes; BIP-322 base64 "simple" witness (P2WPKH, P2TR). `public_key` stays NEP-413-only.
- **`ChainProfile.explorer_address_url`**, **`ChainProfile.confirmation_tiers`** (nullable, optional; internal rails).
- **Sandbox `SimTx`**: `block_ref`, `confirmations` (Bitcoin), `failed` (Solana `meta.err`); `transfers[].vout` (Bitcoin), `transfers[].token_account` (Solana SPL) — all optional.
- `TokenContract.address` description: SPL mint for `spl` (doc only).
- **Test vectors** (`codegen/vectors-chains.ts`, verified independently in `test/vectors-chains.test.ts`): `chains-solana-bitcoin.json` (profiles, assets from the live 1Click registry, address rules, omft ids incl. the SPL rule `nep141:sol-<hex(keccak256(mint)[12..32])>.omft.near`, payment URIs, evidence parsing from RPC results), `destination-attestation.json` (challenge message, Solana ed25519 cases, BIP-322 upstream vectors + NearPay P2WPKH/P2TR cases), `solana-transfer.json` (checkout wallet-path instructions: SOL transfer, ATA create-idempotent + SPL `transferChecked`).
- Dev dependencies: `@scure/base` 2.4.0, `@scure/btc-signer` 2.4.1 (vector verification only).

### integration

- Merged autodebit and chains (conflicts were adjacent appends only: this file and the
  `codegen/vectors.ts` header/outputs list; lockfile and generated artifacts regenerated, no drift).
  Cross-cutting checks in `test/integration-stage4.test.ts`: the events stream renders every `mandate.*`
  webhook type, `CLI_KEY_SCOPES` covers every restricted-key scope on mandate routes, the anonymous
  allow-list carries the hosted mandate routes (`POST …/public/mandate_funding`, `GET …/public/mandate`),
  vault types stay NEAR NEP-141 only (a Solana mint is rejected; `vault.json` names no Solana/Bitcoin
  chain or omft asset), `Evidence` is one `$ref`'d component carrying `sender`/`solana`/`bitcoin` (no
  inline copies), and `DESTINATION_SIGNING_STANDARDS` equals the attestation request enum.
  `MandateCollection` / `Invoice.mandate_collection` cite the vault receipt as evidence and do not embed
  `Evidence` (by design: the vault's `collected` event is the proof, INV-2).
- LLD references follow the brain integration's renumbering (billing v1.10 §14, `prepare` notice
  billing v1.9 §5; rails v1.11/v1.12, sandbox v1.6/v1.7).
- Version 0.4.0 in both packages, the root package and `SPEC_VERSION` / `SPEC_INTERNAL_VERSION`.

## 0.3.1 — 2026-11-08

Stage 3.2 change requests from the service builders (payments, rails, billing, notify, agentpay,
identity). Additive over 0.3.0: no route, field, parameter, status or enum value was removed or renamed,
no request field or parameter became required, no response field was tightened; every new response field
is optional. No new error codes, events or webhook types. Totals: 143 public (+1), 57 internal and 47
console routes, 71 domain event subjects, 33 webhook types, 87 error codes.

| Change request                                                                                                                                                                                                                                                                                                                                                                                           | Status                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| rails `getEvidenceSummary` `?owner=` (`ExecutionOwner`, optional): filters `totals`, `tier_b`, `digest`, `in_flight`, `held_open`; `complete` stays account-wide                                                                                                                                                                                                                                         | done                                                                                                                         |
| sandbox `SimTx.transfers[].from` (`ChainAddress`, nullable, optional) for `Evidence.sender`                                                                                                                                                                                                                                                                                                              | done                                                                                                                         |
| `createPublicInvoiceSession` errors += `amount_below_destination_minimum`, `amount_above_unverified_cap`, `customer_deleted`, `state_conflict` (supersedes billing LLD §12 d18 mappings)                                                                                                                                                                                                                 | done                                                                                                                         |
| `createSubscription` errors += `invoice_empty` (zero-total first invoice)                                                                                                                                                                                                                                                                                                                                | done                                                                                                                         |
| `createInvoiceCheckoutSession`, `createCheckoutSession` errors += `fx_rate_unavailable`                                                                                                                                                                                                                                                                                                                  | done                                                                                                                         |
| `x402NearIntentsRequirements`, `x402Requirements` errors += `pricing_unavailable`                                                                                                                                                                                                                                                                                                                        | done                                                                                                                         |
| `createCliLogin` += `rate_limited`; `pollCliLogin` += `rate_limited`, `resource_missing`                                                                                                                                                                                                                                                                                                                 | n/a — generic codes (every route's `default` response; route tables may not list them); the route descriptions document them |
| `InvoiceNotificationContext` += `subtotal`, `tax` (`PricingAmount`), `line_count` (int ≥ 0), `destination_fingerprint` (string, nullable) — all optional                                                                                                                                                                                                                                                 | done                                                                                                                         |
| billing test helper `advanceSubscriptionClock` `POST /v1/test_helpers/subscriptions/{id}/advance_clock` `{target: renewal_upcoming \| renewal \| overdue}` → `SubscriptionClockAdvance`; test mode only (`livemode_forbidden`), `secret_key` / `restricted_key:subscriptions.write` / session (owner, admin, developer), `Idempotency-Key`; per-subscription forward-only clock offset (billing LLD §13) | done                                                                                                                         |
| optional `evt.billing.invoice.overdue` → notify; sandbox official test refund addresses (payments LLD §21.5)                                                                                                                                                                                                                                                                                             | not in this release (no contract change requested)                                                                           |

**Compatibility notes.** Semantic comparison of every gated document against the 0.3.0 baseline
(`briefs/compat-0.3.1.md`; oasdiff cannot run in the container): no non-additive change. Additions: one
operation (`advanceSubscriptionClock`), one optional query parameter (`getEvidenceSummary.owner`), five
optional properties (`InvoiceNotificationContext` ×4, `SimTx.transfers[].from`), new error statuses on
four operations (`createCheckoutSession` 503, `createInvoiceCheckoutSession` 503, `x402Requirements` 503,
`createPublicInvoiceSession` 422) and new codes under existing statuses on three
(`createPublicInvoiceSession` 409, `createSubscription` 422, `x402NearIntentsRequirements` 503). Expected
oasdiff output: no `ERR` findings.

## 0.3.0 — 2026-11-08

Stage 3 contract freeze (step 3.1, `nearpay-brain/roadmap/development-plan.md` §5): billing (products,
prices, tax rates, invoices, hosted invoices, subscriptions, billing emails) and agent commerce
(cross-chain x402 `near-intents`, events SSE stream, CLI device login, `nearpay trigger` test helper).
Additive over 0.2.1: no route, field or enum value was removed or renamed, no request field or parameter
became required, no response field was tightened; every new response field on an existing object is
optional (or nullable). Totals: 142 public (+40), 57 internal (+6) and 47 console routes, 71 domain
event subjects (+13), 33 webhook types (+12), 87 error codes (+10, `since: "0.3.0"`), 41 ID prefixes
(+3: `txr`, `il`, `si`).

**Compatibility notes.** The oasdiff gate cannot run in the integration container (Docker Hub blocked),
so the integrator compared every gated document (`openapi/public.yaml`, `openapi/internal/*.yaml`,
`compat/events.yaml`, `compat/webhooks.yaml`) semantically against the 0.2.1 baseline (full list:
`briefs/compat-0.3.0.md`). Each non-additive-looking change was reviewed and is intentional; the lead
confirms with oasdiff in CI before moving the baseline:

- **New event types in the `Event` union** (`GET /v1/events`, `GET /v1/events/{id}`,
  `POST /v1/webhook_endpoints/{id}/test`: expected `response-body-one-of-added`, 3 findings; +12
  variants `invoice.*` / `customer.subscription.*`). Backward-compatible by api-conventions §1 (clients
  MUST tolerate unknown event types), same finding and ruling as 0.2.0.
- **`AggregateType` closed enum += `invoice`, `subscription`** (`src/events/catalogue.ts`). Documentation
  only: no emitted schema references it (the envelope's `aggregate.type` is a plain string), so oasdiff
  cannot flag it; TypeScript code that switches exhaustively over `AggregateType` gains two cases.
  New aggregates for new subjects, as in 0.2.0.
- Open-enum (`x-extensible-enum`) additions — `ErrorBody.code`, `WebhookDelivery.event_type`, webhook
  endpoint `enabled_events`, `streamEvents` `types` — and new auth alternatives on
  `advancePaymentAttempt` / `simulateRefundDeposit` (`restricted_key:checkout_sessions.write` /
  `refunds.write`) are additive and not findings.

### billing

Stage 3 billing contracts (step 3.1; `lld/billing.md` v1.2 §11, ADR-0008). Additive over 0.2.1:
+30 public routes, +6 internal routes, +13 domain event subjects, +12 webhook types, +10 error codes
(since 0.3.0), +3 ID prefixes (`txr_`, `il_`, `si_`).

- **Catalogue** (`billing-catalog.ts`, scope `products.*`, roles owner/admin/developer/finance): `Product`,
  `Price` (one-time or recurring `{interval: day|week|month|year, interval_count 1–12}`, fiat or asset
  pricing, immutable except `active`/`nickname`/`metadata`), `TaxRate` (exact decimal `percentage` ≤ 4
  decimals + `rate_ppm`, `inclusive`, `jurisdiction`, `country`; percentage/inclusive immutable).
  Create/get/list/update for each; no deletes (archive with `active: false`).
- **Normative arithmetic** exported from `@nearpay-money/spec`: `taxPercentageToPpm`, `divRoundHalfUp`,
  `computeLineTax`, `computeInvoiceTotals` (bigint; tax per line, round half-up; inclusive
  `amount × ppm / (10⁶ + Σppm)`; no mixing inclusive/exclusive on one line) and `periodBoundary`
  (anchor-based calendar months, clamped to month end). Vectors: `test-vectors/billing-tax.json`.
- **Invoices** (`invoices.ts`, scope `invoices.*`, roles owner/admin/finance): `Invoice` (+ `InvoiceLineItem`,
  `InvoiceTaxAmount`; totals `subtotal`, `tax`, `total`, `total_excluding_tax`, `total_tax_amounts`,
  `amount_due|paid|remaining`; `collection_method` open enum, `send_invoice` only in v1; `reminder_days`;
  `hosted_invoice_url`; `payment_intents`; `sequence`), create/get/list/update (drafts; metadata always)/
  delete (drafts)/`finalize`/`send`/`void`/`mark_uncollectible`, and `GET /v1/invoices/{id}/pdf`
  (`application/pdf`). No "paid out of band" (INV-2).
- **Hosted invoice payer routes** (anonymous at the gateway, header `X-NearPay-Invoice-Secret`, error
  `invoice_secret_invalid`): `getPublicInvoice` (read-only `PublicInvoice`), `createPublicInvoiceSession`
  (create or continue the invoice's checkout session → `InvoicePaymentSession`), `getPublicInvoicePdf`.
  `PUBLIC_ANONYMOUS_ROUTES` gains `GET|POST /v1/invoices/{id}/public/**`.
- **Subscriptions** (`subscriptions.ts`, scope `subscriptions.*`): `Subscription` (+ `SubscriptionItem`,
  `DunningSettings`), create/get/list/update (`PATCH`, applies from the next renewal;
  `proration_behavior` accepts only `none`)/`cancel` (`at_period_end`). Trials via `trial_period_days`.
- **Payments pieces**: `PaymentIntent.invoice`, `CheckoutSession.invoice` (optional, nullable),
  `listPaymentIntents?invoice=`; internal `createInvoiceCheckoutSession` (`POST /internal/checkout_sessions`),
  `getInternalCheckoutSession`, `expireInvoiceCheckoutSession`, `getInternalCustomer`. Billing consumes
  `evt.payments.payment_intent.succeeded|payment_failed` and `evt.payments.checkout_session.expired`.
- **Events** (`EVT_BILLING`): `evt.billing.invoice.{created,finalized,sent,paid,payment_failed,overdue,voided,marked_uncollectible}`
  (`InvoiceEvent`: `hosted_invoice_url` always null), `evt.billing.invoice.reminder` (`InvoiceReminderEvent`,
  notify only), `evt.billing.subscription.{created,updated,deleted,renewal_upcoming}`. Webhook types
  `invoice.*` (8) and `customer.subscription.*` (4); `invoice.sent` is new to api-conventions §9.
- **Billing emails** (event-driven): notify reads `getInvoiceNotificationContext` /
  `getSubscriptionNotificationContext` (`service:billing.read`); `BILLING_EMAIL_TEMPLATES` maps
  `invoice.issued|reminder|paid|voided` and `subscription.renewal_upcoming` to subjects and contexts.
- **Scopes**: billing's service client also holds `identity.context.read` and `rails.read`.
- **Errors** (0.3.0): `currency_mismatch`, `interval_mismatch`, `price_inactive`, `price_type_invalid`,
  `tax_rate_inactive`, `tax_rates_mixed`, `invoice_empty`, `customer_email_missing`,
  `invoice_secret_invalid`, `invoice_not_payable`.
- **Route helper**: optional `binaryResponse {contentType, description}` (non-JSON success bodies; emitted
  as that media type); header constant `HEADERS.invoiceSecret`.

### agent-commerce

Stage 3 step 3.1 contracts for agent commerce (additive over 0.2.1; LLDs: agentpay §3.1, webhooks §5.1, identity §6.2, payments §16.1, rails §20, sdks-and-tools §2–§3). +10 public routes, 0 new error codes, 0 new events, 1 new test-vector file.

- **Cross-chain x402 (`exact` + `near-intents`, x402 PR #3370 wire shapes)** — `src/x402/near-intents.ts`: `NearIntentsPaymentRequirements` (unquoted/quoted entry), `NearIntentsExtra` (+ NearPay `binding`, `deadline`, `originAssetId`, `slippageTolerance`, `minAmountIn`), `X402PaymentRequiredAny` (mixed `accepts`), `NearIntentsPaymentPayload` (`quote` | `deposit`), `NearIntentsVerifyRequest/Response` (`extra` = `NearIntentsQuote`), `NearIntentsSettleResponse` (+ `extra`, `replayed`), open enums `X402NearIntentsInvalidReason` / `X402NearIntentsSettleError` (PR #3370 codes verbatim), `X402NearIntentsBindingInput`, `X402OperationTokenInput` (`<kid>.<expiry>.<HMAC-SHA256 over JCS>`), helpers `quotedRequirements`, `isNearIntentsRequirements`, `parseOperationToken`. Routes (agentpay, `secret_key` / `restricted_key:agentpay.facilitate`, stage 3): `x402NearIntentsRequirements` `POST /x402/near-intents/requirements`, `x402NearIntentsVerify` `POST /x402/near-intents/verify`, `x402NearIntentsSettle` `POST /x402/near-intents/settle`. The `intents-transfer` schemas and `/x402/{requirements,verify,settle,supported}` are unchanged (own paths keep their request/response types exact).
- `AgentPayment.transfer_method` (open: `intents-transfer` | `near-intents`) and `AgentPayment.origin` (`AgentPaymentOrigin`), both optional.
- Rails: `Execution.owner` (`ExecutionOwner` open: `payments` | `agentpay`) and `Execution.x402_binding`; `CreateExecution.owner` / `x402_binding`; `listEvidence` query `owner`; `Evidence.sender` (optional, nullable). Service scope `rails.executions.write` granted to agentpay; agentpay consumes `evt.rails.execution.{settled,refunded,failed}`.
- **Events stream** — `streamEvents` `GET /v1/events/stream` (webhooks; `secret_key`, `restricted_key:events.read`, `session`): SSE frames `ready` (`EventStreamReady`), `event` (`Event`, id = `evt_…`), `reset` (`EventStreamReset`); resume with `Last-Event-ID` / `starting_after`, `types` filter, heartbeat 15 s, `retry: 3000`; API keys test mode only (`livemode_forbidden`), ≤ 5 streams per account and mode, 1 h max, slow readers closed. Constants `EVENT_STREAM_*`.
- **CLI login** (identity, device authorization in the RFC 8628 shape): `createCliLogin` `POST /v1/cli/logins` and `pollCliLogin` `POST /v1/cli/logins/poll` (anonymous; added to the anonymous allow-list), `getCliLogin` `GET /v1/cli/logins/{code}`, `approveCliLogin` (step-up) and `denyCliLogin` `POST /v1/cli/logins/{code}/{approve,deny}` (session owner/admin/developer). Objects `CliLogin`, `CliLoginPoll`, `CliLoginRequest`; approval mints a restricted **test** key with `CLI_KEY_SCOPES` (90 days).
- **`nearpay trigger`** — `payCheckoutSessionTestHelper` `POST /v1/test_helpers/checkout_sessions/{id}/pay` (payments, test mode only) → `TestHelperPayment`. `advancePaymentAttempt` also admits `restricted_key:checkout_sessions.write` and `simulateRefundDeposit` `restricted_key:refunds.write` (auth alternatives added, nothing removed).
- Test vectors `test-vectors/x402-near-intents.json`: near-intents binding, operation token (test-only key), and every header/response shape of the quote → deposit → settle flow.

### integration

- Merged billing and agent-commerce; cross-cutting checks in `test/integration-stage3.test.ts`: the
  events stream renders every billing webhook type, `CLI_KEY_SCOPES` covers every restricted-key scope on
  billing routes (`products.*`, `invoices.*`, `subscriptions.*`), the anonymous allow-list carries the
  hosted invoice routes (`GET …/public`, `POST …/public/sessions`, `GET …/public/pdf`) and the CLI login
  routes, ID prefixes name distinct objects. Route ids, method+path, error codes and webhook types stay
  unique (existing tests).

## 0.2.1 — 2026-11-08

Additive patch collecting the Stage 2 builders' change requests (step 2.2/2.3 reports and the lead's
integration notes). No route, field or enum value was removed or renamed, no request field became
required and no existing response field was tightened; every new response field is optional (or
nullable) so 0.2.0 servers stay valid. Totals: 102 public, 51 internal (+3) and 47 console routes,
58 domain event subjects (+2), 21 webhook types, 77 error codes, 38 ID prefixes; 2 new service
scopes (`sentinel.read`, `identity.operators.read`).

### Change requests

| CR                                                                                                                                                                          | From                                 | Outcome       | Contract change / reason                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kill-switch state readable by services                                                                                                                                      | payments (priority), rails, agentpay | done          | `getKillSwitch` `GET /internal/kill-switch` → `KillSwitchState` (+ optional `version` = latest event `aggregate.version`); service scope `sentinel.read` held by payments, rails, agentpay. Implementer **sentinel**; readers read it at boot (unknown = fail closed).                                                          |
| Abandon orphaned refund legs                                                                                                                                                | payments (priority)                  | done          | `abandonExecution` `POST /internal/executions/{id}/abandon` (`service:rails.executions.write`, body `{reason, note?}` → `Execution`): refund legs before any deposit become `expired_unpaid` and stay tracked 24 h (INV-3); money moved, payment executions → `409 state_conflict`. `Execution.abandoned_at`, `abandon_reason`. |
| `Execution.observed_fee`                                                                                                                                                    | payments                             | done          | `ObservedFee {amount, asset_id}` nullable, optional. Unblocks the reconciliation `fee_mismatch` check.                                                                                                                                                                                                                          |
| CR-22-AP-01 `signed_intent_mismatch` on `relaySignedIntent`                                                                                                                 | agentpay                             | done          | Added to `errors`; description states every relay refusal happens before anything is queued (confirms the pre-publish refusal classes payments relies on).                                                                                                                                                                      |
| `recovery_lock` on `createInvitation`/`updateMember`/`removeMember`/`approveSettlementDestination`                                                                          | identity                             | done          | Added to `errors`; catalogue message now names team roles too (same code, status and params).                                                                                                                                                                                                                                   |
| CR-22-RL-02 `fx_rate_unavailable` + `currency_unsupported` on `createRefundExecution`                                                                                       | rails                                | done          | Added to `errors`.                                                                                                                                                                                                                                                                                                              |
| `OpsActionEvent.id` vs `aud_` aggregate id                                                                                                                                  | compliance, sentinel, payments       | done          | Doc: object `id` is the bare uuid; envelope `aggregate.id` is `aud_<TypeID suffix>` of the same uuid.                                                                                                                                                                                                                           |
| CLI actor on `OpsActionEvent`                                                                                                                                               | sentinel                             | rejected      | Widening `actor.sub` and making `ops_role` optional is breaking for consumers (oasdiff on PR #4); CLI actions stay in each service's own log, console actions form the unified trail.                                                                                                                                           |
| `EventDataObject` += Refund, Account, PublicReview                                                                                                                          | node                                 | done          | Type-level union (not emitted).                                                                                                                                                                                                                                                                                                 |
| `SettlementDestination.disabled_reason` += `expired`                                                                                                                        | identity                             | done          | Open enum value (pending destinations expire after 7 days).                                                                                                                                                                                                                                                                     |
| compliance consumes `evt.identity.account.updated`                                                                                                                          | compliance                           | done          | Consumer added (display-name refresh).                                                                                                                                                                                                                                                                                          |
| Payer fee breakdown                                                                                                                                                         | checkout                             | done          | `DepositInstructions.fee_amount` (origin asset, display only, not attested); from rails `ExecutionDeposit.fee_amount_in`.                                                                                                                                                                                                       |
| `PayerAttempt.amount_received`                                                                                                                                              | checkout                             | done          | From rails `Execution.deposited_amount`.                                                                                                                                                                                                                                                                                        |
| Pricing-asset display on public link/session                                                                                                                                | checkout                             | done          | `pricing_asset {asset_id, symbol, decimals}` (`PricingAssetDisplay`) on `PublicCheckoutSession` and `PublicPaymentLink`.                                                                                                                                                                                                        |
| `Attestation.asset.token`                                                                                                                                                   | checkout                             | done          | `TokenContract` inside the signed `asset`, from sentinel's own registry read.                                                                                                                                                                                                                                                   |
| Payer wallet / amount sent on payment detail                                                                                                                                | dashboard, payments                  | done (partly) | `PaymentAttemptSummary.refund_to` and `origin_amount`. A separate `payer_address` is **rejected**: NearPay does not know the sending wallet of a route deposit (1Click reports no sender); `refund_to` is the payer's own address as given at checkout.                                                                         |
| `Customer.total_paid` + `last_payment_at`                                                                                                                                   | dashboard                            | done          | Per pricing currency/asset (`{currency, asset_id, amount, count}`), succeeded intents, refunds not subtracted.                                                                                                                                                                                                                  |
| `PaymentLink.name`                                                                                                                                                          | dashboard                            | done          | On the object, create and update (internal; never shown to payers).                                                                                                                                                                                                                                                             |
| Branding `theme` + `corner_radius`                                                                                                                                          | dashboard                            | done          | `AccountSettings.branding.theme` (`auto                                                                                                                                                                                                                                                                                         | light | dark`, open) and `corner_radius`(0–24 px); settable via`updateAccount`. Hosted checkout has no read path for branding yet (open question, not requested). |
| `SettlementDestination.created_by`                                                                                                                                          | dashboard, notify                    | done          | On the public object, so `InternalSettlementDestination` and its events inherit it.                                                                                                                                                                                                                                             |
| `Account.website`                                                                                                                                                           | dashboard                            | done          | On `Account` (and `OpsMerchant`), settable via `updateAccount`.                                                                                                                                                                                                                                                                 |
| Member security summary                                                                                                                                                     | dashboard                            | done          | `Member.security {passkeys, recovered_at}`.                                                                                                                                                                                                                                                                                     |
| Console decimals                                                                                                                                                            | console                              | done          | `decimals` on `Execution.origin`/`settlement` and `ReconciliationTotals` (instead of a `listOpsAssets` route).                                                                                                                                                                                                                  |
| `account_display_name` on ComplianceCase/ReconciliationRun/OpsAuditFinding                                                                                                  | console                              | done          | Optional nullable; sentinel now consumes `evt.identity.account.created`/`.updated` to fill it.                                                                                                                                                                                                                                  |
| `listOpsCases` `subject` filter                                                                                                                                             | console                              | done          | Exact `subject.id`.                                                                                                                                                                                                                                                                                                             |
| Console list counts                                                                                                                                                         | console                              | rejected      | No defined shape; `has_more` ("N+") covers v1 badges.                                                                                                                                                                                                                                                                           |
| `evt.identity.user.recovered`                                                                                                                                               | identity → notify                    | done          | `UserRecoveredEvent {user_id, account_ids, recovered_at, lock_until}`, platform event, aggregate `user`, consumer notify (`security.recovery`).                                                                                                                                                                                 |
| `getNotificationRecipients` `query.user`                                                                                                                                    | notify                               | done          | Only that user, if a member in any role (`kind` not applied then).                                                                                                                                                                                                                                                              |
| `evt.webhooks.endpoint.secret_rotated`                                                                                                                                      | webhooks → notify                    | done          | `EndpointSecretRotatedEvent {endpoint_id, account_id, url, previous_secret_expires_at, actor_user_id}`; never the secret.                                                                                                                                                                                                       |
| CR-22-RL-01 `createScreening` `fresh`                                                                                                                                       | rails                                | done          | Optional boolean (bypass the screening cache).                                                                                                                                                                                                                                                                                  |
| `assignOpsCase` active-operator check                                                                                                                                       | compliance                           | done          | `getInternalOpsOperator` `GET /internal/ops_operators/{id}` (identity, `service:identity.operators.read` held by compliance).                                                                                                                                                                                                   |
| CR-22-AP-02 `AgentPayment.refund` (+ execution) and refund-kind docs                                                                                                        | agentpay                             | done (partly) | `refund` nullable optional; `payer`/`pay_to` documented for `refund`. `execution` **rejected**: `ex_` ids are internal (rails), never on public objects.                                                                                                                                                                        |
| `RefundTransfer` salt/nonce (drop NEAR RPC from payments)                                                                                                                   | payments                             | done          | `RefundTransfer.nonce` (salt ‖ 28 random bytes, issued by rails).                                                                                                                                                                                                                                                               |
| `x402Verify`/`x402Settle` `idempotent: true`                                                                                                                                | node                                 | rejected      | `idempotent` means the route honours `Idempotency-Key`; agentpay LLD §5 makes settle idempotent on the payload hash (already in the summary) and verify is a pure check — the key is not honoured.                                                                                                                              |
| `OneClickToken.price` nullable                                                                                                                                              | sentinel                             | rejected      | Loosens an existing response field (flagged breaking by the compat gate); sentinel parses only the fields it needs. Revisit in a minor.                                                                                                                                                                                         |
| `webauthn_failed` 401 vs catalogue 400                                                                                                                                      | identity                             | rejected      | A status change is breaking; identity answers the catalogue's `400`.                                                                                                                                                                                                                                                            |
| `listOpsMerchants` email in the query string                                                                                                                                | identity                             | rejected      | Logging concern, not a contract one: strip query strings from `/ops/*` access logs (deploy/kit).                                                                                                                                                                                                                                |
| `approvals_required` fixed at creation (audit item)                                                                                                                         | identity                             | n/a           | Resolved in identity LLD 1.8 (rule re-derived at every step with a 30-day high-water mark); no contract change.                                                                                                                                                                                                                 |
| CR-22-RL-03 binding field on `ExecutionRefund`                                                                                                                              | rails                                | n/a           | Noted only by rails (`transfer.memo` suffices).                                                                                                                                                                                                                                                                                 |
| Deploy, testbed, kit and UI items (env vars, routers, CSP, ops tokens with `ops_role`, AppShell/layout gaps, notify audiences, `/l/<plink>/complete`, approver-tenure copy) | various                              | n/a           | Not contract changes.                                                                                                                                                                                                                                                                                                           |

## 0.2.0 — 2026-11-07

Stage 2 contract freeze (step 2.1, `nearpay-brain/roadmap/development-plan.md` §4; owner decisions
2026-11-07, ADR-0020). No route, field or enum value was removed or renamed and no request field became
required. The oasdiff gate against the 0.1.5 baseline (CI run on PR #3) flagged two groups of changes;
each flagged change was reviewed and is intentional, so the baseline moves to 0.2.0 with this release:

- **New event types in event unions** (`GET /v1/events`, `GET /v1/events/{id}`,
  `POST /v1/webhook_endpoints/{id}/test`: `response-*-one-of-added`, 3 findings). New event types are
  backward-compatible by api-conventions §1 ("clients MUST tolerate unknown fields and enum values";
  new event types ship without a new version); oasdiff reports every `oneOf` addition.
- **Live-1Click shape on the internal 1Click mirror** (`openapi/internal/sandbox.yaml`: `POST /v0/quote`,
  `POST /v0/deposit/submit`, `GET /v0/status`, `GET /v0/tokens`; 103 findings). Optional `OneClick*`
  fields became nullish and the nested status `quoteResponse.correlationId` optional, because live
  1Click sends `null` and omits it (open-questions "Mainnet findings carried into Stage 2"). This is a
  consumer-side change for code that assumed non-null values; the only consumers are rails, sentinel
  and the sandbox, which drop their Stage 1 body normalisation in step 2.2. The
  `request-property-enum-value-removed` and `min/max-unset` findings are representation artefacts of
  `enum` → `anyOf[enum, null]`: no value or bound was removed. The new minor marks the
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
- **Unified console audit trail (T-12).** Subjects `evt.compliance.ops_action.recorded`,
  `evt.sentinel.ops_action.recorded`, `evt.payments.ops_action.recorded` (reconciliation) and
  `evt.rails.ops_action.recorded` (reverify) (object `OpsActionEvent`: action `id`, `actor {sub, ops_role}`,
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
  Producer: **nearpay-sentinel**; reader: **nearpay-checkout**, `@nearpay-money/agent-signer`.
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
Request IDs refer to `nearpay-brain/roadmap/open-questions.md` ("Planned `@nearpay-money/spec` 0.1.5").

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
