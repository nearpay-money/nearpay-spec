/**
 * stage 3 — agent-commerce: NearPay x402 v2 profile, scheme `exact`, transfer method `near-intents`
 * (cross-chain upfront deposit; ADR-0009, lld/agentpay.md §3.1). Wire shapes follow x402 PR #3370
 * (`specs/schemes/exact/scheme_exact_nearintents.md`): an **unquoted** entry per origin asset in the
 * first 402, a `quote` payload that mints a 1Click deposit quote through `/verify`, a **quoted** entry
 * in the second 402, and a `deposit` payload carrying the deposit `txHash` that `/settle` redeems once
 * rails holds evidence that the merchant was paid (INV-2).
 *
 * NearPay specifics (all inside `extra`, which x402 leaves open): every unquoted entry carries an
 * issued, single-use `binding` and its expiry `deadline`, the origin asset's NEAR Intents id
 * `originAssetId`, and the accepted slippage range; the destination is always the merchant's NEAR
 * Intents account (`destination.network` = `near:mainnet`). The `operationToken` is opaque to clients
 * and resource servers (NearPay's construction: `X402OperationTokenInput`).
 *
 * The `intents-transfer` shapes in `scheme.ts` are unchanged; the facilitator serves this method on
 * its own routes (`/x402/near-intents/*`) so existing request and response types stay exact.
 */
import { id } from "../common/ids.js";
import { AssetId, BaseUnits, Binding, ChainAddress, NearAccountId, Timestamp, TxHash } from "../common/primitives.js";
import { closedEnum, openEnum, out, z } from "../common/schema.js";
import { PaymentRequirements, ResourceInfo, X402_SCHEME, X402_VERSION, X402Network } from "./scheme.js";

export const X402_NEAR_INTENTS_METHOD = "near-intents" as const;
export const X402_NEAR_INTENTS_FLOW = "upfront" as const;

const AssetIdentifier = z
  .string()
  .min(1)
  .max(256)
  .describe(
    "Asset in the identifier that network's own x402 scheme uses (EVM: token contract address); for an asset without one (native coins), its NEAR Intents asset id.",
  );

export const NearIntentsDestination = out({
  network: X402Network.describe("CAIP-2 network the merchant receives on (NearPay: `near:mainnet`)."),
  asset: AssetIdentifier.describe("Asset the merchant receives (NearPay: the NEAR Intents asset id)."),
  amount: BaseUnits.describe("Exact amount the merchant receives, base units."),
  recipient: ChainAddress.describe("Merchant address on `network` (NearPay: the merchant's NEAR Intents account)."),
}).meta({ id: "X402NearIntentsDestination", description: "What the merchant receives (EXACT_OUTPUT)." });

export const SlippageRange = out({
  min: z.int().min(0).max(10_000).describe("Lowest accepted `slippageTolerance`, bps."),
  max: z.int().min(0).max(10_000).describe("Highest accepted `slippageTolerance`, bps."),
  default: z.int().min(0).max(10_000).describe("Applied when the quote payload omits `slippageTolerance`, bps."),
}).meta({
  id: "X402SlippageRange",
  description: "Slippage range the facilitator clamps a quote payload's `slippageTolerance` into.",
});

export const NearIntentsExtra = out({
  assetTransferMethod: z.literal(X402_NEAR_INTENTS_METHOD).describe("Transfer method."),
  paymentFlow: z.literal(X402_NEAR_INTENTS_FLOW).describe("The client deposits before the resource is served."),
  destination: NearIntentsDestination,
  indicativeAmount: BaseUnits.optional().describe(
    "Indicative deposit amount of `asset` (not binding; may change between responses).",
  ),
  // quoted entry only
  operationToken: z
    .string()
    .min(16)
    .max(512)
    .optional()
    .describe(
      "Quoted entry only: authorises redemption of this quote. Opaque bearer credential; persist it before depositing.",
    ),
  refundDeadline: Timestamp.optional().describe(
    "Quoted entry only: deposits not swapped by then are refunded to `refundTo`; deposit early enough to confirm before it.",
  ),
  depositMemo: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("Quoted entry only, when the origin network needs a memo or destination tag."),
  minAmountIn: BaseUnits.optional().describe(
    "Quoted entry only (NearPay): smallest deposit 1Click executes; the unused part of `amount` returns to `refundTo`.",
  ),
  // NearPay additions
  binding: Binding.optional().describe(
    "NearPay: the issued requirement this entry belongs to (single use: one quote). Always set by NearPay.",
  ),
  deadline: Timestamp.optional().describe(
    "NearPay: the unquoted entry must be quoted before this instant (the binding's `expires_at`).",
  ),
  originAssetId: AssetId.optional().describe("NearPay: NEAR Intents asset id of the origin asset (`asset`)."),
  slippageTolerance: SlippageRange.optional().describe("NearPay: accepted `slippageTolerance` range."),
}).meta({ id: "X402NearIntentsExtra", description: "`extra` of an `exact` + `near-intents` requirement." });

