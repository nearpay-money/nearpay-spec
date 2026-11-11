/**
 * Public payments API for merchants (lld/payments.md §6.1): checkout sessions and payment intents,
 * and the statement (balance transactions). Stage 2 adds `createPaymentIntent`, list filters
 * (ADR-0018) and review decisions here; refunds, payment links and customers have their own modules.
 */
import { Evidence } from "../common/evidence.js";
import { id } from "../common/ids.js";
import { createdFilterShape, listOf, listQueryShape, withMetadataFilter } from "../common/pagination.js";
import {
  AssetId,
  BaseUnits,
  Bps,
  ChainAddress,
  ChainId,
  Currency,
  FiatAmount,
  Livemode,
  Metadata,
  SettlementValue,
  UnixTime,
  Url,
} from "../common/primitives.js";
import { route } from "../common/route.js";
import { closedEnum, inp, openEnum, out, z } from "../common/schema.js";
import { SettlementDestinationType } from "./identity.js";

// =============================================================================================
// Shared pieces
// =============================================================================================

/** `currency`: ISO 4217 code (fiat pricing) or `asset` (priced in an asset). */
export const PricingCurrency = z
  .union([Currency, z.literal("asset")])
  .describe("ISO 4217 code for fiat pricing, or `asset` when priced in an asset (then `asset_id` is set).");

/** Amount: integer minor units for fiat, base-unit string for assets (api-conventions §3). */
export const PricingAmount = z
  .union([FiatAmount, BaseUnits])
  .describe("Fiat: integer minor units. Asset: base units as a decimal string.");

const pricingInputShape = {
  amount: PricingAmount,
  currency: PricingCurrency,
  asset_id: AssetId.optional().describe("Pricing asset; required when `currency` is `asset`."),
};

/** Validates the fiat/asset pricing combination. */
export function refinePricing(
  v: { amount: number | string; currency: string; asset_id?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (v.currency === "asset") {
    if (v.asset_id === undefined)
      ctx.addIssue({ code: "custom", path: ["asset_id"], message: "required when currency is asset" });
    if (typeof v.amount !== "string")
      ctx.addIssue({ code: "custom", path: ["amount"], message: "must be a base-unit string when currency is asset" });
  } else {
    if (v.asset_id !== undefined)
      ctx.addIssue({ code: "custom", path: ["asset_id"], message: "only allowed when currency is asset" });
    if (typeof v.amount !== "number")
      ctx.addIssue({ code: "custom", path: ["amount"], message: "must be an integer in minor units for fiat" });
  }
}

export const FeeSummary = out({
  bearer: closedEnum(["payer", "merchant"], "Who bears the fee."),
  total_bps: Bps.describe("NearPay fee applied to this payment's route, in basis points."),
}).meta({ id: "FeeSummary", description: "Fee snapshot of a payment (INV-6)." });

export const DestinationSnapshot = out({
  settlement_destination: id("sd"),
  asset_id: AssetId.describe("Settlement asset."),
  type: SettlementDestinationType,
  chain: ChainId.describe("Settlement chain."),
  address: ChainAddress.describe("Settlement address or Intents account."),
  fingerprint: z
    .string()
    .regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{2}$/)
    .nullable()
    .optional()
    .describe(
      "Fingerprint of the destination as shown at checkout (CR-15-04, spec 0.2.0); optional so older servers stay valid.",
    ),
}).meta({ id: "DestinationSnapshot", description: "Settlement destination as snapshotted at creation (INV-6)." });

export const AttemptStatus = openEnum(
  [
    "quoting",
    "awaiting_deposit",
    "deposit_detected",
    "incomplete_deposit",
    "settling",
    "verifying",
    "succeeded",
    "refunded",
    "failed",
    "expired_unpaid",
    "held",
  ],
  "Attempt status (mirrors the rails execution, domain-model §4.3).",
);

export const AttemptMethod = closedEnum(
  ["route_quote", "intents_transfer"],
  "`route_quote`: deposit to a 1Click address from any chain. `intents_transfer`: signed transfer from a NEAR Intents balance.",
);

