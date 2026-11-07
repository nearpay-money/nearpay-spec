/**
 * Principals, roles, scopes and header names (lld/00-foundations.md §9, lld/identity.md §6, ADR-0014).
 */
import { closedEnum, z } from "./schema.js";

/** HTTP header names used across the platform. */
export const HEADERS = {
  authorization: "Authorization",
  /** Internal JWT minted by identity (request token) or a service token. */
  token: "X-NearPay-Token",
  requestId: "X-Request-Id",
  traceparent: "traceparent",
  idempotencyKey: "Idempotency-Key",
  idempotentReplayed: "Idempotent-Replayed",
  apiVersion: "NearPay-Version",
  /** Dashboard sessions choose the mode with this header (`live` | `test`, default `test`). */
  mode: "NearPay-Mode",
  clientSecret: "X-NearPay-Client-Secret",
  csrf: "X-CSRF-Token",
  turnstile: "X-Turnstile-Token",
  webhookSignature: "NearPay-Signature",
  webhookEventId: "NearPay-Event-Id",
  webhookEventType: "NearPay-Event-Type",
  retryAfter: "Retry-After",
  rateLimitLimit: "RateLimit-Limit",
  rateLimitRemaining: "RateLimit-Remaining",
  rateLimitReset: "RateLimit-Reset",
  x402PaymentRequired: "PAYMENT-REQUIRED",
  x402PaymentSignature: "PAYMENT-SIGNATURE",
  x402PaymentResponse: "PAYMENT-RESPONSE",
} as const;

/** Dashboard session cookie (identity LLD §4). */
export const SESSION_COOKIE = "__Host-np_session";
/** Console (ops) session cookie. */
export const OPS_SESSION_COOKIE = "__Host-np_ops";

/** Current public API version (date-based, api-conventions §5). */
export const API_VERSION = "2026-11-01" as const;
export const API_VERSIONS = [API_VERSION] as const;
export const ApiVersion = closedEnum(API_VERSIONS, "Public API version (date).");

/** Merchant roles (FR-ACC-01). */
export const ROLES = ["owner", "admin", "developer", "finance", "support", "viewer"] as const;
export type Role = (typeof ROLES)[number];
export const RoleSchema = closedEnum(ROLES, "Role of a user in a merchant account.");

/** Restricted-key scopes (identity LLD §6). Secret keys hold all of them. */
export const KEY_SCOPES = [
  "checkout_sessions.read",
  "checkout_sessions.write",
  "payment_intents.read",
  "payment_intents.write",
  "refunds.read",
  "refunds.write",
  "payment_links.read",
  "payment_links.write",
  "customers.read",
  "customers.write",
  "invoices.read",
  "invoices.write",
  "subscriptions.read",
  "subscriptions.write",
  "products.read",
  "products.write",
  "webhook_endpoints.read",
  "webhook_endpoints.write",
  "events.read",
  "destinations.read",
  "balance_transactions.read",
  "agentpay.facilitate",
] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

/** Scopes held by publishable keys. */
export const PUBLISHABLE_SCOPES = ["checkout:public", "elements:public"] as const;
export type PublishableScope = (typeof PUBLISHABLE_SCOPES)[number];

/** Service-to-service scopes (foundations §9 catalogue). */
export const SERVICE_SCOPES = [
  "identity.context.read",
  "identity.recipients.read",
  "payments.attempts.create",
  "payments.read",
  "payments.receipts.read",
  "payments.sessions.create",
  "rails.executions.write",
  "rails.read",
  "agentpay.relay",
  "compliance.screen",
  "compliance.read",
  "notify.send",
  "sandbox.use",
  "billing.read",
] as const;
export type ServiceScope = (typeof SERVICE_SCOPES)[number];

/** Ops (console / ops CLI) scopes. */
export const OPS_SCOPES = [
  "compliance.kyb.decide",
  "compliance.cases.write",
  "sentinel.killswitch",
  "rails.read",
  "payments.read",
  // stage 2 — identity-console (console routes, lld/dashboard-and-console.md §2)
  "console.session",
  "identity.merchants.read",
  "identity.audit.read",
  "compliance.read",
  "compliance.accounts.write",
  "compliance.blocklist.write",
  "compliance.screen",
  "sentinel.read",
  "sentinel.findings.write",
] as const;
export type OpsScope = (typeof OPS_SCOPES)[number];

// stage 2 — identity-console: ops roles (lld/identity.md §4 `ops_operators.role`, §6.3)
/** Console operator roles (`ops_operators.role`). Ops routes list the roles they admit in `opsRoles`. */
export const OPS_ROLES = ["ops", "ops_admin"] as const;
export type OpsRole = (typeof OPS_ROLES)[number];
export const OpsRoleSchema = closedEnum(OPS_ROLES, "Role of a console operator.");

/**
 * Scopes identity mints into `scp` for an ops principal of each role (foundations §9). Both roles
 * hold the same scopes; what only an `ops_admin` may do (second approvals, blocklist removals) is
 * decided per route by `opsRoles`, which `@nearpay-internal/service` checks against the
 * `ops_role` claim.
 */
