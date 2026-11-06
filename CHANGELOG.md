# Changelog

`@nearpay/spec` and `@nearpay-internal/spec` share one version. Within a version line changes are
additive only (`pnpm compat` gates every release against `test/compat/baseline/`, the last release).

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