export const PaymentAttemptSummary = out({
  id: id("pa"),
  object: z.literal("payment_attempt").describe("Always `payment_attempt`."),
  created: UnixTime,
  status: AttemptStatus,
  method: AttemptMethod,
  origin_asset_id: AssetId.describe("Asset the payer pays with."),
  origin_chain: ChainId.describe("Chain the payer pays from."),
  settlement_amount: BaseUnits.nullable().describe("Expected settlement including the amount tag, base units."),
  settled_amount: BaseUnits.nullable().describe("Amount that settled, base units."),
  deadline: UnixTime.nullable().describe("Deposit deadline."),
  is_overpayment: z.boolean().describe("Settled after another attempt already paid the intent."),
  failure_code: z.string().nullable().describe("Why the attempt failed, refunded or was held."),
  evidence: Evidence.nullable().describe("Settlement evidence, once verified."),
  // spec 0.2.1 — dashboard CRs (payment detail: payer address and amount sent)
  refund_to: ChainAddress.nullable()
    .optional()
    .describe(
      "The payer's own address as given at checkout, where refunds go (INV-7): the refund address on the origin chain (`route_quote`; the connected wallet or a typed address, which may differ from the wallet that sent the deposit) or the payer's Intents account (`intents_transfer`). Spec 0.2.1.",
    ),
  origin_amount: BaseUnits.nullable()
    .optional()
    .describe(
      "What the payer actually sent, base units of `origin_asset_id` (rails `deposited_amount`); null until a deposit is detected. Spec 0.2.1.",
    ),
}).meta({ id: "PaymentAttemptSummary", description: "One payment attempt of an intent, as merchants see it." });

export const IntentStatus = openEnum(
  ["requires_payment", "processing", "requires_review", "succeeded", "canceled", "expired"],
  "Payment intent status (domain-model §4.2).",
);

export const PaymentIntent = out({
  id: id("pi"),
  object: z.literal("payment_intent").describe("Always `payment_intent`."),
  created: UnixTime,
  livemode: Livemode,
  status: IntentStatus,
  amount: PricingAmount,
  currency: PricingCurrency,
  asset_id: AssetId.nullable().describe("Pricing asset when `currency` is `asset`."),
  description: z.string().nullable().describe("Description shown to the payer."),
  source: openEnum(["checkout", "invoice", "payment_link", "api"], "What created the intent."),
  checkout_session: id("cs").nullable().describe("Checkout session that owns the intent."),
  destination: DestinationSnapshot,
  fee: FeeSummary,
  settlement_asset_id: AssetId.describe("Asset the merchant receives."),
  amount_settled: BaseUnits.describe("Settled amount, base units of the settlement asset."),
  amount_refunded: BaseUnits.describe("Refunded amount, base units of the settlement asset."),
  succeeded_at: UnixTime.nullable().describe("When the intent succeeded."),
  late: z.boolean().describe("Settled after its checkout session expired (INV-3)."),
  canceled_at: UnixTime.nullable().describe("When the intent was canceled."),
  cancellation_reason: z.string().nullable().describe("Reason given on cancel."),
  review_reason: openEnum(["short_settlement", "verification_held"], "Why the intent needs review.").nullable(),
  attempts: z.array(PaymentAttemptSummary).describe("Attempts, newest first."),
  overpayments: z
    .array(
      out({
        attempt: id("pa"),
        amount: BaseUnits.describe("Extra amount that settled, base units."),
        reason: openEnum(["duplicate", "after_cancel", "after_expiry"], "Why it counts as an overpayment."),
      }).describe("An extra settlement."),
    )
    .describe("Settlements beyond the one that paid the intent (refund recommended)."),
  sequence: z.int().min(0).describe("Increases with every change; discard webhook objects with a lower sequence."),
  metadata: Metadata,
  // stage 2 — payments (optional in 0.1.x so earlier readers and producers stay compatible; servers MUST send them)
  customer: id("cus").nullable().optional().describe("Customer the intent belongs to (Stage 2)."),
  payment_link: id("plink")
    .nullable()
    .optional()
    .describe("Payment link that created the intent (`source: payment_link`)."),
  amount_refund_pending: BaseUnits.optional().describe(
    "Amount of refunds in `requires_action` or `pending`, base units of the settlement asset (Stage 2).",
  ),
  refunds: z.array(id("re")).optional().describe("Refunds of this intent, newest first (Stage 2)."),
  review_decision: out({
    decision: closedEnum(["accept", "reject"], "Merchant decision."),
    decided_at: UnixTime.describe("When the decision was recorded."),
    refund: id("re").nullable().describe("Refund created by a `reject` of a settled amount (draft, merchant signs)."),
  })
    .nullable()
    .optional()
    .describe("Merchant decision on a `requires_review` intent (Stage 2)."),
  // stage 3 — billing
  invoice: id("in")
    .nullable()
    .optional()
    .describe("Invoice the intent pays (`source: invoice`, Stage 3); null otherwise. Servers from 0.3.0 send it."),
}).meta({ id: "PaymentIntent", description: "One payment the merchant expects (FR-PAY-01)." });
export type PaymentIntent = z.infer<typeof PaymentIntent>;

