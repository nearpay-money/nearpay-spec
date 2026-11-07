/**
 * @nearpay/spec — public contracts: public REST routes and objects, webhook events and
 * signatures, the NearPay x402 scheme, NEAR Intents payloads, the error catalogue and helpers.
 */
export * from "./common/auth.js";
export * from "./common/errors.js";
export * from "./common/evidence.js";
export * from "./common/ids.js";
export * from "./common/pagination.js";
export * from "./common/primitives.js";
export * from "./common/route.js";
export * from "./common/schema.js";
export * from "./common/tolerant.js";
export * from "./common/webauthn.js";
export * from "./errors/catalogue.js";
export * from "./intents/payloads.js";
export * from "./public/index.js";
export * from "./webhooks/events.js";
export * from "./webhooks/signature.js";
export * from "./x402/scheme.js";

/** Version of this contract package (kept equal to package.json by `test/package.test.ts`). */
export const SPEC_VERSION = "0.2.1";
