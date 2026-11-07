/** Internal route table (`/internal/*` and the sandbox mirror). */
import type { AnyRoute } from "@nearpay/spec";
import * as identity from "./identity.js";
// stage 2 — identity-console
import * as ops from "./ops.js";
import * as rails from "./rails.js";
import * as sandbox from "./sandbox.js";
import * as services from "./services.js";

export * from "./identity.js";
export * from "./oneclick.js";
// stage 2 — identity-console
export * from "./ops.js";
export * from "./ops-approval.js";
export * from "./rails.js";
export * from "./sandbox.js";
export * from "./services.js";

function routesOf(mod: Record<string, unknown>): AnyRoute[] {
  return Object.values(mod).filter(
    (v): v is AnyRoute => typeof v === "object" && v !== null && "method" in v && "path" in v && "auth" in v,
  );
}

// stage 2 — identity-console
/**
 * Console routes (`/ops/*`, visibility `ops`): served by the owning service, routed by the gateway
 * only on the console host. Also part of `INTERNAL_ROUTES` (services mount them from there).
 */
export const OPS_ROUTES: readonly AnyRoute[] = Object.freeze(routesOf(ops));

/** Console routes the gateway lets through without an ops session (sign-in and enrolment). */
export const OPS_ANONYMOUS_ROUTES: readonly { method: string; path: string }[] = Object.freeze(
  OPS_ROUTES.filter((r) => r.auth.includes("anonymous")).map((r) => ({ method: r.method, path: r.path })),
);

/** Every route a service serves besides the public API (`/internal/*`, sandbox mirror, `/ops/*`), in a stable order. */
export const INTERNAL_ROUTES: readonly AnyRoute[] = Object.freeze([
  ...routesOf(identity),
  ...routesOf(services),
  ...routesOf(rails),
  ...routesOf(sandbox),
  ...OPS_ROUTES,
]);