export const CheckoutSessionStatus = openEnum(
  ["open", "expiring", "complete", "expired"],
  "Session status; `expiring` means past `expires_at` with money possibly in flight (INV-3).",
);

export const UiMode = closedEnum(["hosted", "embedded"], "Hosted page or embedded iframe.");

export const CheckoutSession = out({
  id: id("cs"),
  object: z.literal("checkout_session").describe("Always `checkout_session`."),
  created: UnixTime,
  livemode: Livemode,
  status: CheckoutSessionStatus,
  url: Url.nullable().describe("Checkout URL including the client secret; returned only when the session is created."),
  client_secret: z
    .string()
    .regex(/^cs_[0-9a-z]{26}_secret_[0-9A-Za-z]{32}$/)
    .nullable()
    .describe("Secret for the payer-facing API; returned only when the session is created."),
  expires_at: UnixTime.describe("When the session stops accepting new payments."),
  payment_intent: z
    .union([id("pi"), PaymentIntent])
    .describe("Payment intent id, or the object with `expand[]=payment_intent`."),
  amount: PricingAmount,
  currency: PricingCurrency,
  asset_id: AssetId.nullable().describe("Pricing asset when `currency` is `asset`."),
  settlement_destination: id("sd"),
  ui_mode: UiMode,
  success_url: Url.describe("Where the payer goes after paying (`?session_id=` is appended)."),
  cancel_url: Url.nullable().describe("Where the payer goes on cancel."),
  description: z.string().nullable().describe("Description shown to the payer."),
  allowed_origins: z.array(z.string()).describe("Origins that may embed the session (embedded mode)."),
  late_payments: z.boolean().describe("Accept settlements after expiry."),
  locale: z.string().nullable().describe("Checkout locale."),
  completed_at: UnixTime.nullable().describe("When the session completed."),
  late: z.boolean().describe("Completed by a settlement after expiry."),
  sequence: z
    .int()
    .min(0)
    .optional()
    .describe(
      "Increases with every change; discard webhook objects with a lower sequence. Servers MUST send it (optional in the 0.1.x schema only so readers built on 0.1.4 stay compatible).",
    ),
  metadata: Metadata,
  // stage 2 — payments
  customer: id("cus").nullable().optional().describe("Customer attached to the session (Stage 2)."),
  payment_link: id("plink").nullable().optional().describe("Payment link that opened the session (Stage 2)."),
  // stage 3 — billing
  invoice: id("in")
    .nullable()
    .optional()
    .describe("Invoice the session pays (opened by the hosted invoice page, Stage 3); null otherwise."),
}).meta({ id: "CheckoutSession", description: "A checkout page or embed for one payment intent." });
export type CheckoutSession = z.infer<typeof CheckoutSession>;

