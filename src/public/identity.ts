/**
 * Public identity API (lld/identity.md §6, Stage 1 subset): sign-up and passkeys, account,
 * API keys, settlement destinations. Dashboard routes are session-only (ADR-0014).
 */
import { ApiVersion, KEY_SCOPES, ROLES, RoleSchema } from "../common/auth.js";
import { id } from "../common/ids.js";
import { createdFilterShape, listOf, listQueryShape } from "../common/pagination.js";
import {
  AssetId,
  Bps,
  ChainAddress,
  ChainId,
  CountryCode,
  CurvePublicKey,
  FiatAmount,
  Livemode,
  UnixTime,
  Url,
} from "../common/primitives.js";
import { route } from "../common/route.js";
import { closedEnum, inp, openEnum, out, z } from "../common/schema.js";
import {
  AuthenticationResponseJSON,
  CreationOptionsJSON,
  RegistrationResponseJSON,
  RequestOptionsJSON,
} from "../common/webauthn.js";

// =============================================================================================
// Objects
// =============================================================================================

export const UsdAmount = out({
  amount: FiatAmount,
  currency: z.literal("usd").describe("Always `usd`."),
}).meta({ id: "UsdAmount", description: "An amount in US dollars (minor units)." });

// spec 0.2.1 — dashboard CR (checkout appearance)
export const CheckoutTheme = openEnum(
  ["auto", "light", "dark"],
  "Checkout colour scheme: `auto` follows the payer's device setting.",
);
export const CornerRadius = z.int().min(0).max(24).describe("Corner radius in CSS pixels (0 = square).");

export const AccountSettings = out({
  late_payments: z.boolean().describe("Accept settlements that arrive after a session expired (INV-3); default false."),
  underpay_tolerance_bps: Bps.describe("Accept short settlements within this tolerance (0–100 bps); default 0."),
  session_ttl_default: z.int().min(300).max(86_400).describe("Default checkout-session lifetime in seconds."),
  email_receipts: z.boolean().describe("Email a receipt to the customer when a payment succeeds."),
  branding: out({
    accent_color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
      .describe("Accent colour `#RRGGBB`."),
    logo_url: Url.nullable().describe("HTTPS URL of a square logo."),
    // spec 0.2.1 — dashboard CR (checkout appearance)
    theme: CheckoutTheme.optional().describe("Checkout colour scheme (default `auto`); absent from older servers."),
    corner_radius: CornerRadius.optional().describe(
      "Corner radius of checkout cards and controls, px (default 8); absent from older servers.",
    ),
  }).describe("Checkout branding."),
}).meta({ id: "AccountSettings", description: "Merchant settings that change checkout behaviour." });

export const Account = out({
  id: id("acct"),
  object: z.literal("account").describe("Always `account`."),
  created: UnixTime,
  display_name: z.string().min(1).max(100).describe("Name shown to payers until KYB verifies a legal name."),
  verified_legal_name: z
    .string()
    .nullable()
    .describe(
      "Legal name approved by NearPay's KYB review (self-declared business details reviewed by ops), shown on checkout once set.",
    ),
  country: CountryCode.nullable().describe("Country of the merchant."),
  status: openEnum(["active", "suspended", "closed"], "Account status."),
  kyb_status: openEnum(["not_started", "pending", "needs_info", "approved", "rejected"], "KYB status."),
  live_enabled: z.boolean().describe("Live mode is enabled: KYB approved, an active live destination, status active."),
  fee_bearer: closedEnum(
    ["payer", "merchant"],
    "Who bears NearPay's fee: the payer pays it on top (default) or it is deducted from the settlement.",
  ),
  api_version: ApiVersion.describe("API version pinned for this account."),
  settings: AccountSettings,
  // spec 0.2.1 — dashboard CR
  website: Url.nullable()
    .optional()
    .describe("Merchant website (account setting, shown in the dashboard and receipts); absent from older servers."),
}).meta({ id: "Account", description: "A merchant account." });
export type Account = z.infer<typeof Account>;

export const AccountRequirements = out({
  object: z.literal("account_requirements").describe("Always `account_requirements`."),
  live_enabled: z.boolean().describe("Whether live mode is enabled."),
  missing: z
    .array(openEnum(["kyb", "destination", "account_status"], "A missing live-mode requirement."))
    .describe("What is still needed before live mode is enabled."),
}).meta({ id: "AccountRequirements", description: "What an account still needs to go live (FR-ACC-05)." });

export const DashboardSession = out({
  object: z.literal("dashboard_session").describe("Always `dashboard_session`."),
  user: out({
    id: id("usr"),
    email: z.email().describe("Email of the signed-in user."),
  }).describe("Signed-in user."),
  account: out({
    id: id("acct"),
    display_name: z.string().describe("Account display name."),
  }).describe("Account the session acts for."),
  role: closedEnum(ROLES, "Role of the user in the account."),
  csrf_token: z.string().min(32).describe("Send as `X-CSRF-Token` on every unsafe request."),
  expires_at: UnixTime.describe("Absolute session expiry."),
}).meta({
  id: "DashboardSession",
  description:
    "A dashboard session. Sign-in responses set the session cookie `__Host-np_session`; `GET /v1/auth/session` returns the current session without setting it.",
});

