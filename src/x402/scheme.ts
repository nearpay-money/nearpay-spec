/**
 * NearPay x402 v2 profile: scheme `exact`, transfer method `intents-transfer` on `near:mainnet`
 * (ADR-0009, lld/agentpay.md §3). Wire shapes follow x402 v2 (`@x402/core` types: PaymentRequired,
 * PaymentRequirements, PaymentPayload, VerifyRequest/Response, SettleRequest/Response, SupportedResponse).
 * Headers `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE` carry base64(JSON) of these.
 */
import { AssetId, BaseUnits, Binding, NearAccountId, Timestamp, TxHash } from "../common/primitives.js";
import { openEnum, out, z } from "../common/schema.js";
import { INTENTS_CONTRACT, MultiPayload } from "../intents/payloads.js";

export const X402_VERSION = 2 as const;
export const X402_NETWORK = "near:mainnet" as const;
export const X402_SCHEME = "exact" as const;
export const X402_TRANSFER_METHOD = "intents-transfer" as const;

export const X402Network = z
  .string()
  .regex(/^[^:\s]+:[^:\s]+$/)
  .describe("CAIP-2 network (`near:mainnet` for NearPay).");

export const ResourceInfo = out({
  url: z.url().describe("URL of the paid resource."),
  description: z.string().max(500).optional().describe("What is being paid for."),
  mimeType: z.string().max(100).optional().describe("MIME type of the resource."),
}).meta({ id: "X402ResourceInfo", description: "The resource a payment unlocks." });

/** `extra` of a NearPay `intents-transfer` requirement. */
export const IntentsTransferExtra = out({
  assetTransferMethod: z.literal(X402_TRANSFER_METHOD).describe("NearPay transfer method."),
  paymentFlow: z.literal("authorization").describe("Payer signs; facilitator relays."),
  fee: out({
    to: NearAccountId.describe("NearPay treasury Intents account."),
    amount: BaseUnits.describe("Fee in base units of the same asset."),
  }).describe("NearPay fee transfer the payload must also contain."),
  binding: Binding,
  verifyingContract: z.literal(INTENTS_CONTRACT).describe("Verifier contract."),
  deadline: Timestamp.optional().describe(
    "Absolute expiry of this issued requirement (RFC 3339; the binding's `expires_at`). Sign a Verifier `deadline` at or before it; absent from facilitators older than spec 0.1.5, then derive the window from `maxTimeoutSeconds`.",
  ),
}).meta({ id: "X402IntentsTransferExtra", description: "NearPay `intents-transfer` requirement details." });

export const PaymentRequirements = out({
  scheme: z.literal(X402_SCHEME).describe("x402 scheme."),
  network: z.literal(X402_NETWORK).describe("Network."),
  amount: BaseUnits.describe("Amount the merchant receives, base units."),
  asset: AssetId.describe("Asset to pay (NEAR Intents asset id)."),
  payTo: NearAccountId.describe("Merchant Intents account."),
  maxTimeoutSeconds: z.int().min(30).max(300).describe("Payment must be settled within this time."),
  extra: IntentsTransferExtra,
}).meta({ id: "X402PaymentRequirements", description: "One accepted way to pay (`accepts[]` entry)." });
export type PaymentRequirements = z.infer<typeof PaymentRequirements>;

export const PaymentRequired = out({
  x402Version: z.literal(X402_VERSION).describe("x402 protocol version."),
  error: z.string().optional().describe("Why payment is (still) required."),
  resource: ResourceInfo,
  accepts: z.array(PaymentRequirements).min(1).describe("Accepted payment requirements."),
  extensions: z.record(z.string(), z.unknown()).optional().describe("Protocol extensions."),
}).meta({ id: "X402PaymentRequired", description: "Body of `PAYMENT-REQUIRED` (base64 JSON)." });

export const PaymentPayload = out({
  x402Version: z.literal(X402_VERSION).describe("x402 protocol version."),
  resource: ResourceInfo.optional(),
  accepted: PaymentRequirements.describe("The requirement the payer chose (must equal one in `accepts`)."),
  payload: out({ signed: MultiPayload }).describe("Signed Verifier payload with exactly the two transfers."),
  extensions: z.record(z.string(), z.unknown()).optional().describe("Protocol extensions."),
}).meta({ id: "X402PaymentPayload", description: "Body of `PAYMENT-SIGNATURE` (base64 JSON)." });
export type PaymentPayload = z.infer<typeof PaymentPayload>;

