/**
 * Public agentpay API (lld/agentpay.md §5, Stage 1): x402 facilitator, agent payments,
 * and agents paying checkout sessions.
 */
import { id } from "../common/ids.js";
import { createdFilterShape, listOf, listQueryShape } from "../common/pagination.js";
import {
  AssetId,
  BaseUnits,
  Binding,
  ChainAddress,
  ChainId,
  Livemode,
  NearAccountId,
  TxHash,
  UnixTime,
} from "../common/primitives.js";
import { route } from "../common/route.js";
import { inp, openEnum, out, z } from "../common/schema.js";
import { IntentsRequirement, MultiPayload } from "../intents/payloads.js";
import {
  NearIntentsSettleResponse,
  NearIntentsVerifyRequest,
  NearIntentsVerifyResponse,
  X402PaymentRequiredAny,
} from "../x402/near-intents.js";
import { PaymentRequired, SettleResponse, SupportedResponse, VerifyRequest, VerifyResponse } from "../x402/scheme.js";
import { AttestationTicket, ClientSecretHeaders, PayerAttempt } from "./payer.js";

// stage 3 — agent-commerce
export const AgentPaymentOrigin = out({
  network: ChainId.describe("Origin network (CAIP-2) the payer deposited on."),
  asset_id: AssetId.describe("Origin asset (NEAR Intents id)."),
  amount_in: BaseUnits.nullable().describe("What the payer deposited, base units of `asset_id`; null if not reported."),
  refund_to: ChainAddress.describe("The payer's refund address on the origin network (from the quote payload)."),
  deposit_address: ChainAddress.describe("1Click deposit address the payer paid."),
  deposit_memo: z.string().nullable().describe("Deposit memo, if the origin network needs one."),
  tx_hashes: z.array(TxHash).describe("Deposit transactions on the origin network."),
  fee: out({
    amount: BaseUnits.describe("Fee, base units of `asset_id`."),
    asset_id: AssetId.describe("Asset the fee was taken in."),
  })
    .nullable()
    .describe("NearPay's fee as observed for the route (provider app fee); null when not reported."),
}).meta({ id: "AgentPaymentOrigin", description: "The cross-chain deposit behind a `near-intents` agent payment." });

export const AgentPayment = out({
  id: id("ap"),
  object: z.literal("agent_payment").describe("Always `agent_payment`."),
  created: UnixTime,
  livemode: Livemode,
  kind: openEnum(["x402", "checkout", "refund"], "What the signed payload paid for."),
  status: openEnum(["verified", "queued", "submitted", "settled", "failed"], "Relay status."),
  payer: NearAccountId.describe(
    "Intents account that signed: the payer (`x402`, `checkout`) or, for a `refund`, the merchant's Intents destination sending the refund.",
  ),
  pay_to: NearAccountId.describe(
    "Receiving Intents account: the merchant (`x402`, `checkout`) or, for a `refund`, the payer's Intents account or the 1Click deposit account of a route refund.",
  ),
  asset_id: AssetId.describe("Asset."),
  amount: BaseUnits.describe("Amount to the merchant, base units."),
  fee_amount: BaseUnits.describe("NearPay fee, base units."),
  binding: Binding,
  resource_url: z.url().nullable().describe("Paid resource (x402)."),
  checkout_session: id("cs").nullable().describe("Checkout session paid (checkout kind)."),
  // spec 0.2.1 — CR-22-AP-02
  refund: id("re")
    .nullable()
    .optional()
    .describe("Refund this payload pays a leg of (`refund` kind); null otherwise. Spec 0.2.1."),
  tx_hash: TxHash.nullable().describe("NEAR transaction that executed the payload."),
  block_height: z.int().min(0).nullable().describe("Block of the transaction."),
  error_reason: z.string().nullable().describe("Why it failed."),
  settled_at: UnixTime.nullable().describe("When it settled (final)."),
  sequence: z
    .int()
    .min(0)
    .optional()
    .describe(
      "Increases with every change; discard webhook objects with a lower sequence. Servers MUST send it (optional in the 0.1.x schema only so readers built on 0.1.4 stay compatible).",
    ),
  // stage 3 — agent-commerce: cross-chain x402 (`near-intents`, lld/agentpay.md §3.1)
  transfer_method: openEnum(
    ["intents-transfer", "near-intents"],
    "How the payment reached the merchant: a payer-signed Verifier payload (`intents-transfer`) or a cross-chain 1Click deposit (`near-intents`, kind `x402` only). Absent from servers older than spec 0.3.0 (= `intents-transfer`).",
  ).optional(),
  origin: AgentPaymentOrigin.nullable()
    .optional()
    .describe(
      "`near-intents` only (null otherwise): the cross-chain deposit. For `near-intents`, `payer` is the NEAR Intents account that delivered the funds to `pay_to` (from the evidence), `amount` the delivered amount and `fee_amount` `0` (NearPay's fee is taken from the deposit: `origin.fee`). Spec 0.3.0.",
    ),
}).meta({ id: "AgentPayment", description: "A payer-signed NEAR Intents payment relayed by NearPay." });
export type AgentPayment = z.infer<typeof AgentPayment>;