export const ApiKey = out({
  id: id("key"),
  object: z.literal("api_key").describe("Always `api_key`."),
  created: UnixTime,
  livemode: Livemode,
  type: openEnum(["secret", "publishable", "restricted"], "Key type."),
  name: z.string().describe("Name given when the key was created."),
  display_prefix: z.string().describe("Key prefix, e.g. `sk_live_`."),
  last4: z.string().length(4).describe("Last four characters of the key."),
  scopes: z.array(z.string()).describe("Scopes of a restricted key; empty for secret and publishable keys."),
  ip_allowlist: z.array(z.string()).describe("CIDR ranges allowed to use the key; empty = any."),
  expires_at: UnixTime.nullable().describe("Expiry, if set."),
  last_used_at: UnixTime.nullable().describe("Last use (updated at most every minute)."),
  secret: z
    .string()
    .regex(/^(sk|pk|rk)_(live|test)_[0-9A-Za-z]{48}$/)
    .optional()
    .describe("The full key. Returned only once, when the key is created or rolled."),
}).meta({ id: "ApiKey", description: "An API key record (the secret itself is shown once)." });

export const AttestationChallenge = out({
  id: id("chl"),
  message: z.string().describe("Exact UTF-8 message the destination key must sign."),
  signing_standard: openEnum(["nep413", "eip191", "solana", "bip322"], "How to sign the message."),
  nonce: z
    .string()
    .regex(/^[A-Za-z0-9+/]{43}=$/)
    .nullable()
    .describe("NEP-413 nonce (32 bytes, base64); null for other standards."),
  recipient: z.string().nullable().describe("NEP-413 recipient (`nearpay.money`); null for other standards."),
  expires_at: UnixTime.describe("Challenge expiry (10 minutes)."),
}).meta({
  id: "AttestationChallenge",
  description: "Message proving control of a settlement destination (FR-SET-02).",
});

export const SettlementDestinationType = closedEnum(
  ["chain_address", "intents_account"],
  "Where funds settle: an address on a chain, or a NEAR Intents account.",
);

export const SettlementDestination = out({
  id: id("sd"),
  object: z.literal("settlement_destination").describe("Always `settlement_destination`."),
  created: UnixTime,
  livemode: Livemode,
  asset_id: AssetId.describe("Asset the merchant receives."),
  type: SettlementDestinationType,
  chain: ChainId.describe("Chain of the address; `near:mainnet` for Intents accounts."),
  address: ChainAddress.describe("Receiving address or Intents account."),
  label: z.string().describe("Merchant label."),
  status: openEnum(
    ["pending_verification", "pending_approval", "cooling_off", "active", "disabled"],
    "Lifecycle status; only `active` destinations receive new payments.",
  ),
  verification: openEnum(["signature", "unverified", "test"], "How ownership was established."),
  fingerprint: z
    .string()
    .regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{2}$/)
    .describe("Short fingerprint shown on checkout next to the merchant name, e.g. `7KQ2-M9XA-31`."),
  is_default: z.boolean().describe("Default destination for its asset or for the account."),
  active_at: UnixTime.nullable().describe("When the destination became (or becomes) active."),
  min_payment_amount: UsdAmount.nullable().describe(
    "Smallest payment that is economic for this destination (FR-SET-04).",
  ),
  per_payment_cap: UsdAmount.nullable().describe("Cap per payment for unverified destinations."),
  disabled_reason: openEnum(
    ["merchant", "compliance", "replaced", "expired"],
    "Why it was disabled (`expired`: a pending destination not approved within 7 days; spec 0.2.1).",
  ).nullable(),
  // stage 2 — identity-console: two-approver rule (identity §5)
  approval: out({
    required: z
      .int()
      .min(1)
      .max(2)
      .describe("Approvals needed: 2 when the account has ≥ 2 owner/admin members, else 1."),
    approved_by: z.array(id("usr")).describe("Users who approved, in order (the creator counts when 1 is required)."),
    rejected_by: id("usr").nullable().describe("User who rejected the destination, if any (it is then disabled)."),
  })
    .nullable()
    .optional()
    .describe("Approval state; null for test-mode destinations. Absent from Stage 1 servers."),
  attestation_challenge: AttestationChallenge.optional().describe(
    "Present on creation and on `POST /v1/settlement_destinations/{id}/challenge` while the destination awaits its ownership signature.",
  ),
  // spec 0.2.1 — dashboard and notify CRs
  created_by: id("usr")
    .nullable()
    .optional()
    .describe("Dashboard user who created the destination; null when unknown (created before Stage 2). Spec 0.2.1."),
}).meta({ id: "SettlementDestination", description: "Where a merchant receives settlements (FR-SET-01)." });
export type SettlementDestination = z.infer<typeof SettlementDestination>;