export const NearIntentsPaymentRequirements = out({
  scheme: z.literal(X402_SCHEME).describe("x402 scheme."),
  network: X402Network.describe("CAIP-2 of the **origin** network: where the client pays."),
  amount: z
    .union([BaseUnits, z.literal("")])
    .describe('Unquoted: `""` (cannot be paid yet). Quoted: 1Click `amountIn`, the amount to deposit.'),
  asset: AssetIdentifier.describe("Origin asset the client deposits."),
  payTo: z
    .union([ChainAddress, z.literal("")])
    .describe('Unquoted: `""`. Quoted: the single-use 1Click deposit address on `network`.'),
  maxTimeoutSeconds: z
    .int()
    .min(60)
    .max(86_400)
    .describe("Deposit window requested from 1Click (the quote's refund deadline = quote time + this)."),
  extra: NearIntentsExtra,
}).meta({
  id: "X402NearIntentsPaymentRequirements",
  description:
    "An `exact` + `near-intents` `accepts[]` entry (unquoted, or quoted when `extra.operationToken` is set).",
});
export type NearIntentsPaymentRequirements = z.infer<typeof NearIntentsPaymentRequirements>;

/** Any `accepts[]` entry NearPay issues or parses. */
export const X402AnyPaymentRequirements = z
  .union([PaymentRequirements, NearIntentsPaymentRequirements])
  .describe("An `intents-transfer` or a `near-intents` entry (`extra.assetTransferMethod` tells them apart).");

export const X402PaymentRequiredAny = out({
  x402Version: z.literal(X402_VERSION).describe("x402 protocol version."),
  error: z.string().optional().describe("Why payment is (still) required."),
  resource: ResourceInfo,
  accepts: z.array(X402AnyPaymentRequirements).min(1).describe("Accepted payment requirements."),
  extensions: z.record(z.string(), z.unknown()).optional().describe("Protocol extensions."),
}).meta({
  id: "X402PaymentRequiredAny",
  description:
    "Body of `PAYMENT-REQUIRED` with `intents-transfer` and/or `near-intents` entries (clients skip methods they do not implement).",
});

export const NearIntentsQuotePayload = out({
  type: z.literal("quote").describe("Mint a deposit quote for `accepted` (never unlocks the resource)."),
  refundTo: ChainAddress.describe(
    "Client address on `accepted.network`; receives every refund and the unused slippage buffer.",
  ),
  slippageTolerance: z
    .int()
    .min(0)
    .max(10_000)
    .optional()
    .describe("Bps; clamped into the facilitator's range, default applied when omitted."),
}).meta({ id: "X402NearIntentsQuotePayload", description: "`payload` that asks for a deposit quote." });

export const NearIntentsDepositPayload = out({
  type: z.literal("deposit").describe("Redeem a quote with the deposit transaction."),
  operationToken: z.string().min(16).max(512).describe("`extra.operationToken` of the quoted entry."),
  depositAddress: ChainAddress.describe("The quoted entry's `payTo`."),
  depositMemo: z.string().min(1).max(256).optional().describe("The quoted entry's `extra.depositMemo`, when set."),
  txHash: TxHash.describe("The client's deposit transaction on `accepted.network` (the payment proof)."),
}).meta({ id: "X402NearIntentsDepositPayload", description: "`payload` that presents the deposit." });

export const NearIntentsPaymentPayload = out({
  x402Version: z.literal(X402_VERSION).describe("x402 protocol version."),
  resource: ResourceInfo.describe("Required for `near-intents`: the resource being paid for."),
  accepted: NearIntentsPaymentRequirements.describe("The **unquoted** entry, as advertised in the first 402."),
  payload: z
    .discriminatedUnion("type", [NearIntentsQuotePayload, NearIntentsDepositPayload])
    .describe("`quote` or `deposit`."),
  extensions: z.record(z.string(), z.unknown()).optional().describe("Protocol extensions."),
}).meta({
  id: "X402NearIntentsPaymentPayload",
  description: "Body of `PAYMENT-SIGNATURE` for `near-intents` (base64 JSON).",
});
export type NearIntentsPaymentPayload = z.infer<typeof NearIntentsPaymentPayload>;

/**
 * Facilitator reasons for `near-intents` (`invalidReason` / `errorReason`): the shared NearPay reasons
 * that apply plus the codes of x402 PR #3370, verbatim.
 */
