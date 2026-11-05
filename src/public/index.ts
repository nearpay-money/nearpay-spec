/** Public route table (`/v1/*`, `/x402/*`). */
import type { AnyRoute } from "../common/route.js";
import * as agentpay from "./agentpay.js";
import * as compliance from "./compliance.js";
import * as identity from "./identity.js";
import * as payer from "./payer.js";
import * as payments from "./payments.js";
import * as rails from "./rails.js";
import * as sentinel from "./sentinel.js";
import * as webhooks from "./webhooks.js";

export * from "./agentpay.js";
export * from "./compliance.js";
export * from "./identity.js";
export * from "./payer.js";
export * from "./payments.js";
export * from "./rails.js";
export * from "./sentinel.js";
export * from "./webhooks.js";

function routesOf(mod: Record<string, unknown>): AnyRoute[] {
  return Object.values(mod).filter(
    (v): v is AnyRoute => typeof v === "object" && v !== null && "method" in v && "path" in v && "auth" in v,
  );
}

/** Every public route, in a stable order (module, then declaration). */
export const PUBLIC_ROUTES: readonly AnyRoute[] = Object.freeze([
  ...routesOf(identity),
  ...routesOf(compliance),
  ...routesOf(payments),
  ...routesOf(payer),
  ...routesOf(agentpay),
  ...routesOf(sentinel),
  ...routesOf(rails),
  ...routesOf(webhooks),
]);

/**
 * Routes the gateway lets through without a credential (identity's anonymous allow-list,
 * lld/identity.md §11 `NP_PUBLIC_ANON_ROUTES`). Client-secret routes are anonymous at the
 * gateway; the owning service checks the secret.
 */
export const PUBLIC_ANONYMOUS_ROUTES: readonly { method: string; path: string }[] = Object.freeze(
  PUBLIC_ROUTES.filter((r) => r.auth.includes("anonymous") || r.auth.includes("client_secret")).map((r) => ({
    method: r.method,
    path: r.path,
  })),
);
