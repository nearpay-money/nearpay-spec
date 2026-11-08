/**
 * stage 3 — agent-commerce: `nearpay login` for the CLI (lld/identity.md §6.2, lld/sdks-and-tools.md §3).
 *
 * A device-authorization flow in the shape of RFC 8628: the CLI creates a login and shows the
 * `user_code` / opens `verification_url_complete`; a signed-in dashboard user (owner, admin or
 * developer, with step-up) approves it for the session's account; the CLI's next poll receives a
 * **restricted test-mode key** (`rk_test_…`, scopes `CLI_KEY_SCOPES`, 90-day expiry) exactly once and
 * stores it in the OS keychain. No CLI session type exists: the key is an ordinary API key, listed and
 * revocable under `GET /v1/api_keys`. Served by identity.
 */
import type { KeyScope } from "../common/auth.js";
import { id } from "../common/ids.js";
import { UnixTime } from "../common/primitives.js";
import { route } from "../common/route.js";
import { inp, openEnum, out, z } from "../common/schema.js";
import { ApiKey } from "./identity.js";

/** Scopes of the key a CLI login mints: every read, plus the writes `trigger` and `events resend` need. */
export const CLI_KEY_SCOPES = [
  "checkout_sessions.read",
  "checkout_sessions.write",
  "payment_intents.read",
  "refunds.read",
  "refunds.write",
  "payment_links.read",
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
] as const satisfies readonly KeyScope[];

/** Lifetime of a CLI login before approval, and of the minted key. */
export const CLI_LOGIN_TTL_SECONDS = 900;
export const CLI_KEY_TTL_SECONDS = 90 * 86_400;
/** Minimum seconds between polls; faster polling is `429 rate_limited` with `Retry-After`. */
export const CLI_LOGIN_POLL_INTERVAL_SECONDS = 5;

/** RFC 8628 §6.1 user code: 8 characters from a 20-letter consonant alphabet, shown as `XXXX-XXXX`. */
export const CliUserCode = z
  .string()
  .regex(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/)
  .describe("Code the user confirms in the dashboard, `XXXX-XXXX` (consonants only).");

const DeviceCode = z
  .string()
  .regex(/^npdc_[0-9A-Za-z]{43}$/)
  .describe("Secret the CLI polls with (`npdc_…`, ≥ 256 bits); never shown to the user.");

const DeviceName = z
  .string()
  .min(1)
  .max(64)
  .describe("Shown to the approving user and used in the key name, e.g. the host name.");

export const CliLoginStatus = openEnum(
  ["pending", "approved", "denied", "expired", "redeemed"],
  "`pending`: waiting for the user. `approved`: the key is ready (the poll that sees it receives it). `denied`: the user refused. `expired`: not approved within 15 min. `redeemed`: the key was already delivered.",
);

export const CliLogin = out({
  object: z.literal("cli_login").describe("Always `cli_login`."),
  device_code: DeviceCode,
  user_code: CliUserCode,
  verification_url: z.url().describe("Dashboard page where the user enters `user_code`."),
  verification_url_complete: z.url().describe("Same page with `user_code` filled in (open it in the browser)."),
  expires_at: UnixTime.describe("The login must be approved before this instant."),
  interval: z.int().min(1).describe("Poll at most this often, seconds."),
}).meta({ id: "CliLogin", description: "A pending CLI login (device authorization)." });

export const CliLoginPoll = out({
  object: z.literal("cli_login_poll").describe("Always `cli_login_poll`."),
  status: CliLoginStatus,
  interval: z.int().min(1).describe("Poll at most this often, seconds."),
  key: ApiKey.optional().describe(
    "`approved` only, exactly once: the restricted test key including `secret`. Store it; it is never shown again.",
  ),
  account: out({
    id: id("acct"),
    display_name: z.string().describe("Account display name."),
  })
    .optional()
    .describe("`approved`: the account the key belongs to."),
}).meta({ id: "CliLoginPoll", description: "Result of one CLI poll." });