// =============================================================================================
// Routes — auth (anonymous; Turnstile on sign-up)
// =============================================================================================

export const signup = route({
  id: "signup",
  method: "POST",
  path: "/v1/auth/signup",
  service: "identity",
  visibility: "public",
  summary: "Start sign-up: email a magic link.",
  auth: ["anonymous"],
  idempotent: false,
  body: inp({
    email: z.email().max(254).describe("Email address of the new user."),
    turnstile_token: z.string().min(1).max(4096).describe("Cloudflare Turnstile token."),
  }),
  response: null,
  status: 202,
  errors: ["turnstile_failed"],
  stage: 1,
});

export const verifyMagicLink = route({
  id: "verifyMagicLink",
  method: "POST",
  path: "/v1/auth/magic_links/verify",
  service: "identity",
  visibility: "public",
  summary: "Exchange a magic-link token for a registration token.",
  auth: ["anonymous"],
  idempotent: false,
  body: inp({ token: z.string().min(16).max(256).describe("Token from the magic link.") }),
  response: out({
    object: z.literal("registration").describe("Always `registration`."),
    registration_token: z.string().min(32).describe("Single-use token for passkey registration (5 minutes)."),
    email: z.email().describe("Verified email."),
    expires_at: UnixTime.describe("Registration token expiry."),
    // stage 2 — identity-console
    purpose: openEnum(["signup", "recovery", "invite"], "Why the magic link was sent.")
      .optional()
      .describe(
        "Why the magic link was sent: `signup` creates an account, `recovery` adds a passkey to the existing user (locks destination changes 48 h), `invite` joins the inviting account. Absent from Stage 1 servers (= `signup`).",
      ),
    invitation: out({
      account_display_name: z.string().describe("Account the invitation joins."),
      role: RoleSchema,
    })
      .optional()
      .describe("Present for `invite`: what passkey registration will join."),
  }).meta({ id: "Registration", description: "A verified email ready for passkey registration." }),
  status: 200,
  errors: ["link_expired", "link_used"],
  stage: 1,
});

export const passkeyRegistrationOptions = route({
  id: "passkeyRegistrationOptions",
  method: "POST",
  path: "/v1/auth/passkeys/registration/options",
  service: "identity",
  visibility: "public",
  summary: "WebAuthn creation options for a new passkey.",
  description: "Called with a registration token (new user) or a session (additional passkey).",
  auth: ["anonymous", "session"],
  idempotent: false,
  body: inp({
    registration_token: z.string().min(32).optional().describe("Registration token (new users)."),
  }),
  response: CreationOptionsJSON,
  status: 200,
  errors: ["link_expired"],
  stage: 1,
});

export const passkeyRegistrationVerify = route({
  id: "passkeyRegistrationVerify",
  method: "POST",
  path: "/v1/auth/passkeys/registration/verify",
  service: "identity",
  visibility: "public",
  summary: "Register a passkey; a new user gets an account (owner) and a session.",
  auth: ["anonymous", "session"],
  idempotent: false,
  body: inp({
    registration_token: z.string().min(32).optional().describe("Registration token (new users)."),
    credential: RegistrationResponseJSON,
    passkey_name: z.string().min(1).max(64).optional().describe("Label for the passkey."),
    display_name: z.string().min(1).max(100).optional().describe("Account display name (new users)."),
  }),
  response: DashboardSession,
  status: 200,
  errors: ["webauthn_failed", "link_expired"],
  stage: 1,
});

export const passkeyAuthenticationOptions = route({
  id: "passkeyAuthenticationOptions",
  method: "POST",
  path: "/v1/auth/passkeys/authentication/options",
  service: "identity",
  visibility: "public",
  summary: "WebAuthn request options for signing in.",
  auth: ["anonymous"],
  idempotent: false,
  body: inp({ email: z.email().optional().describe("Email hint; omit for discoverable credentials.") }),
  response: RequestOptionsJSON,
  status: 200,
  errors: [],
  stage: 1,
});

export const passkeyAuthenticationVerify = route({
  id: "passkeyAuthenticationVerify",
  method: "POST",
  path: "/v1/auth/passkeys/authentication/verify",
  service: "identity",
  visibility: "public",
  summary: "Sign in with a passkey.",
  auth: ["anonymous"],
  idempotent: false,
  body: inp({ credential: AuthenticationResponseJSON }),
  response: DashboardSession,
  status: 200,
  errors: ["webauthn_failed"],
  stage: 1,
});

export const stepUpOptions = route({
  id: "stepUpOptions",
  method: "POST",
  path: "/v1/auth/step_up/options",
  service: "identity",
  visibility: "public",
  summary: "WebAuthn request options for a step-up confirmation.",
  auth: ["session"],
  idempotent: false,
  body: inp({}),
  response: RequestOptionsJSON,
  status: 200,
  errors: [],
  stage: 1,
});

