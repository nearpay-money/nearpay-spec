/**
 * Internal APIs of payments, agentpay, compliance, sentinel and notify (Stage 1 subset):
 * payments §6.3, agentpay §5, compliance §5, sentinel §6, notify §5.
 */
import {
  AttestationTicket,
  Binding,
  ChainAddress,
  ChainId,
  ClientSecretHeaders,
  CountryCode,
  closedEnum,
  IntentsRequirement,
  id,
  inp,
  KybProfile,
  KybStatus,
  MultiPayload,
  NearAccountId,
  OPS_ROLES,
  openEnum,
  out,
  PaymentIntent,
  PricingAmount,
  PricingCurrency,
  PublicCheckoutSession,
  ROLES,
  route,
  SettlementValue,
  Timestamp,
  Url,
  z,
} from "@nearpay/spec";

// =============================================================================================
// payments
// =============================================================================================

export const createAgentAttempt = route({
  id: "createAgentAttempt",
  method: "POST",
  path: "/internal/checkout_sessions/{id}/agent_attempts",
  service: "payments",
  visibility: "internal",
  summary: "Create (or reuse) an `intents_transfer` attempt for an agent payer.",
  description: "Same guards as payer attempts (§8.2); limits apply per session.",
  auth: ["service:payments.attempts.create"],
  idempotent: false,
  params: inp({ id: id("cs") }),
  body: inp({ payer_wallet: NearAccountId.describe("Agent's Intents account.") }),
  response: out({
    attempt_id: id("pa"),
    execution_id: id("ex"),
    account_id: id("acct"),
    livemode: z.boolean().describe("Mode."),
    intents_requirement: IntentsRequirement,
    attestation_ticket: AttestationTicket,
  }).meta({ id: "AgentAttempt", description: "An agent's attempt and what to sign." }),
  status: 200,
  errors: [
    "session_not_open",
    "too_many_attempts",
    "attempt_in_flight",
    "destination_not_intents_account",
    "rail_unavailable",
  ],
  stage: 1,
});

export const getInternalPaymentIntent = route({
  id: "getInternalPaymentIntent",
  method: "GET",
  path: "/internal/payment_intents/{id}",
  service: "payments",
  visibility: "internal",
  summary: "Full payment intent.",
  auth: ["service:payments.read", "ops:payments.read"],
  idempotent: false,
  params: inp({ id: id("pi") }),
  response: PaymentIntent,
  status: 200,
  errors: [],
  stage: 1,
});

export const getReceiptContext = route({
  id: "getReceiptContext",
  method: "GET",
  path: "/internal/payment_intents/{id}/receipt-context",
  service: "payments",
  visibility: "internal",
  summary: "Data for the payment receipt email (PII; never in events).",
  auth: ["service:payments.receipts.read"],
  idempotent: false,
  params: inp({ id: id("pi") }),
  response: out({
    customer_email: z.email().nullable().describe("Receipt recipient, if the session collected one."),
    merchant_display_name: z.string().describe("Merchant name."),
    amount: PricingAmount,
    currency: PricingCurrency,
    settled: SettlementValue,
    evidence_links: z.array(z.url()).describe("Explorer links of the settlement."),
    email_receipts: z.boolean().describe("Account setting: send receipts."),
  }).meta({ id: "ReceiptContext", description: "Receipt data." }),
  status: 200,
  errors: [],
  stage: 1,
});

// stage 2 — rails-fx (CR-15-15)
export const PayerSessionContext = out({
  account_id: id("acct"),
  livemode: z.boolean().describe("Mode of the session."),
  session: PublicCheckoutSession,
}).meta({
  id: "PayerSessionContext",
  description: "A checkout session as the payer sees it, plus its account and mode (agentpay's checkout routes).",
});

export const getPayerCheckoutSession = route({
  id: "getPayerCheckoutSession",
  method: "GET",
  path: "/internal/checkout_sessions/{id}/payer",
  service: "payments",
  visibility: "internal",
  summary: "Verify a payer's client secret and read the session as the payer sees it (agentpay `agent_pay`).",
  description:
    "Replaces agentpay's call to the public `GET /v1/checkout/sessions/{id}/public` (CR-15-15): agentpay forwards the caller's `X-NearPay-Client-Secret` and authenticates with its service token. A wrong secret answers `client_secret_invalid`, exactly like the public route.",
  auth: ["service:payments.read"],
  idempotent: false,
  params: inp({ id: id("cs") }),
  headers: ClientSecretHeaders,
  response: PayerSessionContext,
  status: 200,
  errors: ["client_secret_invalid"],
  stage: 2,
});
// end stage 2 — rails-fx