export const OPS_ROLE_SCOPES: Record<OpsRole, readonly OpsScope[]> = {
  ops: OPS_SCOPES,
  ops_admin: OPS_SCOPES,
};

/** Console session lifetimes (identity §4): idle timeout and absolute lifetime, seconds. */
export const OPS_SESSION_TTL_SECONDS = { idle: 1800, absolute: 43_200 } as const;

/** Internal services that hold service credentials. */
export const SERVICES = [
  "identity",
  "payments",
  "billing",
  "rails",
  "agentpay",
  "compliance",
  "webhooks",
  "notify",
  "sandbox",
  "sentinel",
] as const;
export type ServiceName = (typeof SERVICES)[number];

/**
 * Static scopes per service client (foundations §9). A call outside this table is a defect;
 * identity provisions `service_clients.scopes` from it.
 */
export const SERVICE_CLIENT_SCOPES: Record<ServiceName, readonly ServiceScope[]> = {
  identity: ["compliance.screen", "rails.read", "notify.send", "compliance.read" /* stage 2 — identity-console */],
  payments: [
    "identity.context.read",
    "rails.executions.write",
    "rails.read",
    "agentpay.relay",
    "compliance.read",
    "sandbox.use",
  ],
  rails: ["compliance.screen", "sandbox.use"],
  agentpay: [
    "payments.attempts.create",
    "payments.read",
    "rails.read",
    "identity.context.read",
    "compliance.screen",
    "sandbox.use",
  ],
  sentinel: ["rails.read", "sandbox.use"],
  billing: ["payments.sessions.create", "payments.read", "notify.send"],
  notify: ["identity.recipients.read", "payments.receipts.read", "billing.read"],
  compliance: [],
  webhooks: [],
  sandbox: [],
};

/** Principal types carried in the internal JWT `ptype` claim. */
export const PRINCIPAL_TYPES = [
  "secret_key",
  "restricted_key",
  "publishable_key",
  "client_secret",
  "session",
  "ops",
  "service",
  "anonymous",
] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

/**
 * How a route may be called. Strings so route tables read like the LLD tables.
 * - `anonymous`                  — no credential (identity's anonymous allow-list)
 * - `secret_key`                 — `sk_live_`/`sk_test_`
 * - `restricted_key:<scope>`     — `rk_…` holding that scope (secret keys implicitly hold every scope)
 * - `publishable_key`            — `pk_…` (route is tagged publishable)
 * - `client_secret`              — anonymous at the gateway + `X-NearPay-Client-Secret` checked by the service
 * - `session`                    — dashboard session cookie (roles/step-up on the route)
 * - `service:<scope>`            — internal service token holding the scope
 * - `ops:<scope>`                — ops principal (console / ops CLI) holding the scope
 * - `gateway`                    — only Traefik ForwardAuth may call it (internal network)
 * - `service_client`             — HTTP Basic with a service `client_id` and secret
 * - `internal`                   — any caller on the internal network (public keys, health)
 */
export type RouteAuth =
  | "anonymous"
  | "secret_key"
  | `restricted_key:${KeyScope}`
  | "publishable_key"
  | "client_secret"
  | "session"
  | `service:${ServiceScope}`
  | `ops:${OpsScope}`
  | "gateway"
  | "service_client"
  | "internal";

/** Claims of the internal JWT (foundations §9). */
export const InternalTokenClaims = z
  .looseObject({
    iss: z.literal("nearpay-identity").describe("Issuer."),
    aud: z.literal("nearpay").describe("Audience."),
    sub: z.string().min(1).describe("Principal id (key id, user id, service name, or `anonymous`)."),
    acct: z.string().optional().describe("Account id (`acct_…`) for merchant principals."),
    lm: z.boolean().optional().describe("Livemode of the request (absent for service tokens)."),
    ptype: closedEnum(PRINCIPAL_TYPES, "Principal type."),
    scp: z.array(z.string()).describe("Scopes held by the principal."),
    rid: z.string().optional().describe("Request id (`req_…`) the token was minted for."),
    role: closedEnum(ROLES, "Role of the session user.").optional(),
    step_up_until: z.int().optional().describe("Unix time until which a step-up assertion is fresh (sessions)."),
    // stage 2 — identity-console
    ops_role: closedEnum(OPS_ROLES, "Role of the console operator (`ptype=ops`).").optional(),
    iat: z.int().describe("Issued at (unix seconds)."),
    exp: z.int().describe("Expiry (unix seconds)."),
  })
  .meta({ id: "InternalTokenClaims", description: "Claims of the internal Ed25519 JWT (`X-NearPay-Token`)." });
export type InternalTokenClaims = z.infer<typeof InternalTokenClaims>;

/** Token lifetimes (foundations §9). */
export const TOKEN_TTL_SECONDS = { request: 60, service: 300, serviceRefreshBefore: 30 } as const;
