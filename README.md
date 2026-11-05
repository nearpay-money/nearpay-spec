# nearpay-spec

> Single source of truth for every contract: public REST (OpenAPI 3.1), internal service APIs, domain events (AsyncAPI), webhook payloads, error catalogue, NearPay x402 scheme.

| | |
|---|---|
| Group | Contracts & shared |
| Kind | spec |
| Ships as | npm: @nearpay/spec (public), @nearpay-internal/spec (private) |
| Owns | API/event/webhook/error contracts |
| Depends on (published artifacts only) | — |
| Roadmap phase | P0 Foundations |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/architecture/hld.md` — system design
- `nearpay-brain/architecture/repositories.md` — repo topology and dependency rules
- `nearpay-brain/architecture/api-conventions.md`
- `nearpay-brain/decisions/ADR-0001-polyrepo-contract-first.md`

## Layout

```
nearpay-spec/
├── asyncapi/
│   └── events/
├── codegen/
├── errors/
├── openapi/
│   ├── internal/
│   └── public/
├── packages/
│   ├── spec-internal/
│   └── spec-public/
├── schemas/
│   ├── webhooks/
│   └── x402/
├── test/
│   └── compat/
└── .github/
    └── workflows/
```

## Status

Scaffold only. Implementation starts in phase **P0 Foundations** (`nearpay-brain/roadmap/roadmap.md`).