// =============================================================================================
// agentpay
// =============================================================================================

export const relaySignedIntent = route({
  id: "relaySignedIntent",
  method: "POST",
  path: "/internal/relay",
  service: "agentpay",
  visibility: "internal",
  summary:
    "Queue an owner-signed payload: a checkout `intents_transfer` attempt, or a refund leg from an Intents account.",
  description:
    "Checkout (`kind` absent or `checkout`): the execution is a `payment` `intents_transfer` in `awaiting_deposit` and the payload holds exactly the two requirement transfers. Refund (`kind: refund`, Stage 2): the execution is a `refund` execution whose `refund.transfer` is set, still awaiting its deposit; the payload is signed by `refund.transfer.signer_id` (the merchant) and holds exactly that one transfer (receiver, token, amount, memo = binding) with a deadline ≤ `refund.transfer.deadline`. Account and mode come from the execution; the payload is relayed exactly as signed (INV-1). Every error answer is a refusal **before anything is queued or published** (no agent payment, nothing relayed), so the caller may treat the payload as unsent; a timeout or `5xx` is an unknown outcome (the payload may be queued — retry the same payload, which is idempotent on its hash) (spec 0.2.1).",
  auth: ["service:agentpay.relay"],
  idempotent: true,
  body: inp({
    execution_id: id("ex"),
    binding: Binding,
    signed: MultiPayload,
    // stage 2 — payments
    kind: closedEnum(
      ["checkout", "refund"],
      "What the payload pays (default `checkout`); must match the execution kind.",
    ).optional(),
    refund: id("re").optional().describe("Refund the leg belongs to (`kind: refund`; recorded on the agent payment)."),
  }),
  response: out({ agent_payment_id: id("ap") }).meta({ id: "RelayAccepted", description: "Queued for relay." }),
  status: 202,
  errors: [
    "intent_invalid",
    "insufficient_balance",
    "rail_unavailable",
    // spec 0.2.1 — CR-22-AP-01: a refund payload that is not exactly the issued `next_action`
    "signed_intent_mismatch",
  ],
  stage: 1,
});

// =============================================================================================
// compliance
// =============================================================================================

export const ScreeningDecision = openEnum(["allow", "block", "review"], "Screening decision.");

export const createScreening = route({
  id: "createScreening",
  method: "POST",
  path: "/internal/screenings",
  service: "compliance",
  visibility: "internal",
  summary: "Screen an address, NEAR account or destination (compliance §4).",
  auth: ["service:compliance.screen"],
  idempotent: false,
  body: inp({
    subject_type: closedEnum(["address", "near_account", "destination"], "What is screened."),
    chain: ChainId.optional().describe("Chain of an address."),
    subject: ChainAddress.describe("Address or account."),
    context: openEnum(["payment", "refund", "destination", "x402", "agent"], "Why it is screened."),
    account_id: id("acct").optional().describe("Merchant account."),
    livemode: z.boolean().describe("Mode (test mode uses magic addresses)."),
    amount_usd_micros: z.int().min(0).optional().describe("Payment size for the fail-closed threshold."),
    // spec 0.2.1 — CR-22-RL-01
    fresh: z
      .boolean()
      .optional()
      .describe(
        "Bypass the screening cache and decide now (rails sends it for an owner-overridden refund recipient, `CreateRefundExecution.screen`). Default false (spec 0.2.1).",
      ),
  }),
  response: out({
    screening_id: id("scr"),
    decision: ScreeningDecision,
    risk: z.string().nullable().describe("Provider risk level; null for the v1 `local` provider (list hits only)."),
    reasons: z.array(z.string()).describe("Reasons (`sanctions`, `blocklist`, `vendor_unavailable`, …)."),
    cached: z.boolean().describe("Served from cache."),
    post_screen_required: z.boolean().describe("Screen again after settlement (vendor was unavailable)."),
    // stage 2 — identity-console: vendor-neutral screening interface (ADR-0020)
    provider: openEnum(["local", "sandbox"], "Screening provider behind the vendor-neutral interface.")
      .optional()
      .describe(
        "Which provider decided: `local` (OFAC digital-currency list + NearPay blocklist; the only live provider in v1) or `sandbox` (test-mode magic rule). Absent from Stage 1 servers.",
      ),
  }).meta({ id: "Screening", description: "A screening decision." }),
  status: 200,
  errors: ["screening_unavailable"],
  stage: 1,
});