// ---------------------------------------------------------------------------------------------
// x402 facilitator
// ---------------------------------------------------------------------------------------------

export const x402Supported = route({
  id: "x402Supported",
  method: "GET",
  path: "/x402/supported",
  service: "agentpay",
  visibility: "public",
  summary: "Schemes and networks this facilitator supports.",
  auth: ["anonymous"],
  idempotent: false,
  response: SupportedResponse,
  status: 200,
  errors: [],
  stage: 1,
});

export const x402Requirements = route({
  id: "x402Requirements",
  method: "POST",
  path: "/x402/requirements",
  service: "agentpay",
  visibility: "public",
  summary: "Issue single-use payment requirements for one 402 response.",
  description: "Never cache or share the result between clients: each binding is single-use.",
  auth: ["secret_key", "restricted_key:agentpay.facilitate"],
  idempotent: false,
  body: inp({
    resource: inp({
      url: z.url().describe("Resource URL."),
      description: z.string().max(500).optional().describe("What is being paid for."),
      mimeType: z.string().max(100).optional().describe("MIME type."),
    }).describe("The resource being paid for."),
    amount: BaseUnits.describe("Amount the merchant receives, base units of the asset."),
    asset_id: AssetId.optional().describe("Asset; default: the asset of the default Intents destination."),
    pay_to: NearAccountId.optional().describe("Merchant Intents account; must be an active Intents destination."),
    max_timeout_s: z.int().min(30).max(300).default(120).describe("Settlement window, seconds."),
  }),
  response: PaymentRequired,
  status: 200,
  errors: [
    "destination_not_intents_account",
    "asset_unsupported",
    "amount_below_minimum",
    "account_not_live",
    // spec 0.3.1 — fiat-priced resource without a usable price
    "pricing_unavailable",
  ],
  stage: 1,
});

export const x402Verify = route({
  id: "x402Verify",
  method: "POST",
  path: "/x402/verify",
  service: "agentpay",
  visibility: "public",
  summary: "Verify a payment payload without settling.",
  auth: ["secret_key", "restricted_key:agentpay.facilitate"],
  idempotent: false,
  body: VerifyRequest,
  response: VerifyResponse,
  status: 200,
  errors: [],
  stage: 1,
});

export const x402Settle = route({
  id: "x402Settle",
  method: "POST",
  path: "/x402/settle",
  service: "agentpay",
  visibility: "public",
  summary: "Verify and settle a payment payload (idempotent on the payload hash).",
  description: "Waits up to 8 s for finality; `errorReason: settlement_pending` is not terminal.",
  auth: ["secret_key", "restricted_key:agentpay.facilitate"],
  idempotent: false,
  body: VerifyRequest,
  response: SettleResponse,
  status: 200,
  errors: ["rail_unavailable"],
  stage: 1,
});

// ---------------------------------------------------------------------------------------------
// Agent payments
// ---------------------------------------------------------------------------------------------