// =============================================================================================
// Routes
// =============================================================================================

const SessionIdParams = inp({ id: id("cs") });
const IntentIdParams = inp({ id: id("pi") });

const Origin = z
  .string()
  .regex(/^(https:\/\/[^/\s]+|http:\/\/localhost(:\d{1,5})?)$/)
  .describe("Origin `https://host[:port]` (`http://localhost:*` allowed in test mode).");

export const CheckoutSessionCreate = inp({
  ...pricingInputShape,
  settlement_destination: id("sd")
    .optional()
    .describe("Destination to settle to; default: the asset or account default."),
  success_url: Url.describe("Redirect after payment."),
  cancel_url: Url.optional().describe("Redirect on cancel."),
  expires_in: z
    .int()
    .min(300)
    .max(86_400)
    .optional()
    .describe("Lifetime in seconds (default from account settings, 3600)."),
  ui_mode: UiMode.default("hosted"),
  customer: id("cus")
    .optional()
    .describe("Customer to attach (Stage 2); its email is the receipt address unless `customer_email` is given."),
  customer_email: z.email().max(254).optional().describe("Payer email for the receipt (never in events)."),
  description: z.string().max(500).optional().describe("Shown to the payer."),
  allowed_origins: z.array(Origin).max(10).optional().describe("Required for `embedded`."),
  late_payments: z.boolean().optional().describe("Override the account setting."),
  locale: z.string().max(16).optional().describe("Checkout locale (BCP 47)."),
  metadata: Metadata.optional(),
})
  .superRefine(refinePricing)
  .meta({ id: "CheckoutSessionCreate", description: "Parameters to create a checkout session." });

export const createCheckoutSession = route({
  id: "createCheckoutSession",
  method: "POST",
  path: "/v1/checkout/sessions",
  service: "payments",
  visibility: "public",
  summary: "Create a checkout session.",
  auth: ["secret_key", "restricted_key:checkout_sessions.write"],
  idempotent: true,
  body: CheckoutSessionCreate,
  response: CheckoutSession,
  status: 201,
  errors: [
    "account_not_live",
    "destination_not_active",
    "amount_below_destination_minimum",
    "amount_above_unverified_cap",
    "currency_unsupported",
    "allowed_origins_required",
    // spec 0.3.1 — fiat-priced session without a usable FX rate
    "fx_rate_unavailable",
  ],
  stage: 1,
});

const Expand = z
  .array(z.literal("payment_intent").describe("Expand the payment intent."))
  .optional()
  .describe("Objects to expand (`expand[]=payment_intent`).");

export const getCheckoutSession = route({
  id: "getCheckoutSession",
  method: "GET",
  path: "/v1/checkout/sessions/{id}",
  service: "payments",
  visibility: "public",
  summary: "Retrieve a checkout session.",
  auth: ["secret_key", "restricted_key:checkout_sessions.read", "session"],
  idempotent: false,
  params: SessionIdParams,
  query: inp({ expand: Expand }),
  response: CheckoutSession,
  status: 200,
  errors: [],
  stage: 1,
});

export const listCheckoutSessions = route({
  id: "listCheckoutSessions",
  method: "GET",
  path: "/v1/checkout/sessions",
  service: "payments",
  visibility: "public",
  summary: "List checkout sessions.",
  auth: ["secret_key", "restricted_key:checkout_sessions.read", "session"],
  idempotent: false,
  query: inp({
    ...listQueryShape,
    ...createdFilterShape,
    status: CheckoutSessionStatus.optional(),
    payment_intent: id("pi").optional().describe("Only the session of this intent."),
    expand: Expand,
  }),
  response: listOf(CheckoutSession, "CheckoutSessionList", "A page of checkout sessions."),
  status: 200,
  errors: [],
  stage: 1,
});