export const GeoPolicy = out({
  blocked_countries: z.array(CountryCode).describe("Blocked countries."),
  blocked_regions: z.array(z.string()).describe("Blocked ISO 3166-2 regions."),
  version: z.string().describe("Policy version."),
}).meta({ id: "GeoPolicy", description: "Payer geo policy." });

export const getGeoPolicy = route({
  id: "getGeoPolicy",
  method: "GET",
  path: "/internal/geo-policy",
  service: "compliance",
  visibility: "internal",
  summary: "Current geo policy (cache; refresh on `evt.compliance.policy.updated`).",
  auth: ["service:compliance.read"],
  idempotent: false,
  response: GeoPolicy,
  status: 200,
  errors: [],
  stage: 1,
});

export const decideKyb = route({
  id: "decideKyb",
  method: "POST",
  path: "/internal/kyb_cases/{id}/decision",
  service: "compliance",
  visibility: "internal",
  summary: "Manual KYB decision (in-container ops CLI; the console uses `decideOpsKybCase`).",
  auth: ["ops:compliance.kyb.decide"],
  // stage 2 — identity-console
  opsRoles: ["ops", "ops_admin"],
  idempotent: true,
  params: inp({ id: id("acct") }),
  body: inp({
    decision: closedEnum(["approved", "rejected", "needs_info"], "Decision."),
    reason: z.string().min(1).max(500).describe("Reason (audited)."),
  }),
  response: out({
    account_id: id("acct"),
    status: KybStatus,
    decided_at: Timestamp.describe("Decision time."),
  }).meta({ id: "KybDecision", description: "Recorded KYB decision." }),
  status: 200,
  errors: ["state_conflict"],
  stage: 1,
});

// stage 2 — identity-console: identity reads the approved details on `evt.compliance.kyb.approved`
// (legal name and country stay off the bus: a sole proprietor's legal name is personal data)
export const InternalKybCase = out({
  account_id: id("acct"),
  status: KybStatus,
  profile: KybProfile,
  decided_at: Timestamp.nullable().describe("Last decision."),
}).meta({ id: "InternalKybCase", description: "A KYB case with its declared details (identity reads it)." });

export const getInternalKybCase = route({
  id: "getInternalKybCase",
  method: "GET",
  path: "/internal/kyb_cases/{id}",
  service: "compliance",
  visibility: "internal",
  summary: "An account's KYB case with the declared details.",
  description:
    "Identity calls it when it consumes `evt.compliance.kyb.approved` and copies `profile.legal_name` / `profile.country_of_incorporation` into `verified_legal_name` / `country`.",
  auth: ["service:compliance.read"],
  idempotent: false,
  params: inp({ id: id("acct") }),
  response: InternalKybCase,
  status: 200,
  errors: [],
  stage: 2,
});

// =============================================================================================
// sentinel
// =============================================================================================

export const KillSwitchState = out({
  engaged: z.boolean().describe("Live quoting is stopped."),
  reason: z.string().describe("Reason."),
  actor: z.string().describe("Who changed it (`sentinel` or an ops principal)."),
  updated_at: Timestamp.describe("When."),
  // spec 0.2.1
  version: z
    .int()
    .min(0)
    .optional()
    .describe(
      "Version of the switch row: equals the envelope `aggregate.version` of the latest `evt.sentinel.kill_switch.*`, so a reader applies later events only (spec 0.2.1; sentinel 0.2.1+ sends it).",
    ),
}).meta({ id: "KillSwitchState", description: "Global quoting kill switch." });

// spec 0.2.1 — services read the switch at boot (payments/rails/agentpay fail closed until known)
export const getKillSwitch = route({
  id: "getKillSwitch",
  method: "GET",
  path: "/internal/kill-switch",
  service: "sentinel",
  visibility: "internal",
  summary: "Current kill-switch state (services read it at boot and when their stored state is unknown).",
  description:
    "For consumers of `evt.sentinel.kill_switch.*` whose local state is unknown (fresh database, or the last event aged out of the stream before their durable consumer existed): payments, rails and agentpay read it at boot and store it with `version`, then apply only events with a higher `aggregate.version`. Until either the read or an event succeeds the state stays unknown and live refunds/relays fail closed. Never cached by sentinel; ops use `getOpsKillSwitch`.",
  auth: ["service:sentinel.read"],
  idempotent: false,
  response: KillSwitchState,
  status: 200,
  errors: [],
  stage: 2,
});

