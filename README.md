# nearpay-spec

> Single source of truth for every contract, authored as zod schemas in TypeScript and emitted as OpenAPI 3.1 / AsyncAPI / JSON Schema: public REST, internal service APIs, domain events, webhook payloads, error catalogue, NearPay x402 scheme, shared test vectors.

| | |
|---|---|
| Group | Contracts & shared |
| Kind | spec |
| Ships as | npm: @nearpay/spec (public), @nearpay-internal/spec (private) |
| Owns | API/event/webhook/error contracts |
| Depends on (published artifacts only) | — |
| First built in | Stage 1 (step 1.1) |

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
├── asyncapi/
├── codegen/
├── openapi/
│   ├── internal/
│   └── public/
├── packages/
│   ├── spec-internal/
│   └── spec-public/
├── schemas/
├── src/
│   ├── common/
│   ├── errors/
│   ├── events/
│   ├── internal/
│   ├── public/
│   ├── webhooks/
│   └── x402/
├── test/
│   └── compat/
├── test-vectors/
└── .github/
    └── workflows/
```

## Status

Scaffold only. Implementation starts in **Stage 1 (step 1.1)** (`nearpay-brain/roadmap/development-plan.md`).

## Built with

Libraries are listed here as they are added (hackathon rule Q-005). Code and documentation are written with AI assistance (Claude) under human direction and review.