export const X402_NEAR_INTENTS_INVALID_REASONS = [
  "invalid_x402_version",
  "invalid_scheme",
  "invalid_network",
  "invalid_payment_requirements",
  "requirement_unknown",
  "requirement_expired",
  "requirement_consumed",
  "invalid_payload",
  "payer_blocked",
  "quota_exceeded",
  "invalid_exact_near_intents_quote_unavailable",
  "invalid_exact_near_intents_token_invalid",
  "invalid_exact_near_intents_token_expired",
  "invalid_exact_near_intents_quote_mismatch",
  "invalid_exact_near_intents_deposit_not_found",
] as const satisfies readonly string[];

export const X402NearIntentsInvalidReason = openEnum(
  X402_NEAR_INTENTS_INVALID_REASONS,
  "Why a `near-intents` payload is invalid.",
);

export const X402_NEAR_INTENTS_SETTLE_ERRORS = [
  ...X402_NEAR_INTENTS_INVALID_REASONS,
  "settlement_pending",
  "unexpected_settle_error",
  "exact_near_intents_insufficient_deposit",
  "exact_near_intents_payment_failed",
  "exact_near_intents_operation_executed",
] as const;
export const X402NearIntentsSettleError = openEnum(
  X402_NEAR_INTENTS_SETTLE_ERRORS,
  "Why a `near-intents` settlement did not (yet) succeed; `settlement_pending` is not terminal. `exact_near_intents_operation_executed` is answered by resource servers, never by the facilitator.",
);

export const NearIntentsQuote = out({
  depositAddress: ChainAddress.describe("1Click deposit address on the origin network (becomes `payTo`)."),
  depositMemo: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("Memo the deposit must carry, when the origin needs one."),
  amountIn: BaseUnits.describe("Amount to deposit (becomes `amount`); includes slippage buffer and fees."),
  minAmountIn: BaseUnits.optional().describe("NearPay: smallest deposit 1Click executes."),
  refundDeadline: Timestamp.describe("Deposits not swapped by then are refunded."),
  operationToken: z.string().min(16).max(512).describe("Authorises redemption; goes into the quoted entry only."),
}).meta({ id: "X402NearIntentsQuote", description: "A minted deposit quote (`VerifyResponse.extra`)." });

export const NearIntentsVerifyRequest = out({
  x402Version: z.literal(X402_VERSION).describe("x402 protocol version."),
  paymentPayload: NearIntentsPaymentPayload,
  paymentRequirements: NearIntentsPaymentRequirements.describe(
    "The resource server's own **unquoted** entry for `accepted.network` and `accepted.asset` (never `accepted`).",
  ),
}).meta({
  id: "X402NearIntentsVerifyRequest",
  description: "Facilitator `/x402/near-intents/verify` and `/settle` request.",
});

export const NearIntentsVerifyResponse = out({
  isValid: z.boolean().describe("`quote`: a quote was minted. `deposit`: the token and terms verify."),
  payer: ChainAddress.optional().describe("`deposit`: the quote's `refundTo` on the origin network."),
  invalidReason: X402NearIntentsInvalidReason.optional(),
  invalidMessage: z.string().optional().describe("Human-readable detail."),
  extra: NearIntentsQuote.optional().describe("`quote` payloads with `isValid: true`: the minted quote."),
}).meta({ id: "X402NearIntentsVerifyResponse", description: "Facilitator `/x402/near-intents/verify` result." });

export const NearIntentsSettleExtra = out({
  originNetwork: X402Network.optional().describe("Success: the origin network."),
  originTxHash: TxHash.optional().describe("Success: the deposit transaction that paid the instrument."),
  status: z.string().max(64).optional().describe("Not success: the operation's 1Click status (raw)."),
  refundTo: ChainAddress.optional().describe("Failure: where 1Click returns the deposit."),
  agentPayment: id("ap").optional().describe("NearPay, success: the agent payment recorded for the merchant."),
}).meta({ id: "X402NearIntentsSettleExtra", description: "`extra` of a `near-intents` settlement response." });

export const NearIntentsSettleResponse = out({
  success: z.boolean().describe("The merchant was paid (evidence on the destination network)."),
  transaction: z
    .union([TxHash, z.literal("")])
    .describe('Success: the delivery transaction on `network`. Pending: the deposit `txHash`. Failure: `""`.'),
  network: X402Network.describe("Success: the destination network (`near:mainnet`). Otherwise the origin network."),
  payer: ChainAddress.optional().describe("The quote's `refundTo` on the origin network."),
  amount: BaseUnits.optional().describe("Success: amount delivered to the merchant (destination base units)."),
  errorReason: X402NearIntentsSettleError.optional(),
  errorMessage: z.string().optional().describe("Human-readable detail."),
  replayed: z
    .boolean()
    .optional()
    .describe("True when an earlier response already carried this final result; serve the resource at most once."),
  extra: NearIntentsSettleExtra.optional(),
}).meta({
  id: "X402NearIntentsSettleResponse",
  description: "Facilitator `/x402/near-intents/settle` result; body of `PAYMENT-RESPONSE`. Never carries the token.",
});

