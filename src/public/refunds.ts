/**
 * Refunds (lld/payments.md §5, §6.1, §8.4, §17; architecture/flows.md §4; domain-model §4.4) — Stage 2.
 *
 * Non-custodial (INV-1): NearPay prepares a refund **leg** (a rails execution) and returns the
 * `next_action` the merchant signs with the wallet that holds the settlement destination; NearPay
 * only relays what the merchant signed. A refund succeeds only on payer-side evidence (INV-2) and
 * goes to the payer's recorded refund address unless an owner overrides it with step-up (INV-7).
 * Amounts are base-unit strings with an explicit asset (INV-5).
 */
import { Evidence } from "../common/evidence.js";
import { id } from "../common/ids.js";
import { createdFilterShape, listOf, listQueryShape } from "../common/pagination.js";
import {
  AssetId,
  BaseUnits,
  Binding,
  ChainAddress,
  ChainId,
  Livemode,
  Metadata,
  NearAccountId,
  TxHash,
  UnixTime,
} from "../common/primitives.js";
import { route } from "../common/route.js";
import { closedEnum, inp, openEnum, out, z } from "../common/schema.js";
import {
  INTENTS_CONTRACT,
  IntentMessage,
  IntentNonce,
  MultiPayload,
  MultiPayloadStandard,
} from "../intents/payloads.js";

// =============================================================================================
// Objects
// =============================================================================================

export const RefundStatus = openEnum(
  ["requires_action", "pending", "succeeded", "failed", "canceled"],
  "Refund status (domain-model §4.4): `requires_action` = waiting for the merchant's signature; `pending` = the merchant's funds were detected and are on their way; `failed` = the provider returned them to the merchant (prepare again to retry).",
);

export const RefundReason = openEnum(
  ["requested_by_customer", "duplicate", "fraudulent", "overpayment", "other"],
  "Why the merchant refunds.",
);

export const RefundFeeMode = closedEnum(
  ["payer_absorbs", "merchant_absorbs"],
  "`payer_absorbs` (default, `EXACT_INPUT`): the merchant sends `amount`, the payer receives it minus route costs. `merchant_absorbs` (`EXACT_OUTPUT`): the payer receives the equivalent of `amount`; the merchant sends slightly more.",
);

export const RefundMethod = openEnum(
  ["route_quote", "intents_transfer"],
  "`route_quote`: a 1Click route back to the payer's origin chain and asset. `intents_transfer`: a merchant-signed Verifier transfer to the payer's Intents account (refund of an `intents_transfer` payment; no route provider).",
);

export const RefundSwapType = closedEnum(["EXACT_INPUT", "EXACT_OUTPUT"], "How the route leg was quoted.");

export const RefundRecipient = out({
  address: ChainAddress.describe("Payer's refund address (or Intents account)."),
  asset_id: AssetId.describe("Asset the payer receives (the asset they paid with)."),
  chain: ChainId.describe("Chain the payer receives on."),
  type: closedEnum(["origin_chain", "intents"], "Address on the origin chain, or a NEAR Intents account."),
  overridden: z.boolean().describe("An owner replaced the recorded refund address (INV-7)."),
}).meta({ id: "RefundRecipient", description: "Where the refund goes (INV-7: the payer's recorded refund address)." });

export const TokenRef = out({
  standard: openEnum(["native", "erc20", "nep141", "spl", "other"], "Token standard on the chain."),
  address: z.string().nullable().describe("Token contract / mint / NEP-141 account; null for native assets."),
}).meta({ id: "TokenRef", description: "How to transfer an asset on its chain." });

/** Merchant sends a chain transfer from the settlement destination to a 1Click deposit address. */
export const SignAndSendAction = out({
  type: z.literal("sign_and_send").describe("Sign and broadcast a transfer on `chain`."),
  chain: ChainId.describe("Chain to send on (the settlement destination's chain)."),
  from: ChainAddress.describe(
    "The settlement destination address; sign with this wallet (refunds of the route go back to it).",
  ),
  to: ChainAddress.describe("1Click deposit address of this leg."),
  asset_id: AssetId.describe("Asset to send (the settlement asset)."),
  token: TokenRef,
  symbol: z.string().describe("Token symbol."),
  decimals: z.int().min(0).max(255).describe("Token decimals."),
  amount: BaseUnits.describe("Exact amount to send, base units."),
  memo: z.string().nullable().describe("Memo the transfer must carry, if any."),
  deadline: UnixTime.describe("Send before this time; later deposits return to `from`."),
  display: z.string().describe("Human-readable summary, e.g. `Send 2.000000 USDC on Base to 0xab…`."),
}).meta({
  id: "RefundSignAndSend",
  description: "Next action: transfer exactly `amount` of `asset_id` from `from` to `to` on `chain`.",
});