export const listAgentPayments = route({
  id: "listAgentPayments",
  method: "GET",
  path: "/v1/agent_payments",
  service: "agentpay",
  visibility: "public",
  summary: "List agent payments.",
  auth: ["secret_key", "restricted_key:agentpay.facilitate", "session"],
  idempotent: false,
  query: inp({
    ...listQueryShape,
    ...createdFilterShape,
    kind: openEnum(["x402", "checkout", "refund"], "Only this kind.").optional(),
  }),
  response: listOf(AgentPayment, "AgentPaymentList", "A page of agent payments."),
  status: 200,
  errors: [],
  stage: 1,
});

export const getAgentPayment = route({
  id: "getAgentPayment",
  method: "GET",
  path: "/v1/agent_payments/{id}",
  service: "agentpay",
  visibility: "public",
  summary: "Retrieve an agent payment.",
  auth: ["secret_key", "restricted_key:agentpay.facilitate", "session"],
  idempotent: false,
  params: inp({ id: id("ap") }),
  response: AgentPayment,
  status: 200,
  errors: [],
  stage: 1,
});

// ---------------------------------------------------------------------------------------------
// Agents paying checkout sessions
// ---------------------------------------------------------------------------------------------

export const AgentPayRequirements = out({
  object: z.literal("agent_pay_requirements").describe("Always `agent_pay_requirements`."),
  livemode: Livemode,
  attempt_id: id("pa"),
  attestation_ticket: AttestationTicket,
  requirement: IntentsRequirement,
}).meta({
  id: "AgentPayRequirements",
  description:
    "What an agent must sign to pay a checkout session. Agents MUST obtain and verify a sentinel attestation for `requirement` before signing.",
});

export const agentPayRequirements = route({
  id: "agentPayRequirements",
  method: "POST",
  path: "/v1/checkout/sessions/{id}/agent_pay/requirements",
  service: "agentpay",
  visibility: "public",
  summary: "Get (or reuse) an Intents-transfer attempt for an agent.",
  auth: ["client_secret"],
  idempotent: false,
  params: inp({ id: id("cs") }),
  headers: ClientSecretHeaders,
  body: inp({ payer: NearAccountId.describe("Agent's Intents account (refunds go here).") }),
  response: AgentPayRequirements,
  status: 200,
  errors: [
    "client_secret_invalid",
    "session_not_open",
    "too_many_attempts",
    "destination_not_intents_account",
    "attempt_in_flight",
  ],
  stage: 1,
});

export const agentPay = route({
  id: "agentPay",
  method: "POST",
  path: "/v1/checkout/sessions/{id}/agent_pay",
  service: "agentpay",
  visibility: "public",
  summary: "Submit an agent's signed transfer for a checkout session.",
  auth: ["client_secret"],
  idempotent: false,
  params: inp({ id: id("cs") }),
  headers: ClientSecretHeaders,
  body: inp({ signed: MultiPayload }),
  response: out({
    object: z.literal("agent_pay_submission").describe("Always `agent_pay_submission`."),
    status: z.literal("submitted").describe("The payload was queued for relay."),
    agent_payment: id("ap"),
    attempt: PayerAttempt,
  }).meta({ id: "AgentPaySubmission", description: "An accepted agent payment for a checkout session." }),
  status: 202,
  errors: ["client_secret_invalid", "session_not_open", "intent_invalid", "insufficient_balance", "rail_unavailable"],
  stage: 1,
});

// =============================================================================================
// stage 3 — agent-commerce: cross-chain x402, `exact` + `near-intents` (lld/agentpay.md §3.1, §5)
// =============================================================================================

const X402_AUTH = ["secret_key", "restricted_key:agentpay.facilitate"] as const;

