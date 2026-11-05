/** Internal route table (`/internal/*` and the sandbox mirror). */
import type { AnyRoute } from "@nearpay/spec";
import * as identity from "./identity.js";
import * as rails from "./rails.js";
import * as sandbox from "./sandbox.js";
import * as services from "./services.js";

export * from "./identity.js";
export * from "./oneclick.js";
export * from "./rails.js";
export * from "./sandbox.js";
export * from "./services.js";

function routesOf(mod: Record<string, unknown>): AnyRoute[] {
  return Object.values(mod).filter(
    (v): v is AnyRoute => typeof v === "object" && v !== null && "method" in v && "path" in v && "auth" in v,
  );
}

/** Every internal route, in a stable order. */
export const INTERNAL_ROUTES: readonly AnyRoute[] = Object.freeze([
  ...routesOf(identity),
  ...routesOf(services),
  ...routesOf(rails),
  ...routesOf(sandbox),
]);