/** `invalidReason` / `errorReason` values NearPay's facilitator returns (lld/agentpay.md §5). */
export const X402_INVALID_REASONS = [
  "invalid_x402_version",
  "invalid_scheme",
  "invalid_network",
  "invalid_payment_requirements",
  "requirement_unknown",
  "requirement_expired",
  "requirement_consumed",
  "invalid_payload",
  "invalid_signature",
  "recipient_mismatch",
  "amount_mismatch",
  "deadline_invalid",
  "insufficient_funds",
  "nonce_used",
  "payer_blocked",
  "quota_exceeded",
] as const;
export const X402InvalidReason = openEnum(X402_INVALID_REASONS, "Why a payment payload is invalid.");

export const X402_SETTLE_ERRORS = [...X402_INVALID_REASONS, "settlement_pending", "unexpected_settle_error"] as const;
export const X402SettleError = openEnum(
  X402_SETTLE_ERRORS,
  "Why settlement did not (yet) succeed; `settlement_pending` is not terminal.",
);

export const VerifyRequest = out({
  x402Version: z.literal(X402_VERSION).describe("x402 protocol version."),
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
}).meta({ id: "X402VerifyRequest", description: "Facilitator `/verify` and `/settle` request." });

export const VerifyResponse = out({
  isValid: z.boolean().describe("Whether the payload would settle."),
  payer: NearAccountId.optional().describe("Payer Intents account."),
  invalidReason: X402InvalidReason.optional(),
  invalidMessage: z.string().optional().describe("Human-readable detail."),
}).meta({ id: "X402VerifyResponse", description: "Facilitator `/verify` result." });

export const SettleResponse = out({
  success: z.boolean().describe("Settled on NEAR (final)."),
  transaction: z.union([TxHash, z.literal("")]).describe("NEAR transaction hash (empty when not submitted)."),
  network: z.literal(X402_NETWORK).describe("Network."),
  payer: NearAccountId.optional().describe("Payer Intents account."),
  amount: BaseUnits.optional().describe("Amount settled to `payTo`."),
  errorReason: X402SettleError.optional(),
  errorMessage: z.string().optional().describe("Human-readable detail."),
  replayed: z
    .boolean()
    .optional()
    .describe(
      "True when this payment payload was settled before and this response repeats that result (settle is idempotent on the payload); deliver the resource at most once per settlement.",
    ),
}).meta({ id: "X402SettleResponse", description: "Facilitator `/settle` result; body of `PAYMENT-RESPONSE`." });

export const SupportedResponse = out({
  kinds: z
    .array(
      out({
        x402Version: z.literal(X402_VERSION).describe("Version."),
        scheme: z.literal(X402_SCHEME).describe("Scheme."),
        network: z.literal(X402_NETWORK).describe("Network."),
        extra: out({ assetTransferMethod: z.literal(X402_TRANSFER_METHOD).describe("Method.") }).describe("Details."),
      }).describe("A supported scheme/network."),
    )
    .describe("Supported kinds."),
  extensions: z.array(z.string()).describe("Supported extensions."),
  signers: z
    .record(z.string(), z.array(z.string()))
    .describe("Network pattern → relayer accounts that submit transactions."),
}).meta({ id: "X402SupportedResponse", description: "Facilitator `/supported`." });

/** Input to the x402 binding hash (lld/agentpay.md §3); JCS-canonicalised then sha256. */
export const X402BindingInput = out({
  account_id: z.string().describe("Merchant account id (`acct_…`)."),
  resource_url: z.url().describe("Resource URL."),
  payTo: NearAccountId.describe("Merchant Intents account."),
  asset: AssetId.describe("Asset."),
  amount: BaseUnits.describe("Amount."),
  fee: BaseUnits.describe("Fee amount."),
  nonce16: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .describe("16 random bytes, lower-case hex."),
  expires_at: z.int().describe("Requirement expiry, unix seconds."),
}).meta({ id: "X402BindingInput", description: "Fields hashed into an x402 binding." });

/** Encodes an x402 header value: standard base64 of UTF-8 JSON (works in browsers and Node). */
export function encodeX402Header(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Decodes an x402 header value; throws on malformed base64 or JSON. */
export function decodeX402Header(header: string): unknown {
  const bin = atob(header.trim());
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