/** Merchant signs a Verifier transfer from its Intents account; NearPay relays it (agentpay). */
export const SignIntentAction = out({
  type: z.literal("sign_intent").describe("Sign a NEAR Intents payload; submit it with `submit_tx`."),
  signer_id: NearAccountId.describe("The merchant's Intents account (the settlement destination)."),
  transfer: out({
    receiver_id: NearAccountId.describe(
      "Payer's Intents account (`intents_transfer`) or the 1Click Intents deposit address (`route_quote`).",
    ),
    token: AssetId.describe("Asset transferred."),
    amount: BaseUnits.describe("Amount, base units."),
    memo: Binding.describe("Binding memo of this leg."),
  }).describe("The single transfer the payload contains (for the human-readable summary)."),
  standards: z
    .array(MultiPayloadStandard)
    .min(1)
    .describe("Signing standards accepted for `signer_id` (`nep413` for NEAR wallets, `erc191` for 0x accounts)."),
  nep413: out({
    recipient: z.literal(INTENTS_CONTRACT).describe("NEP-413 recipient."),
    nonce: IntentNonce,
    message: z.string().min(2).describe("Exact NEP-413 `message` (JSON string of `Nep413IntentMessage`)."),
  }).describe("Arguments for a NEP-413 `signMessage` call, used verbatim."),
  payload: z
    .string()
    .min(2)
    .describe("Exact string to sign for `erc191` / `raw_ed25519` (JSON of `IntentMessage`, same nonce)."),
  message: IntentMessage.describe("Parsed payload, for display and checks; sign `nep413.message` or `payload`."),
  deadline: UnixTime.describe("The payload's deadline; after it, prepare a new leg."),
  display: z.string().describe("Human-readable summary, e.g. `Transfer 2.000000 USDC to payer.near`."),
}).meta({
  id: "RefundSignIntent",
  description: "Next action: sign this Verifier transfer with the merchant's Intents account.",
});

export const RefundNextAction = z.discriminatedUnion("type", [SignAndSendAction, SignIntentAction]).meta({
  id: "RefundNextAction",
  description:
    "What the merchant signs for the current leg. Wallets build exactly this (never another recipient or amount; dashboard §1).",
});
export type RefundNextAction = z.infer<typeof RefundNextAction>;

export const RefundLegStatus = openEnum(
  ["awaiting_signature", "submitted", "processing", "succeeded", "returned", "failed", "expired", "held"],
  "Leg status: `returned` = the provider sent the funds back to the merchant destination; `expired` = the deadline passed without a deposit.",
);

export const RefundLeg = out({
  number: z.int().min(1).describe("Leg number, 1-based; a re-prepared refund gets a new leg."),
  status: RefundLegStatus,
  method: RefundMethod,
  swap_type: RefundSwapType.nullable().describe("Route legs: how the quote was made; null for Intents transfers."),
  amount: BaseUnits.describe("What the merchant sends, base units of the settlement asset."),
  amount_out_expected: BaseUnits.nullable().describe(
    "What the payer is expected to receive, base units of the recipient asset (route estimate).",
  ),
  deadline: UnixTime.describe("Sign and send before this time."),
  submitted_tx: TxHash.nullable().describe("Transaction the merchant reported, or the relayed Intents transaction."),
  duplicate: z
    .boolean()
    .describe("Settled after another leg had already refunded the payer (recorded in `extra_amount_sent`)."),
  evidence: Evidence.nullable().describe("Payer-side evidence once verified (INV-2)."),
  failure_code: z.string().nullable().describe("Why the leg failed, returned or was held."),
  created: UnixTime,
}).meta({ id: "RefundLeg", description: "One prepared route or transfer for a refund." });