export const stepUpVerify = route({
  id: "stepUpVerify",
  method: "POST",
  path: "/v1/auth/step_up/verify",
  service: "identity",
  visibility: "public",
  summary: "Confirm a sensitive action with a passkey; fresh for 10 minutes.",
  auth: ["session"],
  idempotent: false,
  body: inp({ credential: AuthenticationResponseJSON }),
  response: out({
    object: z.literal("step_up").describe("Always `step_up`."),
    step_up_until: UnixTime.describe("Step-up stays fresh until this time."),
  }).meta({ id: "StepUp", description: "A fresh step-up confirmation." }),
  status: 200,
  errors: ["webauthn_failed"],
  stage: 1,
});

export const getDashboardSession = route({
  id: "getDashboardSession",
  method: "GET",
  path: "/v1/auth/session",
  service: "identity",
  visibility: "public",
  summary: "The current dashboard session, including its CSRF token.",
  description:
    "Lets a reload or a new tab recover the session (and `csrf_token`) from the session cookie. Sets no cookie (the sliding TTL applies as for any session request); an expired or missing session is `401 authentication_required`.",
  auth: ["session"],
  idempotent: false,
  response: DashboardSession,
  status: 200,
  errors: [],
  stage: 1,
});

export const logout = route({
  id: "logout",
  method: "POST",
  path: "/v1/auth/logout",
  service: "identity",
  visibility: "public",
  summary: "End the dashboard session.",
  auth: ["session"],
  idempotent: false,
  body: inp({}),
  response: null,
  status: 204,
  errors: [],
  stage: 1,
});

// =============================================================================================
// Routes — account
// =============================================================================================

export const getAccount = route({
  id: "getAccount",
  method: "GET",
  path: "/v1/account",
  service: "identity",
  visibility: "public",
  summary: "Retrieve the account.",
  auth: ["session"],
  idempotent: false,
  response: Account,
  status: 200,
  errors: [],
  stage: 1,
});

export const updateAccount = route({
  id: "updateAccount",
  method: "PATCH",
  path: "/v1/account",
  service: "identity",
  visibility: "public",
  summary: "Update account settings.",
  description:
    "Changing `fee_bearer`, `settings.late_payments` or `settings.underpay_tolerance_bps` needs a fresh step-up (`step_up_required` otherwise).",
  auth: ["session"],
  roles: ["owner", "admin"],
  idempotent: true,
  body: inp({
    display_name: z.string().min(1).max(100).optional().describe("Display name."),
    country: CountryCode.optional().describe("Country."),
    website: Url.nullable().optional().describe("Merchant website, HTTPS (`null` clears it). Spec 0.2.1."),
    fee_bearer: closedEnum(["payer", "merchant"], "Who bears NearPay's fee.").optional(),
    settings: inp({
      late_payments: z.boolean().optional().describe("Accept late settlements."),
      underpay_tolerance_bps: z.int().min(0).max(100).optional().describe("Short-settlement tolerance (≤ 100 bps)."),
      session_ttl_default: z.int().min(300).max(86_400).optional().describe("Default session lifetime, seconds."),
      email_receipts: z.boolean().optional().describe("Email receipts to customers."),
      branding: inp({
        accent_color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .nullable()
          .optional()
          .describe("Accent colour."),
        logo_url: Url.nullable().optional().describe("HTTPS logo URL."),
        theme: CheckoutTheme.optional().describe("Checkout colour scheme. Spec 0.2.1."),
        corner_radius: CornerRadius.optional().describe("Corner radius, px. Spec 0.2.1."),
      })
        .optional()
        .describe("Checkout branding."),
    })
      .optional()
      .describe("Settings to change."),
  }),
  response: Account,
  status: 200,
  errors: ["invalid_setting"],
  stage: 1,
});

export const getAccountRequirements = route({
  id: "getAccountRequirements",
  method: "GET",
  path: "/v1/account/requirements",
  service: "identity",
  visibility: "public",
  summary: "What the account still needs to go live.",
  auth: ["session"],
  idempotent: false,
  response: AccountRequirements,
  status: 200,
  errors: [],
  stage: 1,
});

// =============================================================================================
// Routes — API keys (session, developer+, step-up for writes)
// =============================================================================================

const KeyIdParams = inp({ id: id("key") });
const KEY_ROLES = ["owner", "admin", "developer"] as const;

// stage 2 — identity-console: restricted keys (identity §6)
/**
 * Per-resource permissions of a restricted key: `<resource>.read` or `<resource>.write` (write
 * implies read). Items accept any string so the service, not request validation, answers an unknown
 * scope with `scope_unknown`.
 */
