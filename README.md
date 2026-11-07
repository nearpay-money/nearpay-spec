# nearpay-spec

> Single source of truth for every contract, authored as zod schemas in TypeScript and emitted as OpenAPI 3.1 / AsyncAPI / JSON Schema: public REST, internal service APIs, domain events, webhook payloads, error catalogue, NearPay x402 scheme, shared test vectors.

|                                       |                                                               |
| ------------------------------------- | ------------------------------------------------------------- |
| Group                                 | Contracts & shared                                            |
| Kind                                  | spec                                                          |
| Ships as                              | npm: @nearpay/spec (public), @nearpay-internal/spec (private) |
| Owns                                  | API/event/webhook/error contracts                             |
| Depends on (published artifacts only) | —                                                             |
| First built in                        | Stage 1 (step 1.1)                                            |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/lld/00-foundations.md` — **low-level design (dev-ready; implement from this)**
- `nearpay-brain/lld/audits/00-foundations.md` — audit findings already folded into the LLD
- `nearpay-brain/roadmap/development-plan.md` — stage and step this repo is built in
- `nearpay-brain/architecture/hld.md` — system design
- `nearpay-brain/architecture/repositories.md` — repo topology and dependency rules
- `nearpay-brain/architecture/api-conventions.md`
- `nearpay-brain/decisions/ADR-0001-polyrepo-contract-first.md`

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
│   ├── spec-public/     @nearpay/spec
│   └── spec-internal/   @nearpay-internal/spec (depends on @nearpay/spec)
└── test/                rule tests (descriptions, routes, errors, events, vectors, artifacts) · compat/ (oasdiff gate + release baseline)
```

## Commands

| Command                      | What it does                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pnpm install`               | Install (Node 22, pnpm 9)                                                                                        |
| `pnpm emit` / `pnpm vectors` | Regenerate artifacts / test vectors after changing `src/`                                                        |
| `pnpm test`                  | Rule tests, artifact validation (official OpenAPI 3.1 + AsyncAPI 3.0 schemas), vector checks                     |
| `pnpm compat`                | oasdiff gate against `test/compat/baseline/` (last release); self-tests first. Needs `oasdiff` or Docker         |
| `pnpm verify`                | typecheck + lint + test + emit/vectors up to date + compat + build                                               |
| `pnpm release:local`         | Verify, then publish both packages to the local registry (`NP_REGISTRY_URL`, `NP_REGISTRY_PASSWORD`); idempotent |

`nearpay-deploy/scripts/up.sh` publishes these packages automatically when the pinned version is missing from the local registry.

## Status

`0.2.0` — Stage 2 contracts (step 2.1, contract freeze; additive over 0.1.5, see `CHANGELOG.md`): 102 public, 48 internal and 47 console (`/ops/…`, visibility `ops`) routes, 54 domain event subjects, 21 webhook types, 77 error codes. Adds team/invitations, restricted keys, two-approver destinations, self-declared KYB, the operations console (hardware-passkey sign-in, KYB queue, cases, blocklist, two-person suspension and kill-switch release, executions explorer, reconciliation), refunds, payment links, customers, headless payment intents, review webhooks, rails pricing/FX (ECB + public price feed), Explorer feed, observation archive and reconciliation evidence.

`0.1.5` — step 1.2/1.3 change requests (additive; see `CHANGELOG.md`): new dashboard, delivery-log and attestation-challenge routes, x402 `replayed`/`deadline`, `sequence` on checkout sessions and agent payments, tolerant open-enum parsing for SDKs.

`0.1.0` — Stage 1 contracts (step 1.1): 60 public and 36 internal routes, 39 domain event subjects, 12 webhook types, 60 error codes, the x402 `intents-transfer` scheme, and shared test vectors. NEAR Intents signing formats (NEP-413, ERC-191, raw ed25519) were checked against the live `intents.near` Verifier with read-only `simulate_intents` calls.

## Built with

zod 4, zod-openapi, TypeScript 5, Vitest, Biome, yaml, canonicalize (RFC 8785), @noble/curves and @noble/hashes (test vectors), bs58, oasdiff (compat gate), @seriousme/openapi-schema-validator and @asyncapi/parser (artifact validation). Code and documentation are written with AI assistance (Claude) under human direction and review.