export const expireCheckoutSession = route({
  id: "expireCheckoutSession",
  method: "POST",
  path: "/v1/checkout/sessions/{id}/expire",
  service: "payments",
  visibility: "public",
  summary: "Expire an open session (no new payments).",
  auth: ["secret_key", "restricted_key:checkout_sessions.write"],
  idempotent: true,
  params: SessionIdParams,
  body: inp({}),
  response: CheckoutSession,
  status: 200,
  errors: ["state_conflict", "attempt_in_flight"],
  stage: 1,
});

// stage 2 — payments
/** Integer amount filter value: fiat minor units or asset base units, as a decimal string. */
const AmountFilterValue = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .describe("Integer amount (fiat minor units or asset base units) as a decimal string.");

/** `amount[gte|gt|lte|lt]` filters on the priced amount; combine with `currency` (and `asset_id`) to compare like with like. */
const amountFilterShape = {
  "amount[gte]": AmountFilterValue.optional().describe("Only intents whose priced amount is ≥ this value."),
  "amount[gt]": AmountFilterValue.optional().describe("Only intents whose priced amount is > this value."),
  "amount[lte]": AmountFilterValue.optional().describe("Only intents whose priced amount is ≤ this value."),
  "amount[lt]": AmountFilterValue.optional().describe("Only intents whose priced amount is < this value."),
};

export const getPaymentIntent = route({
  id: "getPaymentIntent",
  method: "GET",
  path: "/v1/payment_intents/{id}",
  service: "payments",
  visibility: "public",
  summary: "Retrieve a payment intent with its attempts.",
  auth: ["secret_key", "restricted_key:payment_intents.read", "session"],
  idempotent: false,
  params: IntentIdParams,
  response: PaymentIntent,
  status: 200,
  errors: [],
  stage: 1,
});

export const listPaymentIntents = route({
  id: "listPaymentIntents",
  method: "GET",
  path: "/v1/payment_intents",
  service: "payments",
  visibility: "public",
  summary: "List payment intents.",
  auth: ["secret_key", "restricted_key:payment_intents.read", "session"],
  idempotent: false,
  description:
    "Typed filters (ADR-0018): `status`, `created[…]` (Stage 1); `amount[gte|gt|lte|lt]`, `currency`, `asset_id`, `settlement_asset_id`, `source`, `customer`, `payment_link`, `checkout_session` and `metadata[key]=value` (exact match, up to 10) from Stage 2. Filters combine with AND.",
  query: withMetadataFilter({
    ...listQueryShape,
    ...createdFilterShape,
    status: IntentStatus.optional(),
    // stage 2 — payments (ADR-0018)
    ...amountFilterShape,
    currency: PricingCurrency.optional().describe("Only intents priced in this currency (`asset` = asset-priced)."),
    asset_id: AssetId.optional().describe("Only asset-priced intents priced in this asset."),
    settlement_asset_id: AssetId.optional().describe("Only intents settling in this asset."),
    source: openEnum(["checkout", "invoice", "payment_link", "api"], "Only intents created this way.").optional(),
    customer: id("cus").optional().describe("Only intents of this customer."),
    payment_link: id("plink").optional().describe("Only intents created through this payment link."),
    checkout_session: id("cs").optional().describe("Only the intent of this checkout session."),
    // stage 3 — billing
    invoice: id("in").optional().describe("Only intents opened for this invoice (Stage 3)."),
  }),
  response: listOf(PaymentIntent, "PaymentIntentList", "A page of payment intents."),
  status: 200,
  errors: [],
  stage: 1,
});

export const cancelPaymentIntent = route({
  id: "cancelPaymentIntent",
  method: "POST",
  path: "/v1/payment_intents/{id}/cancel",
  service: "payments",
  visibility: "public",
  summary: "Cancel an unpaid intent (its session expires).",
  auth: ["secret_key", "restricted_key:payment_intents.write"],
  idempotent: true,
  params: IntentIdParams,
  body: inp({
    cancellation_reason: z.string().max(500).optional().describe("Free-text reason."),
  }),
  response: PaymentIntent,
  status: 200,
  errors: ["state_conflict", "attempt_in_flight"],
  stage: 1,
});

