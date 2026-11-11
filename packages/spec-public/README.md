# @nearpay-money/spec

Public NearPay API contracts as [zod 4](https://zod.dev) schemas: REST route tables and objects, webhook events
and the `NearPay-Signature` header format, the NearPay x402 `exact` + `intents-transfer` scheme, NEAR Intents
payloads, and the error catalogue. Generated OpenAPI 3.1 (`openapi/public.yaml`), JSON Schemas (`schemas/`) and
shared test vectors (`test-vectors/`) ship with the package.

Most integrations want the server SDK [`@nearpay-money/node`](https://www.npmjs.com/package/@nearpay-money/node),
which is built on this package. Use `@nearpay-money/spec` directly to validate payloads, generate clients from the
OpenAPI document or test your own implementation against the vectors.

## Install

```sh
npm install @nearpay-money/spec zod
```

ESM only, Node.js ≥ 22.11. `zod` (^4.6.7) is a peer dependency.

## Quickstart

```ts
import { ERRORS, Event, PaymentIntent, parseSignatureHeader, SPEC_VERSION } from "@nearpay-money/spec";

// Validate an object returned by the API (tolerant of fields added in later API versions).
const intent = PaymentIntent.parse(await (await fetch(url, { headers })).json());

// Parse a webhook event envelope and its signature header.
const header = parseSignatureHeader(req.headers["nearpay-signature"]);
const event = Event.parse(JSON.parse(rawBody));

console.log(SPEC_VERSION, intent.status, event.type, header?.timestamp, Object.keys(ERRORS).length);
```

Artifacts are exported as files:

```ts
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const openapi = require.resolve("@nearpay-money/spec/openapi/public.yaml");
const vectors = require("@nearpay-money/spec/test-vectors/webhook-signatures.json");
```

## Links

- Documentation: https://docs.nearpay.money
- Website: https://nearpay.money
- Source and changelog: https://github.com/nearpay-money/nearpay-spec

The package was previously named `@nearpay/spec` on NearPay's private registry only; nothing NearPay publishes
uses the `@nearpay` npm scope, which belongs to an unrelated company.

License: Apache-2.0.