export const setKillSwitch = route({
  id: "setKillSwitch",
  method: "POST",
  path: "/internal/kill-switch",
  service: "sentinel",
  visibility: "internal",
  summary: "Engage or release the global quoting kill switch.",
  description:
    "In-container ops CLI path. From Stage 2 a release (`engaged: false`) here is single-person, so it is refused with `409 two_person_required` when `NP_ENV=server`; the console's two-person release (`requestOpsKillSwitchRelease` + `approveOpsKillSwitchRelease`) is the only release there. Local and test stacks keep the one-operator release (testbed T7).",
  auth: ["ops:sentinel.killswitch"],
  // stage 2 — identity-console
  opsRoles: ["ops", "ops_admin"],
  idempotent: true,
  body: inp({
    engaged: z.boolean().describe("Engage or release."),
    reason: z.string().min(1).max(500).describe("Reason."),
  }),
  response: KillSwitchState,
  status: 200,
  errors: ["two_person_required"],
  stage: 1,
});

// =============================================================================================
// notify
// =============================================================================================

/** Templates callable through the API; event-driven templates are rendered by notify itself. */
export const MagicLinkMessage = inp({
  template: z.literal("auth.magic_link").describe("Login / sign-up link."),
  to: z.email().describe("Recipient."),
  variables: inp({
    link_url: Url.describe("Magic link."),
    purpose: closedEnum(["signup", "recovery", "invite"], "Why the link was sent."),
    expires_in_minutes: z.int().min(1).max(1440).describe("Validity."),
  }).describe("Template variables."),
  locale: z.string().max(16).optional().describe("Locale (default `en`)."),
  dedupe_key: z.string().min(1).max(200).describe("Stable key; repeated sends are deduplicated."),
});

// stage 2 — identity-console: invitation and operator-enrolment mails (identity calls them; the
// links carry single-use tokens, so they never travel in events)
export const TeamInvitationMessage = inp({
  template: z.literal("team.invitation").describe("Invitation to join a merchant account."),
  to: z.email().describe("Invited address."),
  variables: inp({
    link_url: Url.describe("Invitation link (`<dashboard>/auth/invite#token=…`)."),
    account_display_name: z.string().min(1).max(100).describe("Account the invitation joins."),
    role: closedEnum(ROLES, "Role offered."),
    expires_in_minutes: z.int().min(1).max(10_080).describe("Validity (7 days)."),
  }).describe("Template variables (the inviter is named only by the account, never by email)."),
  locale: z.string().max(16).optional().describe("Locale (default `en`)."),
  dedupe_key: z.string().min(1).max(200).describe("Stable key (the invitation id); repeats are deduplicated."),
});

export const OpsEnrolmentMessage = inp({
  template: z.literal("ops.enrolment").describe("Console operator enrolment link."),
  to: z.email().describe("Operator address."),
  variables: inp({
    link_url: Url.describe("Enrolment link (`<console>/auth/enrol#token=…`)."),
    role: closedEnum(OPS_ROLES, "Operator role granted."),
    expires_in_minutes: z.int().min(1).max(1440).describe("Validity (24 h)."),
  }).describe("Template variables."),
  locale: z.string().max(16).optional().describe("Locale (default `en`)."),
  dedupe_key: z.string().min(1).max(200).describe("Stable key; repeats are deduplicated."),
});

export const sendMessage = route({
  id: "sendMessage",
  method: "POST",
  path: "/internal/messages",
  service: "notify",
  visibility: "internal",
  summary: "Queue a transactional email.",
  auth: ["service:notify.send"],
  idempotent: false,
  body: z
    .discriminatedUnion("template", [MagicLinkMessage, TeamInvitationMessage, OpsEnrolmentMessage])
    .describe("Message to send."),
  response: out({ message_id: id("msg") }).meta({ id: "MessageQueued", description: "Queued message." }),
  status: 202,
  errors: [],
  stage: 1,
});
