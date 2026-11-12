# nearpay-spec

The single source of truth for every NearPay contract, written as zod schemas in TypeScript and emitted as OpenAPI 3.1, AsyncAPI and JSON Schema: the public REST API, internal service APIs, domain events, webhook payloads, the error catalogue, the NearPay x402 scheme and shared test vectors.

Part of [NearPay](https://github.com/nearpay-money/nearpay) — start there for the live demo, the architecture diagram and the full "do X, see Y" walkthrough.

- **Where it sits:** at the bottom of the dependency graph. Every service, frontend, SDK and tool imports its request, response, event and error shapes from the two packages built here (`@nearpay-money/spec`, public; `@nearpay-internal/spec`, internal). It depends on no other NearPay repo.
- **Status:** [`@nearpay-money/spec`](https://www.npmjs.com/package/@nearpay-money/spec) 0.5.0 is on npm. This repo is at 0.5.2; 0.5.1 and 0.5.2 are additive and so far published only to NearPay's local package registry, where the services pin them. NearPay runs on NEAR mainnet as a closed beta (https://nearpay.money); the rendered API reference is at https://docs.nearpay.money.

|                                       |                                                                     |
| ------------------------------------- | ------------------------------------------------------------------- |
| Group                                 | Contracts & shared                                                  |
| Kind                                  | spec                                                                |
| Ships as                              | npm: @nearpay-money/spec (public), @nearpay-internal/spec (private) |
| Owns                                  | API/event/webhook/error contracts                                   |
| Depends on (published artifacts only) | —                                                                   |
| First built in                        | Stage 1 (step 1.1)                                                  |

## Documentation

Design docs live in [`nearpay-brain`](https://github.com/nearpay-money/nearpay-brain), not here.

- [`lld/00-foundations.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/lld/00-foundations.md) — low-level design this repo is implemented from
- [`lld/audits/00-foundations.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/lld/audits/00-foundations.md) — audit findings already folded into the LLD
- [`roadmap/development-plan.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/roadmap/development-plan.md) — stage and step this repo is built in
- [`architecture/hld.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/architecture/hld.md) — system design
- [`architecture/repositories.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/architecture/repositories.md) — repo topology and dependency rules
- [`architecture/api-conventions.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/architecture/api-conventions.md)
- [`decisions/ADR-0001-polyrepo-contract-first.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/decisions/ADR-0001-polyrepo-contract-first.md)

## Layout

```
nearpay-spec/
├── src/                 zod sources (the only hand-written contracts)
│   ├── common/          ids, money and chain primitives, auth/scopes/headers, route-table format, errors envelope
│   ├── errors/          catalogue.ts — every error code, status, type, message template, example
│   ├── public/          public /v1 and /x402 routes and objects (identity, payments, payer, agentpay, sentinel, rails, webhooks, compliance)
│   ├── intents/         NEAR Intents Verifier payloads (MultiPayload, transfer intent, requirement)
│   ├── webhooks/        public event types, payloads, version rendering, NearPay-Signature format
│   ├── x402/            NearPay x402 v2 profile (exact + intents-transfer)
│   ├── internal/        service-to-service routes, 1Click wire schemas (sandbox parity)
│   └── events/          domain subjects, envelope, streams, consumers
├── codegen/             emit.ts (OpenAPI, AsyncAPI, JSON Schema, errors) · vectors.ts (test vectors)
├── openapi/             GENERATED public.yaml, internal/<service>.yaml
├── asyncapi/            GENERATED events.yaml
├── schemas/             GENERATED JSON Schemas: events, webhooks, x402, intents
├── errors/              GENERATED catalogue.yaml
├── test-vectors/        GENERATED shared fixtures (attestations, tickets, webhook signatures, Intents payloads, ids)
├── packages/
│   ├── spec-public/     @nearpay-money/spec
│   └── spec-internal/   @nearpay-internal/spec (depends on @nearpay-money/spec)
└── test/                rule tests (descriptions, routes, errors, events, vectors, artifacts) · compat/ (oasdiff gate + release baseline)
```

## Verify this repo

Needs Node 22 (`.nvmrc`) and pnpm 9. This repo has no NearPay dependencies, so it installs straight from npmjs.com: no local registry.

1. `pnpm install --frozen-lockfile` → ends with `Done in …`.
2. `pnpm test` (rule tests over every route, event and error; validation of the generated documents against the official OpenAPI 3.1 and AsyncAPI 3.0 schemas; test-vector checks) → `Test Files  24 passed (24)`, `Tests  680 passed (680)`.
3. `pnpm emit:check && pnpm vectors:check` → `generated files are up to date` and `test vectors are up to date`: the committed `openapi/`, `asyncapi/`, `schemas/`, `errors/` and `test-vectors/` are exactly what `src/` generates.
4. `pnpm verify` (the full gate: typecheck, lint, steps 2–3, the compatibility gate against the last release, build of both packages) → exits 0. The compatibility step (`pnpm compat`) needs `oasdiff` on the `PATH`, or Docker to run the `tufin/oasdiff:v1.34.1` image; everything else needs neither.

By reading: `openapi/public.yaml` is the public API as generated; `test-vectors/` holds the fixtures that the services, SDKs and frontends test against (sentinel attestations, webhook signatures, NEAR Intents payloads, asset ids, chain evidence).

## Commands

| Command                      | What it does                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | Install (Node 22, pnpm 9)                                                                                    |
| `pnpm emit` / `pnpm vectors` | Regenerate artifacts / test vectors after changing `src/`                                                        |
| `pnpm test`                  | Rule tests, artifact validation (official OpenAPI 3.1 + AsyncAPI 3.0 schemas), vector checks                     |
| `pnpm compat`                | oasdiff gate against `test/compat/baseline/` (last release); self-tests first. Needs `oasdiff` or Docker         |
| `pnpm verify`                | typecheck + lint + test + emit/vectors up to date + compat + build                                               |
| `pnpm release:local`         | Verify, then publish both packages to the local registry (`NP_REGISTRY_URL`, `NP_REGISTRY_PASSWORD`); idempotent |

`nearpay-deploy/scripts/up.sh` publishes these packages automatically when the pinned version is missing from the local registry.

## Status

`0.5.2` — asset id shapes (additive; see `CHANGELOG.md`): `parseAssetId` and `assetIdBlockchain` read the 1Click `.omft.near` and `.omdep.near` bridge ids and `1cs_v1:` ids, and never treat a bridged id as a NEAR token; new `test-vectors/asset-ids.json`. No route, object, event or error change.

`0.5.1` — Continue with Google for the merchant dashboard (ADR-0026; additive, see `CHANGELOG.md`): the Google sign-in and link routes, `AuthMethods`, `LinkedIdentity`, four error codes, two identity events.

`0.5.0` — package rename (ADR-0025): the public package is now `@nearpay-money/spec` (the `@nearpay` npm scope belongs to an unrelated company), published to the public npm registry by `.github/workflows/release.yml`; `@nearpay-internal/spec` depends on it. Contracts are identical to 0.4.2.

`0.4.2` — confirmation samples per ADR-0022 as amended (one block of each chain's own consensus; see `CHANGELOG.md`): Solana `confirmed` commitment and Bitcoin 1 confirmation for every amount in the chain vectors and descriptions, new `BITCOIN_DEFAULT_CONFIRMATION_TIERS` (`BITCOIN_CONFIRMATION_TIERS` unchanged, opt-in). No schema change; counts unchanged from 0.4.0.

`0.4.1` — Stage 4 change requests (additive; see `CHANGELOG.md`): optional `token_asset` display data on mandate funding instructions and the hosted-page mandate, corrected payer notice (cancel only from the paying account). Route, event, webhook and error counts unchanged from 0.4.0.

`0.4.0` — Stage 4 contracts (step 4.1, contract freeze; additive over 0.3.1, see `CHANGELOG.md`): auto-debit (subscription-vault mirror and shared vault test vectors, billing mandates, hosted mandate funding, mandate events, webhooks and emails, the sandbox vault stand-in) and Solana + Bitcoin as Tier A chains (chain helpers, chain evidence, Solana and BIP-322 destination attestation, chain test vectors). 151 public, 62 internal and 47 console routes, 80 domain event subjects, 41 webhook types, 89 error codes.

`0.3.1` — Stage 3.2 change requests (additive; see `CHANGELOG.md`): owner filter on rails evidence summaries, sandbox transfer senders, missing route error codes (invoice sessions, subscriptions, FX/pricing), invoice-mail totals and destination fingerprint, and a test-mode billing clock helper (`POST /v1/test_helpers/subscriptions/{id}/advance_clock`). 143 public, 57 internal and 47 console routes, 71 domain event subjects, 33 webhook types, 87 error codes.

`0.3.0` — Stage 3 contracts (step 3.1, contract freeze; additive over 0.2.1, see `CHANGELOG.md`): billing (products, prices, tax rates with normative tax arithmetic, invoices and hosted invoices, subscriptions, billing emails) and agent commerce (cross-chain x402 `near-intents`, events SSE stream, CLI device login, `nearpay trigger` test helper). 142 public, 57 internal and 47 console routes, 71 domain event subjects, 33 webhook types, 87 error codes.

`0.2.1` — Stage 2 change requests (additive; see `CHANGELOG.md`): service-readable kill-switch state, abandoning orphaned refund legs, observed fees and deposited amounts on executions, missing route error codes, CLI actors on operator actions, recovery and secret-rotation events, and display data for checkout, dashboard and console. 102 public, 51 internal and 47 console routes, 58 domain event subjects, 21 webhook types, 77 error codes.

`0.2.0` — Stage 2 contracts (step 2.1, contract freeze; additive over 0.1.5, see `CHANGELOG.md`): 102 public, 48 internal and 47 console (`/ops/…`, visibility `ops`) routes, 54 domain event subjects, 21 webhook types, 77 error codes. Adds team/invitations, restricted keys, two-approver destinations, self-declared KYB, the operations console (hardware-passkey sign-in, KYB queue, cases, blocklist, two-person suspension and kill-switch release, executions explorer, reconciliation), refunds, payment links, customers, headless payment intents, review webhooks, rails pricing/FX (ECB + public price feed), Explorer feed, observation archive and reconciliation evidence.

`0.1.5` — step 1.2/1.3 change requests (additive; see `CHANGELOG.md`): new dashboard, delivery-log and attestation-challenge routes, x402 `replayed`/`deadline`, `sequence` on checkout sessions and agent payments, tolerant open-enum parsing for SDKs.

`0.1.0` — Stage 1 contracts (step 1.1): 60 public and 36 internal routes, 39 domain event subjects, 12 webhook types, 60 error codes, the x402 `intents-transfer` scheme, and shared test vectors. NEAR Intents signing formats (NEP-413, ERC-191, raw ed25519) were checked against the live `intents.near` Verifier with read-only `simulate_intents` calls.

## Built with

- Runtime (peer dependency of both packages): zod 4.
- Development: zod-openapi, TypeScript 5, tsx, Vitest, Biome, yaml, canonicalize (RFC 8785), `@noble/curves`, `@noble/hashes`, `@scure/base` and `@scure/btc-signer` (test vectors), bs58, oasdiff (compatibility gate), `@seriousme/openapi-schema-validator` and `@asyncapi/parser` (artifact validation).
- Licence: Apache-2.0 (`LICENSE`).

Code and documentation are written with AI assistance (Claude) under human direction and review. Built for the NEAR Hackathon (Nov 2026).