/** Fields hashed into a `near-intents` binding (JCS, sha256, `np1:` + base58), lld/agentpay.md §3.1. */
export const X402NearIntentsBindingInput = out({
  method: z.literal(X402_NEAR_INTENTS_METHOD).describe("Always `near-intents` (separates the two binding domains)."),
  account_id: z.string().describe("Merchant account id (`acct_…`)."),
  resource_url: z.url().describe("Resource URL."),
  origin_network: X402Network.describe("Origin CAIP-2 network."),
  origin_asset_id: AssetId.describe("Origin asset, NEAR Intents id."),
  pay_to: NearAccountId.describe("Merchant Intents account (`destination.recipient`)."),
  asset_id: AssetId.describe("Destination asset."),
  amount: BaseUnits.describe("Destination amount."),
  max_timeout_s: z.int().describe("`maxTimeoutSeconds`."),
  nonce16: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .describe("16 random bytes, lower-case hex."),
  expires_at: z.int().describe("Unquoted-entry expiry, unix seconds."),
}).meta({ id: "X402NearIntentsBindingInput", description: "Fields hashed into a `near-intents` binding." });

/**
 * NearPay's `operationToken` = `<kid>.<expiry>.<mac>`: `kid` names the facilitator key
 * (`[a-z0-9-]{1,32}`), `expiry` is unix seconds (refund deadline + ≥ 24 h), `mac` is unpadded
 * base64url of HMAC-SHA256(key, JCS(this object)). Stateless to verify; opaque to everyone else.
 */
export const X402OperationTokenInput = out({
  v: z.literal(1).describe("Construction version."),
  binding: Binding.describe("The unquoted entry's binding."),
  network: X402Network.describe("Origin network (`accepted.network`)."),
  deposit_address: ChainAddress.describe("1Click deposit address (the quoted `payTo`)."),
  deposit_memo: z.string().nullable().describe("Deposit memo, or null."),
  resource_url: z.url().describe("`resource.url`."),
  destination: NearIntentsDestination,
  expiry: z.int().describe("Same as the token's `expiry` part."),
}).meta({ id: "X402OperationTokenInput", description: "What NearPay's `operationToken` MAC covers." });

export const OPERATION_TOKEN_RE = /^[a-z0-9-]{1,32}\.[0-9]{1,12}\.[A-Za-z0-9_-]{43}$/;

/** Splits an `operationToken`; null when malformed. Verification needs the facilitator key. */
export function parseOperationToken(token: string): { kid: string; expiry: number; mac: string } | null {
  if (!OPERATION_TOKEN_RE.test(token)) return null;
  const [kid, expiry, mac] = token.split(".") as [string, string, string];
  return { kid, expiry: Number(expiry), mac };
}

/** True for a `near-intents` `accepts[]` entry. */
export function isNearIntentsRequirements(entry: unknown): entry is NearIntentsPaymentRequirements {
  return (
    typeof entry === "object" &&
    entry !== null &&
    (entry as { extra?: { assetTransferMethod?: unknown } }).extra?.assetTransferMethod === X402_NEAR_INTENTS_METHOD
  );
}

/**
 * Builds the quoted entry from the unquoted one and the facilitator's quote (PR #3370 resource-server
 * rule): `depositAddress` → `payTo`, `amountIn` → `amount`; `refundDeadline`, `operationToken`,
 * `depositMemo` and `minAmountIn` into `extra`; `maxTimeoutSeconds` unchanged.
 */
export function quotedRequirements(
  unquoted: NearIntentsPaymentRequirements,
  quote: z.infer<typeof NearIntentsQuote>,
): NearIntentsPaymentRequirements {
  const extra: NearIntentsPaymentRequirements["extra"] = {
    ...unquoted.extra,
    refundDeadline: quote.refundDeadline,
    operationToken: quote.operationToken,
  };
  if (quote.depositMemo !== undefined) extra.depositMemo = quote.depositMemo;
  if (quote.minAmountIn !== undefined) extra.minAmountIn = quote.minAmountIn;
  return { ...unquoted, amount: quote.amountIn, payTo: quote.depositAddress, extra };
}

/** The quoted-entry fields an unquoted entry must not carry (`paymentRequirements` / `accepted` checks). */
export const QUOTED_ONLY_EXTRA = ["operationToken", "refundDeadline", "depositMemo", "minAmountIn"] as const;

export const NearIntentsOperationStatus = closedEnum(
  ["quoted", "settling", "settled", "failed"],
  "Facilitator-side state of a `near-intents` operation (agentpay §3.1; not on the wire).",
);