export const CliLoginRequest = out({
  object: z.literal("cli_login_request").describe("Always `cli_login_request`."),
  user_code: CliUserCode,
  device_name: DeviceName,
  status: CliLoginStatus,
  created: UnixTime,
  expires_at: UnixTime.describe("Approve before this instant."),
  requested_from: out({
    ip: z.string().nullable().describe("Client IP that created the login."),
    country: z.string().nullable().describe("Country of that IP (CDN header), if known."),
    user_agent: z.string().nullable().describe("User agent of the CLI."),
  }).describe("Where the login was created (shown so the user can recognise it)."),
  account: id("acct").nullable().describe("Account the key was minted for (after approval)."),
  key: id("key").nullable().describe("The minted key (after approval)."),
}).meta({ id: "CliLoginRequest", description: "A CLI login as the approving dashboard user sees it." });

const CodeParams = inp({ code: CliUserCode });
const KEY_ROLES = ["owner", "admin", "developer"] as const;

export const createCliLogin = route({
  id: "createCliLogin",
  method: "POST",
  path: "/v1/cli/logins",
  service: "identity",
  visibility: "public",
  summary: "Start a CLI login (device authorization); poll it until the user approves.",
  description: "Rate-limited per client IP (10 per 10 min). The user code is single-use and expires after 15 min.",
  auth: ["anonymous"],
  idempotent: false,
  body: inp({
    device_name: DeviceName,
    client_version: z.string().max(32).optional().describe("CLI version (support and audit only)."),
  }),
  response: CliLogin,
  status: 201,
  errors: [],
  stage: 3,
});

export const pollCliLogin = route({
  id: "pollCliLogin",
  method: "POST",
  path: "/v1/cli/logins/poll",
  service: "identity",
  visibility: "public",
  summary: "Poll a CLI login; the approved key is returned exactly once.",
  description:
    "Polling faster than `interval` is `429 rate_limited` with `Retry-After` (RFC 8628 `slow_down`). An unknown or purged device code is `404 resource_missing`.",
  auth: ["anonymous"],
  idempotent: false,
  body: inp({ device_code: DeviceCode }),
  response: CliLoginPoll,
  status: 200,
  errors: [],
  stage: 3,
});

export const getCliLogin = route({
  id: "getCliLogin",
  method: "GET",
  path: "/v1/cli/logins/{code}",
  service: "identity",
  visibility: "public",
  summary: "Show a CLI login before approving it.",
  description: "Unknown, expired more than 24 h ago, or approved for another account → `404 resource_missing`.",
  auth: ["session"],
  roles: KEY_ROLES,
  idempotent: false,
  params: CodeParams,
  response: CliLoginRequest,
  status: 200,
  errors: [],
  stage: 3,
});

export const approveCliLogin = route({
  id: "approveCliLogin",
  method: "POST",
  path: "/v1/cli/logins/{code}/approve",
  service: "identity",
  visibility: "public",
  summary: "Approve a CLI login: mints a restricted test key for the session's account.",
  description:
    "Always test mode, whatever `NearPay-Mode` says. The key is `restricted` with `CLI_KEY_SCOPES`, named `CLI · <device_name>`, expiring after 90 days; audited as `api_key.created` with the login's IP. Not `pending` → `409 state_conflict`.",
  auth: ["session"],
  roles: KEY_ROLES,
  stepUp: true,
  idempotent: true,
  params: CodeParams,
  body: inp({}),
  response: CliLoginRequest,
  status: 200,
  errors: ["state_conflict"],
  stage: 3,
});

export const denyCliLogin = route({
  id: "denyCliLogin",
  method: "POST",
  path: "/v1/cli/logins/{code}/deny",
  service: "identity",
  visibility: "public",
  summary: "Refuse a CLI login.",
  description: "Not `pending` → `409 state_conflict`.",
  auth: ["session"],
  roles: KEY_ROLES,
  idempotent: true,
  params: CodeParams,
  body: inp({}),
  response: CliLoginRequest,
  status: 200,
  errors: ["state_conflict"],
  stage: 3,
});