const RestrictedKeyScopes = z
  .array(
    z
      .string()
      .min(1)
      .max(64)
      .describe(`A scope: ${KEY_SCOPES.map((k) => `\`${k}\``).join(", ")}.`),
  )
  .min(1)
  .max(KEY_SCOPES.length)
  .describe("Scopes of a restricted key.");

export const listApiKeys = route({
  id: "listApiKeys",
  method: "GET",
  path: "/v1/api_keys",
  service: "identity",
  visibility: "public",
  summary: "List API keys of the current mode (no secrets).",
  auth: ["session"],
  roles: KEY_ROLES,
  idempotent: false,
  query: inp(listQueryShape),
  response: listOf(ApiKey, "ApiKeyList", "A page of API keys."),
  status: 200,
  errors: [],
  stage: 1,
});

export const createApiKey = route({
  id: "createApiKey",
  method: "POST",
  path: "/v1/api_keys",
  service: "identity",
  visibility: "public",
  summary: "Create an API key; the secret is returned once.",
  auth: ["session"],
  roles: KEY_ROLES,
  stepUp: true,
  idempotent: true,
  body: inp({
    type: closedEnum(
      ["secret", "publishable", "restricted"],
      "Key type. `restricted` (`rk_…`, Stage 2) holds only the `scopes` given.",
    ),
    livemode: z.boolean().describe("Create a live (`true`) or test (`false`) key."),
    name: z.string().min(1).max(64).describe("Label."),
    // stage 2 — identity-console
    scopes: RestrictedKeyScopes.optional().describe(
      "Required for `restricted` keys (at least one), refused for the other types. An unknown scope is `400 scope_unknown`.",
    ),
    ip_allowlist: z.array(z.cidrv4().or(z.cidrv6())).max(20).optional().describe("Allowed CIDR ranges."),
    expires_at: UnixTime.optional().describe("Optional expiry."),
  }),
  response: ApiKey,
  status: 201,
  errors: ["scope_unknown"],
  stage: 1,
});

export const rollApiKey = route({
  id: "rollApiKey",
  method: "POST",
  path: "/v1/api_keys/{id}/roll",
  service: "identity",
  visibility: "public",
  summary: "Replace a key; the old one keeps working for a grace period.",
  auth: ["session"],
  roles: KEY_ROLES,
  stepUp: true,
  idempotent: true,
  params: KeyIdParams,
  body: inp({
    expire_old_in_seconds: z.int().min(0).max(604_800).default(0).describe("Grace period for the old key (≤ 7 days)."),
  }),
  response: ApiKey,
  status: 201,
  errors: ["state_conflict"],
  stage: 1,
});

export const revokeApiKey = route({
  id: "revokeApiKey",
  method: "DELETE",
  path: "/v1/api_keys/{id}",
  service: "identity",
  visibility: "public",
  summary: "Revoke a key immediately.",
  auth: ["session"],
  roles: KEY_ROLES,
  stepUp: true,
  idempotent: false,
  params: KeyIdParams,
  response: null,
  status: 204,
  errors: [],
  stage: 1,
});

// =============================================================================================
// Routes — settlement destinations
// =============================================================================================

const DestinationIdParams = inp({ id: id("sd") });

export const listSettlementDestinations = route({
  id: "listSettlementDestinations",
  method: "GET",
  path: "/v1/settlement_destinations",
  service: "identity",
  visibility: "public",
  summary: "List settlement destinations.",
  auth: ["session", "secret_key", "restricted_key:destinations.read"],
  idempotent: false,
  query: inp({
    ...listQueryShape,
    status: openEnum(
      ["pending_verification", "pending_approval", "cooling_off", "active", "disabled"],
      "Only destinations with this status.",
    ).optional(),
  }),
  response: listOf(SettlementDestination, "SettlementDestinationList", "A page of settlement destinations."),
  status: 200,
  errors: [],
  stage: 1,
});

export const getSettlementDestination = route({
  id: "getSettlementDestination",
  method: "GET",
  path: "/v1/settlement_destinations/{id}",
  service: "identity",
  visibility: "public",
  summary: "Retrieve a settlement destination.",
  auth: ["session", "secret_key", "restricted_key:destinations.read"],
  idempotent: false,
  params: DestinationIdParams,
  response: SettlementDestination,
  status: 200,
  errors: [],
  stage: 1,
});

export const createSettlementDestination = route({
  id: "createSettlementDestination",
  method: "POST",
  path: "/v1/settlement_destinations",
  service: "identity",
  visibility: "public",
  summary: "Add a settlement destination; returns an attestation challenge to sign.",
  description: "In test mode the destination becomes `active` immediately with `verification: test`.",
  auth: ["session"],
  roles: ["owner", "admin"],
  stepUp: true,
  idempotent: true,
  body: inp({
    asset_id: AssetId.describe("Asset to receive."),
    type: SettlementDestinationType,
    chain: ChainId.describe("Chain of the address (`near:mainnet` for Intents accounts)."),
    address: ChainAddress.describe("Receiving address or Intents account."),
    label: z.string().min(1).max(64).describe("Label."),
  }),
  response: SettlementDestination,
  status: 201,
  errors: [
    "address_invalid",
    "destination_in_use",
    "recovery_lock",
    "screening_blocked",
    "memo_destination_unsupported",
    "asset_unsupported",
    "screening_unavailable",
  ],
  stage: 1,
});

export const attestSettlementDestination = route({
  id: "attestSettlementDestination",
  method: "POST",
  path: "/v1/settlement_destinations/{id}/attest",
  service: "identity",
  visibility: "public",
  summary: "Submit the ownership signature for a destination.",
  auth: ["session"],
  roles: ["owner", "admin"],
  idempotent: true,
  params: DestinationIdParams,
  body: inp({
    challenge_id: id("chl"),
    standard: closedEnum(["nep413", "eip191"], "Signing standard used (Stage 1: NEAR and EVM)."),
    signature: z
      .string()
      .min(16)
      .max(1024)
      .describe("NEP-413: base64 ed25519 signature. EIP-191: 0x-prefixed 65-byte hex signature."),
    public_key: CurvePublicKey.optional().describe("NEP-413 only: `ed25519:<base58>` key that signed."),
  }),
  response: SettlementDestination,
  status: 200,
  errors: ["attestation_invalid", "challenge_expired", "state_conflict"],
  stage: 1,
});

export const challengeSettlementDestination = route({
  id: "challengeSettlementDestination",
  method: "POST",
  path: "/v1/settlement_destinations/{id}/challenge",
  service: "identity",
  visibility: "public",
  summary: "Issue a fresh attestation challenge for a destination awaiting its ownership signature.",
  description:
    "Only for a destination in `pending_verification`; returns it with a new `attestation_challenge` (10 minutes), the same shape as on creation. Earlier unused challenges of the destination stop being accepted.",
  auth: ["session"],
  roles: ["owner", "admin"],
  stepUp: true,
  idempotent: true,
  params: DestinationIdParams,
  body: inp({}),
  response: SettlementDestination,
  status: 200,
  errors: ["state_conflict"],
  stage: 1,
});

export const setDefaultSettlementDestination = route({
  id: "setDefaultSettlementDestination",
  method: "POST",
  path: "/v1/settlement_destinations/{id}/set_default",
  service: "identity",
  visibility: "public",
  summary: "Make an active destination the default for its asset (or the account).",
  auth: ["session"],
  roles: ["owner", "admin"],
  stepUp: true,
  idempotent: true,
  params: DestinationIdParams,
  body: inp({
    scope: closedEnum(["asset", "account"], "Default for its asset only, or for the whole account.").default("asset"),
  }),
  response: SettlementDestination,
  status: 200,
  errors: ["destination_not_active"],
  stage: 1,
});

export const disableSettlementDestination = route({
  id: "disableSettlementDestination",
  method: "POST",
  path: "/v1/settlement_destinations/{id}/disable",
  service: "identity",
  visibility: "public",
  summary: "Disable a destination; existing payments keep their snapshot.",
  auth: ["session"],
  roles: ["owner", "admin"],
  stepUp: true,
  idempotent: true,
  params: DestinationIdParams,
  body: inp({}),
  response: SettlementDestination,
  status: 200,
  errors: ["state_conflict"],
  stage: 1,
});

// =============================================================================================
// stage 2 — identity-console: recovery, team & invitations, account switching, restricted keys,
// two-approver rule, audit log (lld/identity.md §5–§6, §12)
// =============================================================================================

export const startRecovery = route({
  id: "startRecovery",
  method: "POST",
  path: "/v1/auth/recovery",
  service: "identity",
  visibility: "public",
  summary: "Start account recovery: email a magic link that adds a new passkey.",
  description:
    "Always `202` (no enumeration): only an address with a user gets a link (15 min, single use, at most 5 per hour). The link goes through `verifyMagicLink` (`purpose: recovery`) and passkey registration; completing it sets the account's `recovered_at`, which blocks destination changes for 48 h (`recovery_lock`), and notifies every owner.",
  auth: ["anonymous"],
  idempotent: false,
  body: inp({
    email: z.email().max(254).describe("Email address of the user who lost their passkeys."),
    turnstile_token: z.string().min(1).max(4096).describe("Cloudflare Turnstile token."),
  }),
  response: null,
  status: 202,
  errors: ["turnstile_failed"],
  stage: 2,
});

export const Member = out({
  object: z.literal("member").describe("Always `member`."),
  user: out({
    id: id("usr"),
    email: z.email().describe("Email of the member."),
  }).describe("The member's user."),
  role: RoleSchema,
  created: UnixTime.describe("When the user joined the account."),
  last_login_at: UnixTime.nullable().describe("Last sign-in of the user."),
  // spec 0.2.1 — dashboard CR (Team page "Security" column)
  security: out({
    passkeys: z.int().min(0).describe("Passkeys registered by the user."),
    recovered_at: UnixTime.nullable().describe(
      "Last email recovery of the user (a new passkey); within 48 h their destination and team changes are locked.",
    ),
  })
    .optional()
    .describe("Sign-in security summary of the member (no credential details). Spec 0.2.1."),
}).meta({ id: "Member", description: "A user's membership in the account (FR-ACC-01)." });

export const Invitation = out({
  id: id("inv"),
  object: z.literal("invitation").describe("Always `invitation`."),
  created: UnixTime,
  email: z.email().describe("Invited address; only a user with this email can accept."),
  role: RoleSchema,
  status: openEnum(["pending", "accepted", "revoked", "expired"], "Invitation status."),
  invited_by: id("usr"),
  expires_at: UnixTime.describe("Expiry (7 days after sending)."),
  accepted_at: UnixTime.nullable().describe("When it was accepted."),
}).meta({ id: "Invitation", description: "An invitation to join the account with a role." });

export const Membership = out({
  object: z.literal("membership").describe("Always `membership`."),
  account: out({
    id: id("acct"),
    display_name: z.string().describe("Account display name."),
  }).describe("Account."),
  role: RoleSchema,
  current: z.boolean().describe("Whether the current session acts for this account."),
}).meta({ id: "Membership", description: "An account the signed-in user belongs to." });

export const AuditEvent = out({
  id: id("aud"),
  object: z.literal("audit_event").describe("Always `audit_event`."),
  created: UnixTime,
  account: id("acct").nullable().describe("Account the action concerns; null for platform actions."),
  actor: out({
    type: openEnum(["user", "api_key", "operator", "service", "system"], "Who acted."),
    id: z.string().describe("`usr_…` (user or operator), `key_…`, a service name or `system`."),
  }).describe("Who performed the action."),
  action: z.string().describe("Action, e.g. `destination.created`, `member.invited`, `api_key.rolled`."),
  target: out({
    type: z.string().describe("Object type."),
    id: z.string().describe("Object id."),
  })
    .nullable()
    .describe("Object acted on."),
  details: z.record(z.string(), z.unknown()).describe("Action details (no secrets, no personal data beyond ids)."),
}).meta({ id: "AuditEvent", description: "An append-only audit record (identity §12)." });

const TEAM_ROLES = ["owner", "admin"] as const;

export const listMembers = route({
  id: "listMembers",
  method: "GET",
  path: "/v1/account/members",
  service: "identity",
  visibility: "public",
  summary: "List the account's members.",
  auth: ["session"],
  roles: TEAM_ROLES,
  idempotent: false,
  query: inp(listQueryShape),
  response: listOf(Member, "MemberList", "A page of members."),
  status: 200,
  errors: [],
  stage: 2,
});

export const updateMember = route({
  id: "updateMember",
  method: "PATCH",
  path: "/v1/account/members/{user}",
  service: "identity",
  visibility: "public",
  summary: "Change a member's role.",
  description:
    "Only owners grant or take away `owner` (`403 permission_denied` for admins). Taking away the last owner is `409 last_owner`.",
  auth: ["session"],
  roles: TEAM_ROLES,
  stepUp: true,
  idempotent: true,
  params: inp({ user: id("usr") }),
  body: inp({ role: RoleSchema }),
  response: Member,
  status: 200,
  errors: ["last_owner", "recovery_lock" /* spec 0.2.1 */],
  stage: 2,
});

export const removeMember = route({
  id: "removeMember",
  method: "DELETE",
  path: "/v1/account/members/{user}",
  service: "identity",
  visibility: "public",
  summary: "Remove a member; their sessions for this account end at once.",
  description: "Only owners remove an owner. Removing the last owner is `409 last_owner`.",
  auth: ["session"],
  roles: TEAM_ROLES,
  stepUp: true,
  idempotent: false,
  params: inp({ user: id("usr") }),
  response: null,
  status: 204,
  errors: ["last_owner", "recovery_lock" /* spec 0.2.1 */],
  stage: 2,
});

export const listInvitations = route({
  id: "listInvitations",
  method: "GET",
  path: "/v1/account/invitations",
  service: "identity",
  visibility: "public",
  summary: "List invitations.",
  auth: ["session"],
  roles: TEAM_ROLES,
  idempotent: false,
  query: inp({
    ...listQueryShape,
    status: openEnum(["pending", "accepted", "revoked", "expired"], "Only invitations with this status.").optional(),
  }),
  response: listOf(Invitation, "InvitationList", "A page of invitations."),
  status: 200,
  errors: [],
  stage: 2,
});

export const createInvitation = route({
  id: "createInvitation",
  method: "POST",
  path: "/v1/account/invitations",
  service: "identity",
  visibility: "public",
  summary: "Invite a user by email; the email carries a single-use link (7 days).",
  description:
    "Only owners invite owners. The link (`<dashboard>/auth/invite#token=…`) goes through `verifyMagicLink` for a new user, or `acceptInvitation` for a signed-in existing user. Emits `evt.identity.member.added` when accepted.",
  auth: ["session"],
  roles: TEAM_ROLES,
  stepUp: true,
  idempotent: true,
  body: inp({
    email: z.email().max(254).describe("Address to invite."),
    role: RoleSchema,
  }),
  response: Invitation,
  status: 201,
  errors: ["member_exists", "recovery_lock" /* spec 0.2.1 */],
  stage: 2,
});

