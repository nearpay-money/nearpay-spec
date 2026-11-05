# AGENTS.md — nearpay-spec

You are working in **nearpay-spec**, one of 27 NearPay repositories (`nearpay-brain/architecture/repositories.md`).
Scope: Single source of truth for every contract, authored as zod schemas in TypeScript and emitted as OpenAPI 3.1 / AsyncAPI / JSON Schema: public REST, internal service APIs, domain events, webhook payloads, error catalogue, NearPay x402 scheme, shared test vectors.

## Before changing anything

1. Read `../nearpay-brain/AGENTS.md`, then this repo's LLD (`../nearpay-brain/lld/00-foundations.md`) — it is the implementation spec; do not make design decisions it already makes.
2. Contracts (requests, responses, events, errors) come from `@nearpay/spec`. If one must change, open a PR in `nearpay-spec` first; never hand-write contract types here.
3. Check your change against invariants INV-1…INV-9 in `nearpay-brain/product/requirements.md`.

## Rules for this repo

- Additive-only changes within a version; `test/compat` must pass (no breaking diffs) unless the PR is a new dated version.
- Every error code has a docs page and an example.

## Never

- Import source code from another NearPay repo (depend on published packages/images only).
- Read or write another service's database.
- Add design documents here — update `nearpay-brain` and link to it.
- Commit secrets, private keys or real customer data.
- Merge changes to paths listed in `.github/CODEOWNERS` without the required human review.