// =============================================================================================
// Statement (domain-model §6): NearPay holds no balances; each line records what settled where
// =============================================================================================

export const BalanceTransactionType = openEnum(
  ["payment", "overpayment", "refund", "fee_adjustment"],
  "What the line records: a succeeded payment, extra settlement, a refund (Stage 2) or a reconciliation fee correction (Stage 2).",
);

export const BalanceTransaction = out({
  id: id("txn"),
  object: z.literal("balance_transaction").describe("Always `balance_transaction`."),
  created: UnixTime.describe("When the line was recorded."),
  livemode: Livemode,
  type: BalanceTransactionType,
  payment_intent: id("pi").nullable().describe("Payment intent the line belongs to."),
  refund: id("re").nullable().describe("Refund the line belongs to (refund lines, Stage 2)."),
  gross: out({ amount: FiatAmount, currency: Currency })
    .nullable()
    .describe("Priced amount for `payment` lines of fiat-priced intents (minor units)."),
  settled: SettlementValue.describe(
    "Amount of the settlement asset the line records (received by, or returned from, the destination).",
  ),
  fee: out({
    bps: Bps.describe("Fee rate applied."),
    amount_estimated: BaseUnits.describe("Estimated fee in the fee asset, base units."),
    asset_id: AssetId.describe("Asset the fee was taken in."),
  })
    .nullable()
    .describe("Fee for `payment` lines."),
  evidence: Evidence.describe("On-chain proof behind the line."),
  // stage 2 — payments
  refund_leg: z
    .int()
    .min(1)
    .nullable()
    .optional()
    .describe("Refund lines: number of the refund leg that settled (a duplicate leg gets its own line)."),
  received: out({
    amount: BaseUnits.describe("Amount the payer received, base units of `asset_id`."),
    asset_id: AssetId.describe("Asset the payer received (the refund recipient asset)."),
    chain: ChainId.describe("Chain the payer received on."),
  })
    .nullable()
    .optional()
    .describe(
      "Refund lines: what reached the payer, from the evidence (`settled` is what left the merchant destination).",
    ),
  fee_adjustment: out({
    payment_attempt: id("pa").describe("Attempt whose fee was corrected."),
    expected: BaseUnits.describe("Fee expected from the fee snapshot, base units of `asset_id`."),
    observed: BaseUnits.describe("Fee observed by reconciliation (Explorer `appFees`), base units of `asset_id`."),
    asset_id: AssetId.describe("Fee asset."),
    reconciliation_run: id("rcn").describe("Reconciliation run that found the difference."),
  })
    .nullable()
    .optional()
    .describe("`fee_adjustment` lines: the corrected fee (`settled` and `evidence` repeat the payment's)."),
}).meta({ id: "BalanceTransaction", description: "A statement line: what settled where, with its evidence." });
export type BalanceTransaction = z.infer<typeof BalanceTransaction>;

export const listBalanceTransactions = route({
  id: "listBalanceTransactions",
  method: "GET",
  path: "/v1/balance_transactions",
  service: "payments",
  visibility: "public",
  summary: "List statement lines (what settled where, with evidence).",
  auth: ["secret_key", "restricted_key:balance_transactions.read", "session"],
  idempotent: false,
  query: inp({
    ...listQueryShape,
    ...createdFilterShape,
    payment_intent: id("pi").optional().describe("Only lines of this payment intent."),
    type: BalanceTransactionType.optional().describe("Only lines of this type."),
    // stage 2 — payments
    refund: id("re").optional().describe("Only lines of this refund (Stage 2)."),
  }),
  response: listOf(BalanceTransaction, "BalanceTransactionList", "A page of statement lines."),
  status: 200,
  errors: [],
  stage: 1,
});

// =============================================================================================
// stage 2 — payments: API-created intents and review decisions (lld/payments.md §6.1, §17)
// =============================================================================================