export const revokeInvitation = route({
  id: "revokeInvitation",
  method: "DELETE",
  path: "/v1/account/invitations/{id}",
  service: "identity",
  visibility: "public",
  summary: "Revoke a pending invitation; its link stops working.",
  auth: ["session"],
  roles: TEAM_ROLES,
  idempotent: false,
  params: inp({ id: id("inv") }),
  response: null,
  status: 204,
  errors: ["state_conflict"],
  stage: 2,
});

export const acceptInvitation = route({
  id: "acceptInvitation",
  method: "POST",
  path: "/v1/auth/invitations/accept",
  service: "identity",
  visibility: "public",
  summary: "Accept an invitation as the signed-in user; the session switches to the joined account.",
  description:
    "The invitation's email must equal the user's email. Returns the re-issued session (same cookie, new account and role, step-up cleared).",
  auth: ["session"],
  idempotent: false,
  body: inp({ token: z.string().min(16).max(256).describe("Token from the invitation link.") }),
  response: DashboardSession,
  status: 200,
  errors: ["invitation_invalid"],
  stage: 2,
});

export const listMemberships = route({
  id: "listMemberships",
  method: "GET",
  path: "/v1/auth/accounts",
  service: "identity",
  visibility: "public",
  summary: "Accounts the signed-in user belongs to.",
  auth: ["session"],
  idempotent: false,
  response: out({
    object: z.literal("list").describe("Always `list`."),
    data: z.array(Membership).describe("Memberships, most recently used first."),
  }).meta({ id: "MembershipList", description: "The signed-in user's memberships." }),
  status: 200,
  errors: [],
  stage: 2,
});

