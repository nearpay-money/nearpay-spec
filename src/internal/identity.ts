/** Internal identity API (lld/identity.md §6 internal rows, §8). */
import {
  Account,
  AssetId,
  Bps,
  ChainAddress,
  closedEnum,
  id,
  inp,
  OpsRoleSchema,
  out,
  ROLES,
  route,
  SettlementDestination,
  Timestamp,
  z,
} from "@nearpay-money/spec";

export const RouteClassFeeRule = out({
  total_bps: Bps.describe("All-in fee for this route class."),
  min_fee_usd_micros: z.int().min(0).describe("Minimum absolute fee in USD micros."),
}).describe("Fee rule for one route class.");

export const FeeSchedule = out({
  id: id("fs"),
  name: z.string().describe("Schedule name."),
  rules: out({
    same_asset: RouteClassFeeRule,
    stable_pair: RouteClassFeeRule,
    volatile: RouteClassFeeRule,
    intents_transfer: RouteClassFeeRule,
  }).describe("Fee per route class (rails §8.1)."),
  provider_split: out({
    oneclick: out({
      share_bps: Bps.describe("Provider share of appFees (5000 = 50%)."),
      floor_bps: Bps.describe("Provider minimum."),
      stable_floor_bps: Bps.describe("Provider minimum on stable/same-asset routes."),
    }).describe("1Click split."),
  }).describe("How fees are split with route providers."),
}).meta({ id: "FeeSchedule", description: "A fee schedule (identity owns, rails applies)." });
export type FeeSchedule = z.infer<typeof FeeSchedule>;

/** Destination with the fields services need beyond the public object. */
export const InternalSettlementDestination = SettlementDestination.extend({
  account: id("acct"),
  address_norm: ChainAddress.describe("Normalised address (lower-case for EVM)."),
  attestation_hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .describe("sha256 of the stored attestation (hex); null for unverified/test."),
  per_payment_cap_usd_micros: z.int().min(0).nullable().describe("Cap for unverified destinations, USD micros."),
}).meta({ id: "InternalSettlementDestination", description: "Settlement destination with internal fields." });
export type InternalSettlementDestination = z.infer<typeof InternalSettlementDestination>;

export const SettlementContext = out({
  account: Account,
  fee_schedule: FeeSchedule,
  destinations: z.array(InternalSettlementDestination).describe("Active destinations of this mode."),
  defaults: z
    .record(z.union([z.literal("*"), AssetId]), id("sd"))
    .describe("Default destination per asset; `*` = account default."),
  context_version: Timestamp.describe("max(updated_at) of everything in the context (cache freshness)."),
}).meta({ id: "SettlementContext", description: "Everything payments needs to create a payment (identity §8.3)." });
export type SettlementContext = z.infer<typeof SettlementContext>;

export const authorize = route({
  id: "authorize",
  method: "GET",
  path: "/internal/authz",
  service: "identity",
  visibility: "internal",
  summary: "Traefik ForwardAuth: authenticate, rate-limit, mint the request token.",
  description:
    "Reads Authorization, X-NearPay-Client-Secret, Cookie, X-CSRF-Token, NearPay-Mode and X-Forwarded-Method/Uri/For. 200 sets X-NearPay-Token and X-Request-Id; 401/403/429 bodies are the public error envelope.",
  auth: ["gateway"],
  idempotent: false,
  response: null,
  status: 200,
  responseHeaders: out({
    "x-nearpay-token": z.string().describe("Internal JWT (60 s)."),
    "x-request-id": z.string().describe("Request id."),
  }),
  errors: [],
  stage: 1,
});

export const Jwks = out({
  keys: z
    .array(
      out({
        kty: z.literal("OKP").describe("Key type."),
        crv: z.literal("Ed25519").describe("Curve."),
        x: z.string().describe("Public key, base64url."),
        kid: z.string().describe("Key id."),
        alg: z.literal("EdDSA").describe("Algorithm."),
        use: z.literal("sig").describe("Use."),
      }).describe("A signing key."),
    )
    .describe("Current and next keys."),
}).meta({ id: "Jwks", description: "JSON Web Key Set of internal JWT signing keys." });