export const Refund = out({
  id: id("re"),
  object: z.literal("refund").describe("Always `refund`."),
  created: UnixTime,
  livemode: Livemode,
  status: RefundStatus,
  payment_intent: id("pi"),
  payment_attempt: id("pa", "Attempt whose settlement is refunded (the paying attempt, or an overpayment)."),
  amount: BaseUnits.describe("Refunded amount, base units of `asset_id`."),
  asset_id: AssetId.describe("Settlement asset the amount is in."),
  decimals: z.int().min(0).max(255).describe("Decimals of `asset_id`."),
  fee_mode: RefundFeeMode,
  reason: RefundReason.nullable(),
  method: RefundMethod,
  recipient: RefundRecipient,
  next_action: RefundNextAction.nullable().describe(
    "Present in `requires_action` once the current leg is prepared; null while it is being prepared and in every other status.",
  ),
  legs: z.array(RefundLeg).describe("Legs, newest first."),
  amount_received: BaseUnits.nullable().describe(
    "What the payer received, base units of `recipient.asset_id` (from evidence).",
  ),
  evidence: Evidence.nullable().describe("Payer-side evidence of the leg that refunded the payer (INV-2)."),
  extra_amount_sent: BaseUnits.describe(
    "Settlement-asset amount sent by duplicate legs (signed and sent after another leg had refunded the payer); `0` normally.",
  ),
  source: openEnum(["api", "dashboard", "review_rejection"], "What created the refund."),
  failure_code: z.string().nullable().describe("Why the refund failed (the last leg's code)."),
  succeeded_at: UnixTime.nullable().describe("When the payer-side evidence was verified."),
  canceled_at: UnixTime.nullable().describe("When the merchant canceled."),
  sequence: z.int().min(0).describe("Increases with every change; discard webhook objects with a lower sequence."),
  metadata: Metadata,
}).meta({ id: "Refund", description: "Money returned to a payer, signed by the merchant (non-custodial)." });
export type Refund = z.infer<typeof Refund>;

// =============================================================================================
// Routes
// =============================================================================================

const RefundParams = inp({ id: id("re") });
const WRITE = ["secret_key", "restricted_key:refunds.write", "session"] as const;
const READ = ["secret_key", "restricted_key:refunds.read", "session"] as const;
const REFUND_ROLES = ["owner", "admin", "finance"] as const;

/** Errors of preparing a leg (rails §8.1 for `kind: refund`). */
const PREPARE_ERRORS = [
  "screening_blocked",
  "screening_unavailable",
  "asset_unsupported",
  "route_unavailable",
  "pricing_unavailable",
  "quote_rejected",
] as const;

export const RefundCreate = inp({
  payment_intent: id("pi", "Payment intent to refund."),
  payment_attempt: id("pa")
    .optional()
    .describe("Refund this settled attempt (e.g. an overpayment) instead of the attempt that paid the intent."),
  amount: BaseUnits.optional().describe(
    "Amount in base units of the settlement asset; default everything still refundable.",
  ),
  reason: RefundReason.optional(),
  fee_mode: RefundFeeMode.default("payer_absorbs"),
  metadata: Metadata.optional(),
}).meta({ id: "RefundCreate", description: "Parameters to create a refund." });

export const createRefund = route({
  id: "createRefund",
  method: "POST",
  path: "/v1/refunds",
  service: "payments",
  visibility: "public",
  summary: "Create a refund and prepare its first leg.",
  description:
    "Locks the intent and reserves `amount` (refundable = settled − refunded − pending, per attempt for overpayments), then prepares a leg and returns the refund in `requires_action` with `next_action`. A transient rail failure still returns `201` with `next_action: null` (a job prepares the leg; `refund.requires_action` follows). A definitive preparation error is returned as the error and the refund is recorded as `failed` (retry with `prepare`).",
  auth: WRITE,
  roles: REFUND_ROLES,
  idempotent: true,
  body: RefundCreate,
  response: Refund,
  status: 201,
  errors: ["intent_not_succeeded", "attempt_not_settled", "amount_exceeds_refundable", ...PREPARE_ERRORS],
  stage: 2,
});

export const getRefund = route({
  id: "getRefund",
  method: "GET",
  path: "/v1/refunds/{id}",
  service: "payments",
  visibility: "public",
  summary: "Retrieve a refund.",
  auth: READ,
  idempotent: false,
  params: RefundParams,
  response: Refund,
  status: 200,
  errors: [],
  stage: 2,
});

export const listRefunds = route({
  id: "listRefunds",
  method: "GET",
  path: "/v1/refunds",
  service: "payments",
  visibility: "public",
  summary: "List refunds.",
  auth: READ,
  idempotent: false,
  query: inp({
    ...listQueryShape,
    ...createdFilterShape,
    payment_intent: id("pi").optional().describe("Only refunds of this payment intent."),
    status: RefundStatus.optional().describe("Only refunds in this status."),
  }),
  response: listOf(Refund, "RefundList", "A page of refunds."),
  status: 200,
  errors: [],
  stage: 2,
});