export const switchSessionAccount = route({
  id: "switchSessionAccount",
  method: "POST",
  path: "/v1/auth/session/account",
  service: "identity",
  visibility: "public",
  summary: "Make the session act for another account of the user.",
  description:
    "Returns the re-issued session (same cookie, new account and role, step-up cleared). Sign-in picks the most recently used account.",
  auth: ["session"],
  idempotent: false,
  body: inp({ account: id("acct") }),
  response: DashboardSession,
  status: 200,
  errors: [],
  stage: 2,
});

export const updateApiKey = route({
  id: "updateApiKey",
  method: "PATCH",
  path: "/v1/api_keys/{id}",
  service: "identity",
  visibility: "public",
  summary: "Rename a key or change a restricted key's scopes or IP allow-list.",
  description: "`scopes` only on restricted keys (`409 state_conflict` otherwise). Changes apply within 30 s.",
  auth: ["session"],
  roles: KEY_ROLES,
  stepUp: true,
  idempotent: true,
  params: KeyIdParams,
  body: inp({
    name: z.string().min(1).max(64).optional().describe("Label."),
    scopes: RestrictedKeyScopes.optional().describe("New scopes of a restricted key (replaces the list)."),
    ip_allowlist: z
      .array(z.cidrv4().or(z.cidrv6()))
      .max(20)
      .optional()
      .describe("Allowed CIDR ranges (replaces the list; empty = any)."),
  }),
  response: ApiKey,
  status: 200,
  errors: ["scope_unknown", "state_conflict"],
  stage: 2,
});