export const getJwks = route({
  id: "getJwks",
  method: "GET",
  path: "/internal/jwks",
  service: "identity",
  visibility: "internal",
  summary: "Public keys of internal JWTs (cache 5 min; refetch on unknown kid).",
  auth: ["internal"],
  idempotent: false,
  response: Jwks,
  status: 200,
  errors: [],
  stage: 1,
});

export const mintServiceToken = route({
  id: "mintServiceToken",
  method: "POST",
  path: "/internal/service-tokens",
  service: "identity",
  visibility: "internal",
  summary: "Client-credentials exchange for a 5-minute service token.",
  auth: ["service_client"],
  idempotent: false,
  body: inp({}),
  response: out({
    access_token: z.string().describe("Service JWT."),
    token_type: z.literal("Bearer").describe("Token type."),
    expires_in: z.int().describe("Lifetime, seconds."),
  }).meta({ id: "ServiceToken", description: "A service token." }),
  status: 200,
  errors: ["invalid_client"],
  stage: 1,
});

export const getSettlementContext = route({
  id: "getSettlementContext",
  method: "GET",
  path: "/internal/accounts/{id}/settlement-context",
  service: "identity",
  visibility: "internal",
  summary: "Account, fee schedule and active destinations for one mode.",
  auth: ["service:identity.context.read"],
  idempotent: false,
  params: inp({ id: id("acct") }),
  query: inp({
    livemode: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .describe("Mode."),
  }),
  response: SettlementContext,
  status: 200,
  errors: [],
  stage: 1,
});

export const getInternalSettlementDestination = route({
  id: "getInternalSettlementDestination",
  method: "GET",
  path: "/internal/settlement-destinations/{id}",
  service: "identity",
  visibility: "internal",
  summary: "A destination in any status.",
  auth: ["service:identity.context.read"],
  idempotent: false,
  params: inp({ id: id("sd") }),
  response: InternalSettlementDestination,
  status: 200,
  errors: [],
  stage: 1,
});

export const RecipientKind = closedEnum(["security", "billing", "developer"], "Which users to notify.");

export const getNotificationRecipients = route({
  id: "getNotificationRecipients",
  method: "GET",
  path: "/internal/accounts/{id}/notification-recipients",
  service: "identity",
  visibility: "internal",
  summary: "Email recipients for an account notification (PII; never put in events).",
  description: "security: owners+admins · developer: owners+admins+developers · billing: owners+finance.",
  auth: ["service:identity.recipients.read"],
  idempotent: false,
  params: inp({ id: id("acct") }),
  query: inp({
    kind: RecipientKind,
    // spec 0.2.1 — notify CR
    user: id("usr")
      .optional()
      .describe(
        "Only this user, if they are currently a member of the account in any role (`kind` is then not applied); an empty list otherwise. For mails to the affected user (member added or role changed, account recovery). Spec 0.2.1.",
      ),
  }),
  response: out({
    recipients: z
      .array(
        out({
          user_id: id("usr"),
          email: z.email().describe("Email."),
          role: closedEnum(ROLES, "Role."),
        }).describe("A recipient."),
      )
      .describe("Recipients."),
  }).meta({ id: "NotificationRecipients", description: "Users to notify." }),
  status: 200,
  errors: [],
  stage: 1,
});

// spec 0.2.1 — compliance CR: server-side "active operator" check for case assignment
export const InternalOpsOperator = out({
  user_id: id("usr"),
  role: OpsRoleSchema,
  active: z.boolean().describe("The operator may sign in to the console (not revoked)."),
  created_at: Timestamp.describe("When the operator was added."),
  revoked_at: Timestamp.nullable().describe("When console access was revoked, if it was."),
}).meta({ id: "InternalOpsOperator", description: "A console operator (`ops_operators` row); ids only, no email." });

export const getInternalOpsOperator = route({
  id: "getInternalOpsOperator",
  method: "GET",
  path: "/internal/ops_operators/{id}",
  service: "identity",
  visibility: "internal",
  summary: "A console operator by user id (compliance checks a case assignee is active).",
  description:
    "A user who never was an operator is `404 resource_missing`; a revoked operator answers with `active: false`. Compliance calls it in `assignOpsCase` before assigning (spec 0.2.1).",
  auth: ["service:identity.operators.read"],
  idempotent: false,
  params: inp({ id: id("usr") }),
  response: InternalOpsOperator,
  status: 200,
  errors: [],
  stage: 2,
});