export const x402NearIntentsRequirements = route({
  id: "x402NearIntentsRequirements",
  method: "POST",
  path: "/x402/near-intents/requirements",
  service: "agentpay",
  visibility: "public",
  summary: "Issue single-use requirements for one 402 response, with cross-chain (`near-intents`) entries.",
  description:
    "Returns a `PAYMENT-REQUIRED` body whose `accepts` holds the `intents-transfer` entry (unless `include_intents_transfer: false`) followed by one **unquoted** `near-intents` entry per origin. Each entry has its own single-use binding. Never cache or share the result between clients. The merchant is paid in its NEAR Intents account (`pay_to`, or the default Intents destination); NearPay's fee is added to the payer's deposit by the quote.",
  auth: X402_AUTH,
  idempotent: false,
  body: inp({
    resource: inp({
      url: z.url().describe("Resource URL."),
      description: z.string().max(500).optional().describe("What is being paid for."),
      mimeType: z.string().max(100).optional().describe("MIME type."),
    }).describe("The resource being paid for."),
    amount: BaseUnits.describe("Exact amount the merchant receives, base units of the asset."),
    asset_id: AssetId.optional().describe("Asset; default: the asset of the default Intents destination."),
    pay_to: NearAccountId.optional().describe("Merchant Intents account; must be an active Intents destination."),
    origins: z
      .array(
        inp({
          asset_id: AssetId.describe("Origin asset the payer may deposit (NEAR Intents id, from `GET /v1/assets`)."),
          max_timeout_s: z
            .int()
            .min(60)
            .max(86_400)
            .optional()
            .describe("Deposit window; default and minimum come from the origin chain's profile."),
        }).describe("An origin the payer may pay from."),
      )
      .min(1)
      .max(20)
      .describe("Origins to offer, one unquoted entry each (duplicates refused)."),
    include_intents_transfer: z
      .boolean()
      .default(true)
      .describe("Also return the `intents-transfer` entry first (`max_timeout_s` applies to it)."),
    max_timeout_s: z.int().min(30).max(300).default(120).describe("`intents-transfer` settlement window, seconds."),
    quote_window_s: z
      .int()
      .min(30)
      .max(900)
      .default(300)
      .describe("How long the unquoted entries can be quoted (`extra.deadline`), seconds."),
  }),
  response: X402PaymentRequiredAny,
  status: 200,
  errors: [
    "destination_not_intents_account",
    "asset_unsupported",
    "amount_below_minimum",
    "account_not_live",
    "deadline_too_short",
    "rail_unavailable",
    // spec 0.3.1 — fiat-priced resource without a usable price
    "pricing_unavailable",
  ],
  stage: 3,
});

export const x402NearIntentsVerify = route({
  id: "x402NearIntentsVerify",
  method: "POST",
  path: "/x402/near-intents/verify",
  service: "agentpay",
  visibility: "public",
  summary: "`quote` payload: mint a 1Click deposit quote. `deposit` payload: check the token and terms.",
  description:
    "A `quote` payload consumes the entry's binding and creates a rails execution (owner agentpay); the quote is in `extra` — answer the client with a second 402 holding `quotedRequirements(entry, extra)` and do not serve the resource. A `deposit` payload is checked without waiting or claiming (token, expiry, terms). `paymentRequirements` must be the server's own unquoted entry.",
  auth: X402_AUTH,
  idempotent: false,
  body: NearIntentsVerifyRequest,
  response: NearIntentsVerifyResponse,
  status: 200,
  errors: ["rail_unavailable", "screening_unavailable"],
  stage: 3,
});

export const x402NearIntentsSettle = route({
  id: "x402NearIntentsSettle",
  method: "POST",
  path: "/x402/near-intents/settle",
  service: "agentpay",
  visibility: "public",
  summary: "Redeem a `deposit` payload once the merchant is paid (idempotent per operation).",
  description:
    "Waits up to 8 s for rails evidence; `errorReason: settlement_pending` is not terminal (retry with the same token). An operation has one final result, repeated with `replayed: true` after the first response that carried it. Serve the resource only on `success: true` and at most once per operation.",
  auth: X402_AUTH,
  idempotent: false,
  body: NearIntentsVerifyRequest,
  response: NearIntentsSettleResponse,
  status: 200,
  errors: ["rail_unavailable"],
  stage: 3,
});
