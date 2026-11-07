/**
 * Route tables: every endpoint is data (lld/00-foundations.md §3), so servers, clients, docs,
 * gateway allow-lists and tests are generated from one definition.
 */
import type { ErrorCode } from "../errors/catalogue.js";
import type { OpsRole, Role, RouteAuth, ServiceName } from "./auth.js";
import { z } from "./schema.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
export type SuccessStatus = 200 | 201 | 202 | 204;
/**
 * `ops` (stage 2 — identity-console): console routes under `/ops/…`, served by the owning service
 * and routed by the gateway only on the console host (`ops.<domain>/api/ops/*`, ForwardAuth with
 * the `__Host-np_ops` cookie); `/internal/*` stays unrouted.
 */
export type RouteVisibility = "public" | "internal" | "ops";
/** Who serves the route: a NearPay service, or the gateway itself. */
export type RouteOwner = ServiceName | "gateway";

/** A server-sent-events stream description. */
export interface SseStream {
  /** Event name → payload schema (`event: <name>` / `data: <json>`). */
  readonly events: Readonly<Record<string, z.ZodType>>;
  readonly heartbeatSeconds: number;
  readonly retryMs: number;
}

export interface RouteDefinition<
  P extends z.ZodType | undefined = z.ZodType | undefined,
  Q extends z.ZodType | undefined = z.ZodType | undefined,
  B extends z.ZodType | undefined = z.ZodType | undefined,
  R extends z.ZodType | null = z.ZodType | null,
> {
  /** Stable operation id (OpenAPI `operationId`, SDK method name). */
  readonly id: string;
  readonly method: HttpMethod;
  /** Path with `{param}` placeholders. */
  readonly path: string;
  readonly service: RouteOwner;
  readonly visibility: RouteVisibility;
  readonly summary: string;
  readonly description?: string;
  /** Allowed principals; any one suffices. */
  readonly auth: readonly RouteAuth[];
  /** Session principals must hold one of these roles. Omitted = any role. */
  readonly roles?: readonly Role[];
  /** Session (or ops) principals need a fresh step-up assertion (≤ 10 min). */
  readonly stepUp?: boolean;
  /**
   * Ops principals must hold one of these console roles (`ops_role` claim). Required on every
   * `ops` route that is not anonymous (stage 2 — identity-console).
   */
  readonly opsRoles?: readonly OpsRole[];
  /** Honours `Idempotency-Key` (foundations §7). */
  readonly idempotent: boolean;
  readonly params?: P;
  readonly query?: Q;
  readonly body?: B;
  /** Extra request headers the route requires (besides auth headers). */
  readonly headers?: z.ZodType;
  /** Success response body; `null` = no body. */
  readonly response: R;
  readonly status: SuccessStatus;
  /** Response headers set on success. */
  readonly responseHeaders?: z.ZodType;
  /** Server-sent events instead of a JSON body. */
  readonly stream?: SseStream;
  /** Route-specific error codes (generic codes apply to every route). */
  readonly errors: readonly ErrorCode[];
  /** Test-mode only (rejects live mode with `livemode_forbidden`). */
  readonly testModeOnly?: boolean;
  /** Development stage that ships the route. */
  readonly stage: 1 | 2 | 3 | 4 | 5;
}

const PARAM_RE = /\{([a-z_]+)\}/g;

/** Defines a route and checks its internal consistency at module load. */
export function route<
  P extends z.ZodType | undefined = undefined,
  Q extends z.ZodType | undefined = undefined,
  B extends z.ZodType | undefined = undefined,
  R extends z.ZodType | null = null,
