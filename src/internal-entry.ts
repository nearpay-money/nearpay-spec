/**
 * @nearpay-internal/spec — internal contracts: service-to-service routes, domain events and
 * streams, 1Click wire schemas (sandbox parity). Depends on @nearpay/spec.
 */
export * from "./events/catalogue.js";
export * from "./internal/index.js";

/** Version of this contract package (kept equal to package.json by `test/package.test.ts`). */
export const SPEC_INTERNAL_VERSION = "0.1.5";
