/**
 * Internal APIs of payments, agentpay, compliance, sentinel and notify (Stage 1 subset):
 * payments §6.3, agentpay §5, compliance §5, sentinel §6, notify §5.
 */
import {
  AttestationTicket,
  Binding,
  ChainAddress,
  ChainId,
  CountryCode,
  closedEnum,
  IntentsRequirement,
  id,
  inp,
  KybStatus,
  MultiPayload,
  NearAccountId,
  openEnum,
  out,
  PaymentIntent,
  PricingAmount,
  PricingCurrency,
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

// =============================================================================================
// agentpay
// =============================================================================================

export const relaySignedIntent = route({
  id: "relaySignedIntent",
  method: "POST",
  path: "/internal/relay",
  service: "agentpay",
  visibility: "internal",
  summary: "Queue a payer-signed payload for a checkout `intents_transfer` attempt.",
  auth: ["service:agentpay.relay"],
  idempotent: true,
  body: inp({ execution_id: id("ex"), binding: Binding, signed: MultiPayload }),
  response: out({ agent_payment_id: id("ap") }).meta({ id: "RelayAccepted", description: "Queued for relay." }),
  status: 202,
  errors: ["intent_invalid", "insufficient_balance", "rail_unavailable"],
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
  }),
  response: out({
    screening_id: id("scr"),
    decision: ScreeningDecision,
    risk: z.string().nullable().describe("Vendor risk level."),
    reasons: z.array(z.string()).describe("Reasons (`sanctions`, `blocklist`, `vendor_unavailable`, …)."),
    cached: z.boolean().describe("Served from cache."),
    post_screen_required: z.boolean().describe("Screen again after settlement (vendor was unavailable)."),
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
  summary: "Manual KYB decision (ops CLI in Stage 1, console in Stage 2).",
  auth: ["ops:compliance.kyb.decide"],
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

// =============================================================================================
// sentinel
// =============================================================================================

export const KillSwitchState = out({
  engaged: z.boolean().describe("Live quoting is stopped."),
  reason: z.string().describe("Reason."),
  actor: z.string().describe("Who changed it (`sentinel` or an ops principal)."),
  updated_at: Timestamp.describe("When."),
}).meta({ id: "KillSwitchState", description: "Global quoting kill switch." });

export const setKillSwitch = route({
  id: "setKillSwitch",
  method: "POST",
  path: "/internal/kill-switch",
  service: "sentinel",
  visibility: "internal",
  summary: "Engage or release the global quoting kill switch.",
  auth: ["ops:sentinel.killswitch"],
  idempotent: true,
  body: inp({
    engaged: z.boolean().describe("Engage or release."),
    reason: z.string().min(1).max(500).describe("Reason."),
  }),
  response: KillSwitchState,
  status: 200,
  errors: [],
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

export const sendMessage = route({
  id: "sendMessage",
  method: "POST",
  path: "/internal/messages",
  service: "notify",
  visibility: "internal",
  summary: "Queue a transactional email.",
  auth: ["service:notify.send"],
  idempotent: false,
  body: z.discriminatedUnion("template", [MagicLinkMessage]).describe("Message to send."),
  response: out({ message_id: id("msg") }).meta({ id: "MessageQueued", description: "Queued message." }),
  status: 202,
  errors: [],
  stage: 1,
});