>(def: RouteDefinition<P, Q, B, R>): RouteDefinition<P, Q, B, R> {
  const placeholders = [...def.path.matchAll(PARAM_RE)].map((m) => m[1]);
  const paramKeys = def.params instanceof z.ZodObject ? Object.keys(def.params.shape) : [];
  const missing = placeholders.filter((p) => !paramKeys.includes(p as string));
  const extra = paramKeys.filter((k) => !placeholders.includes(k));
  if (missing.length || extra.length) {
    throw new Error(
      `route ${def.id}: path params ${JSON.stringify(placeholders)} ≠ params schema ${JSON.stringify(paramKeys)}`,
    );
  }
  if (def.auth.length === 0) throw new Error(`route ${def.id}: auth must not be empty`);
  if (def.status === 204 && def.response !== null) throw new Error(`route ${def.id}: 204 must not have a body`);
  if (def.body && def.method === "GET") throw new Error(`route ${def.id}: GET must not have a body`);
  if (def.visibility === "public" && !def.path.startsWith("/v1/") && !def.path.startsWith("/x402/")) {
    throw new Error(`route ${def.id}: public paths start with /v1/ or /x402/`);
  }
  if (def.visibility === "internal" && !def.path.startsWith("/internal/") && def.service !== "sandbox") {
    throw new Error(`route ${def.id}: internal paths start with /internal/`);
  }
  // stage 2 — identity-console: console (ops) routes
  if (def.visibility === "ops") {
    if (!def.path.startsWith("/ops/")) throw new Error(`route ${def.id}: ops paths start with /ops/`);
    if (!def.auth.every((a) => a === "anonymous" || a.startsWith("ops:"))) {
      throw new Error(`route ${def.id}: ops routes admit only ops principals (or anonymous sign-in)`);
    }
    if (def.auth.includes("anonymous") && !def.path.startsWith("/ops/auth/")) {
      throw new Error(`route ${def.id}: anonymous ops routes live under /ops/auth/`);
    }
    if (def.roles) throw new Error(`route ${def.id}: ops routes declare opsRoles, not merchant roles`);
  }
  if (def.auth.some((a) => a.startsWith("ops:")) && def.visibility === "ops" && !def.opsRoles?.length) {
    throw new Error(`route ${def.id}: ops routes must declare opsRoles`);
  }
  if (def.opsRoles && !def.auth.some((a) => a.startsWith("ops:"))) {
    throw new Error(`route ${def.id}: opsRoles need an ops auth entry`);
  }
  return Object.freeze(def);
}

export type AnyRoute = RouteDefinition<
  z.ZodType | undefined,
  z.ZodType | undefined,
  z.ZodType | undefined,
  z.ZodType | null
>;

/** Request body type of a route. */
export type RouteBody<R> =
  R extends RouteDefinition<infer _P, infer _Q, infer B, infer _R> ? (B extends z.ZodType ? z.input<B> : never) : never;
/** Response type of a route. */
export type RouteResponse<R> =
  R extends RouteDefinition<infer _P, infer _Q, infer _B, infer Res>
    ? Res extends z.ZodType
      ? z.output<Res>
      : undefined
    : never;
/** Path params type of a route. */
export type RouteParams<R> =
  R extends RouteDefinition<infer P, infer _Q, infer _B, infer _R>
    ? P extends z.ZodType
      ? z.output<P>
      : Record<string, never>
    : never;
/** Query type of a route. */
export type RouteQuery<R> =
  R extends RouteDefinition<infer _P, infer Q, infer _B, infer _R>
    ? Q extends z.ZodType
      ? z.output<Q>
      : Record<string, never>
    : never;

/** Builds the concrete path for a route (`/v1/checkout/sessions/{id}` → `/v1/checkout/sessions/cs_…`). */
export function buildPath(r: Pick<AnyRoute, "path">, params: Record<string, string> = {}): string {
  return r.path.replace(PARAM_RE, (_m, k: string) => {
    const v = params[k];
    if (v === undefined) throw new Error(`missing path param ${k} for ${r.path}`);
    return encodeURIComponent(v);
  });
}

/** Converts a route path to a Fastify/find-my-way path (`{id}` → `:id`). */
export function toFastifyPath(path: string): string {
  return path.replace(PARAM_RE, ":$1");
}

/** A path matcher with `{param}` segments (used by gateway allow-lists and tests). */
export function pathMatcher(path: string): RegExp {
  const src = path
    .split("/")
    .map((seg) => (seg.match(/^\{[a-z_]+\}$/) ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${src}$`);
}