export const approveSettlementDestination = route({
  id: "approveSettlementDestination",
  method: "POST",
  path: "/v1/settlement_destinations/{id}/approve",
  service: "identity",
  visibility: "public",
  summary: "Approve or reject a destination awaiting approval (two-approver rule).",
  description:
    "When two approvals are required the approver must be an owner/admin other than the creator and other than any earlier approver; identity enforces it server-side on the session's user id (`403 approver_conflict`). Approval starts the 24 h cool-off; `reject` disables the destination. Only `pending_approval` destinations (`409 state_conflict`).",
  auth: ["session"],
  roles: ["owner", "admin"],
  stepUp: true,
  idempotent: true,
  params: DestinationIdParams,
  body: inp({ decision: closedEnum(["approve", "reject"], "Decision.") }),
  response: SettlementDestination,
  status: 200,
  errors: ["approver_conflict", "state_conflict", "recovery_lock" /* spec 0.2.1 */],
  stage: 2,
});

export const listAccountAuditEvents = route({
  id: "listAccountAuditEvents",
  method: "GET",
  path: "/v1/account/audit_events",
  service: "identity",
  visibility: "public",
  summary: "The account's audit log, newest first (audit export).",
  description:
    "Cursor list over the whole retention period; the dashboard's export walks it with `created[…]` filters and writes CSV client-side.",
  auth: ["session"],
  roles: TEAM_ROLES,
  idempotent: false,
  query: inp({
    ...listQueryShape,
    ...createdFilterShape,
    action: z.string().max(100).optional().describe("Only this action."),
    actor: z.string().max(64).optional().describe("Only this actor id."),
  }),
  response: listOf(AuditEvent, "AuditEventList", "A page of audit events."),
  status: 200,
  errors: [],
  stage: 2,
});