export const PaymentIntentCreate = inp({
  ...pricingInputShape,
  settlement_destination: id("sd")
    .optional()
    .describe("Destination to settle to; default: the asset or account default."),
  return_url: Url.describe(
    "Where the payer goes after paying (the success URL of the intent's headless checkout session).",
  ),
  expires_in: z
    .int()
    .min(300)
    .max(86_400)
    .optional()
    .describe("Seconds the intent accepts new payments (default from account settings, 3600)."),
  customer: id("cus").optional().describe("Customer to attach."),
  customer_email: z.email().max(254).optional().describe("Payer email for the receipt (never in events)."),
  description: z.string().max(500).optional().describe("Shown to the payer."),
  late_payments: z.boolean().optional().describe("Override the account setting."),
  metadata: Metadata.optional(),
})
  .superRefine(refinePricing)
  .meta({ id: "PaymentIntentCreate", description: "Parameters to create a payment intent without a checkout page." });

/** `createPaymentIntent` response: the intent plus the payer credential, returned once. */
export const CreatedPaymentIntent = PaymentIntent.extend({
  checkout_session: id("cs", "Headless checkout session that carries the payer API for this intent."),
  client_secret: z
    .string()
    .regex(/^cs_[0-9a-z]{26}_secret_[0-9A-Za-z]{32}$/)
    .describe(
      "Client secret of `checkout_session` for the payer API (`@nearpay-money/js`); returned only here, never in events.",
    ),
}).meta({
  id: "CreatedPaymentIntent",
  description: "A new payment intent with the client secret its custom payer UI uses.",
});

export const createPaymentIntent = route({
  id: "createPaymentIntent",
  method: "POST",
  path: "/v1/payment_intents",
  service: "payments",
  visibility: "public",
  summary: "Create a payment intent for a custom payer UI.",
  description:
    "Creates the intent (`source: api`) together with a headless checkout session (`ui_mode: hosted`, `success_url` = `return_url`). A custom UI built on `@nearpay-money/js` pays it through the payer API (`/v1/checkout/sessions/{checkout_session}/public/*`) with `client_secret`; the hosted page also works. The intent expires with that session.",
  auth: ["secret_key", "restricted_key:payment_intents.write"],
  idempotent: true,
  body: PaymentIntentCreate,
  response: CreatedPaymentIntent,
  status: 201,
  errors: [
    "account_not_live",
    "destination_not_active",
    "amount_below_destination_minimum",
    "amount_above_unverified_cap",
    "currency_unsupported",
    "customer_deleted",
  ],
  stage: 2,
});

export const ReviewDecisionBody = inp({
  decision: closedEnum(
    ["accept", "reject"],
    "`accept`: the settled amount counts as paid (`short_settlement` only). `reject`: not paid.",
  ),
  reason: z.string().max(500).optional().describe("Free-text reason (audited)."),
  create_refund: z
    .boolean()
    .optional()
    .describe(
      "`reject` only: create a draft refund of the settled amount to the payer (default `true` when something settled).",
    ),
}).meta({ id: "ReviewDecision", description: "A merchant decision on a payment intent in `requires_review`." });

export const reviewPaymentIntent = route({
  id: "reviewPaymentIntent",
  method: "POST",
  path: "/v1/payment_intents/{id}/review",
  service: "payments",
  visibility: "public",
  summary: "Accept or reject a payment intent that requires review.",
  description:
    "`accept` moves a `short_settlement` intent to `succeeded` (the evidence shows what settled; the merchant waives the shortfall). A `verification_held` intent has no evidence yet and cannot be accepted (`review_requires_evidence`, INV-2); it resolves itself when evidence arrives. `reject` moves the intent back to `requires_payment` (session open) or `expired`, and by default creates a refund of any settled amount in `requires_action` for the merchant to sign.",
  auth: ["secret_key", "restricted_key:payment_intents.write", "session"],
  roles: ["owner", "admin", "finance"],
  idempotent: true,
  params: IntentIdParams,
  body: ReviewDecisionBody,
  response: PaymentIntent,
  status: 200,
  errors: ["state_conflict", "review_requires_evidence"],
  stage: 2,
});