export const prepareRefund = route({
  id: "prepareRefund",
  method: "POST",
  path: "/v1/refunds/{id}/prepare",
  service: "payments",
  visibility: "public",
  summary: "Prepare a new leg (the current one expired, or the refund failed).",
  description:
    "Allowed in `requires_action` when the current leg is expired or was never prepared, and in `failed` (re-reserves the amount). The old leg stays tracked until terminal; if it still settles, the later leg settling too is recorded as a duplicate.",
  auth: WRITE,
  roles: REFUND_ROLES,
  idempotent: true,
  params: RefundParams,
  body: inp({}),
  response: Refund,
  status: 200,
  errors: ["state_conflict", "amount_exceeds_refundable", ...PREPARE_ERRORS],
  stage: 2,
});

export const RefundSubmission = z
  .union([
    inp({
      tx_hash: TxHash.describe("Transaction that sent `next_action.amount` to `next_action.to` (`sign_and_send`)."),
      sender: ChainAddress.optional().describe("Sending account, when the chain needs it (NEAR)."),
    }).describe("A broadcast transfer (`sign_and_send`)."),
    inp({
      signed_intent: MultiPayload.describe("The `next_action` payload signed by `signer_id` (`sign_intent`)."),
    }).describe("A signed Verifier payload (`sign_intent`); NearPay relays it as signed."),
  ])
  .meta({ id: "RefundSubmission", description: "What the merchant signed for the current leg." });

export const submitRefundTx = route({
  id: "submitRefundTx",
  method: "POST",
  path: "/v1/refunds/{id}/submit_tx",
  service: "payments",
  visibility: "public",
  summary: "Report the signed transfer (tx hash) or submit the signed Intents payload.",
  description:
    "`tx_hash` speeds up detection of a `sign_and_send` deposit (detection does not depend on it). `signed_intent` must be exactly the `sign_intent` payload (same signer, nonce, transfer and deadline); payments relays it through agentpay, which only submits it (INV-1).",
  auth: WRITE,
  roles: REFUND_ROLES,
  idempotent: true,
  params: RefundParams,
  body: RefundSubmission,
  response: Refund,
  status: 200,
  errors: [
    "state_conflict",
    "leg_expired",
    "signed_intent_mismatch",
    "intent_invalid",
    "insufficient_balance",
    "rail_unavailable",
  ],
  stage: 2,
});

export const cancelRefund = route({
  id: "cancelRefund",
  method: "POST",
  path: "/v1/refunds/{id}/cancel",
  service: "payments",
  visibility: "public",
  summary: "Cancel a refund that is waiting for the merchant's signature.",
  description:
    "Only in `requires_action` and before anything was submitted for the current leg. Releases the reserved amount. A deposit the merchant still sends to an open leg is not lost: the provider returns it to the destination after the deadline, or, if it settles to the payer, the refund records it (INV-3).",
  auth: WRITE,
  roles: REFUND_ROLES,
  idempotent: true,
  params: RefundParams,
  body: inp({}),
  response: Refund,
  status: 200,
  errors: ["state_conflict"],
  stage: 2,
});

export const updateRefundRecipient = route({
  id: "updateRefundRecipient",
  method: "POST",
  path: "/v1/refunds/{id}/recipient",
  service: "payments",
  visibility: "public",
  summary: "Owner override of the refund address (step-up, fresh screening; INV-7).",
  description:
    "Only in `requires_action` or `failed` with nothing submitted for the current leg. The asset, chain and address type stay those of the payment; the new address is screened and a new leg is prepared.",
  auth: ["session"],
  roles: ["owner"],
  stepUp: true,
  idempotent: true,
  params: RefundParams,
  body: inp({
    address: ChainAddress.describe("New refund address on the recipient chain (or Intents account)."),
    reason: z.string().min(1).max(500).describe("Why the recorded refund address is replaced (audited)."),
  }),
  response: Refund,
  status: 200,
  errors: ["state_conflict", "refund_address_invalid", ...PREPARE_ERRORS],
  stage: 2,
});

export const simulateRefundDeposit = route({
  id: "simulateRefundDeposit",
  method: "POST",
  path: "/v1/test_helpers/refunds/{id}/simulate_deposit",
  service: "payments",
  visibility: "public",
  summary: "Test mode: simulate the merchant's signed transfer for the current leg.",
  description:
    "Route legs: sandbox `POST /sim/deposits` with the leg's deposit address. Intents-transfer legs: sandbox `POST /sim/intents/transfers` with the leg's transfer and binding. The sandbox scenario of a leg follows the last two digits of the refund `amount` (sandbox §4).",
  auth: ["secret_key", "session"],
  roles: REFUND_ROLES,
  idempotent: true,
  testModeOnly: true,
  params: RefundParams,
  body: inp({}),
  response: null,
  status: 202,
  errors: ["livemode_forbidden", "state_conflict", "leg_expired"],
  stage: 2,
});
