/**
 * NEAR Intents Verifier payloads (lld/00-foundations.md §14). Build/sign/verify lives in
 * `@nearpay-internal/intents`; these schemas are the wire contract shared by checkout, agentpay,
 * `@nearpay-money/agent-signer` and the sandbox Verifier.
 */
import { AssetId, BaseUnits, CurvePublicKey, CurveSignature, NearAccountId, Timestamp } from "../common/primitives.js";
import { closedEnum, out, z } from "../common/schema.js";

/** The Verifier contract on NEAR mainnet. */
export const INTENTS_CONTRACT = "intents.near" as const;

/** 32-byte nonce, base64: 4-byte current salt ‖ 28 random bytes. */
export const IntentNonce = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/, "must be 32 bytes, base64")
  .describe("32-byte nonce (4-byte Verifier salt ‖ 28 random bytes), standard base64.");

/** `transfer` intent: move tokens between Intents accounts. */
export const TransferIntent = out({
  intent: z.literal("transfer").describe("Intent kind."),
  receiver_id: NearAccountId.describe("Receiving Intents account."),
  tokens: z.record(AssetId, BaseUnits).describe("Asset id → amount in base units."),
  memo: z.string().max(512).optional().describe("Memo; NearPay puts the binding here."),
}).meta({ id: "TransferIntent", description: "NEAR Intents `transfer` intent." });
export type TransferIntent = z.infer<typeof TransferIntent>;

/** Any intent (NearPay only builds `transfer`; others pass through untyped). */
export const Intent = z
  .union([TransferIntent, out({ intent: z.string().describe("Intent kind.") })])
  .describe("A Verifier intent.");

/** Message signed for the Verifier (ERC-191 / raw_ed25519 carry it whole as a JSON string). */
export const IntentMessage = out({
  signer_id: NearAccountId.describe("Intents account that signs (the payer)."),
  verifying_contract: z.literal(INTENTS_CONTRACT).describe("Verifier contract id."),
  deadline: Timestamp.describe("Latest time the Verifier accepts the payload."),
  nonce: IntentNonce,
  intents: z.array(Intent).min(1).describe("Intents executed atomically."),
}).meta({ id: "IntentMessage", description: "Verifier message (`DefusePayload`)." });
export type IntentMessage = z.infer<typeof IntentMessage>;

/** NEP-413 `message` string content: the message without nonce/verifying_contract. */
export const Nep413IntentMessage = out({
  signer_id: NearAccountId.describe("Intents account that signs."),
  deadline: Timestamp.describe("Latest time the Verifier accepts the payload."),
  intents: z.array(Intent).min(1).describe("Intents executed atomically."),
}).meta({ id: "Nep413IntentMessage", description: "JSON carried in the NEP-413 `message` field." });

export const MULTIPAYLOAD_STANDARDS = ["nep413", "erc191", "raw_ed25519"] as const;
export const MultiPayloadStandard = closedEnum(MULTIPAYLOAD_STANDARDS, "Signing standard supported by NearPay.");

export const Nep413MultiPayload = out({
  standard: z.literal("nep413").describe("NEP-413 (NEAR wallets `signMessage`)."),
  payload: out({
    recipient: z.literal(INTENTS_CONTRACT).describe("NEP-413 recipient (the Verifier)."),
    nonce: IntentNonce,
    message: z.string().min(2).describe("JSON string of `Nep413IntentMessage`."),
    callbackUrl: z.string().nullable().optional().describe("NEP-413 callback URL (NearPay never sets it)."),
  }).describe("NEP-413 payload."),
  public_key: CurvePublicKey.describe("ed25519 key of the signer."),
  signature: CurveSignature.describe("ed25519 signature over the NEP-413 borsh hash."),
}).meta({ id: "Nep413MultiPayload", description: "Payload signed with NEP-413." });

export const Erc191MultiPayload = out({
  standard: z.literal("erc191").describe("ERC-191 `personal_sign` (EVM wallets)."),
  payload: z.string().min(2).describe("JSON string of `IntentMessage`."),
  signature: CurveSignature.describe("secp256k1 signature r‖s‖v (v ∈ {0,1}), base58."),
}).meta({ id: "Erc191MultiPayload", description: "Payload signed with ERC-191." });

export const RawEd25519MultiPayload = out({
  standard: z.literal("raw_ed25519").describe("Raw ed25519 over the payload bytes (agents)."),
  payload: z.string().min(2).describe("JSON string of `IntentMessage`."),
  public_key: CurvePublicKey.describe("ed25519 key of the signer."),
  signature: CurveSignature.describe("ed25519 signature over the UTF-8 payload."),
}).meta({ id: "RawEd25519MultiPayload", description: "Payload signed with raw ed25519." });

/** Envelope submitted to `simulate_intents` / `execute_intents`. */
export const MultiPayload = z
  .discriminatedUnion("standard", [Nep413MultiPayload, Erc191MultiPayload, RawEd25519MultiPayload])
  .meta({ id: "MultiPayload", description: "A signed Verifier payload (`MultiPayload`)." });
export type MultiPayload = z.infer<typeof MultiPayload>;

/** Requirement for paying through a signed Intents transfer (rails §6, agentpay §5). */
export const IntentsRequirement = out({
  pay_to: NearAccountId.describe("Merchant Intents account that receives the payment."),
  token: AssetId.describe("Asset to transfer (equals the settlement asset)."),
  amount: BaseUnits.describe("Amount the merchant receives, base units."),
  fee_to: NearAccountId.describe("NearPay treasury Intents account."),
  fee_amount: BaseUnits.describe("NearPay fee, base units, in the same asset."),
  binding: z
    .string()
    .regex(/^np1:[1-9A-HJ-NP-Za-km-z]{43,44}$/)
    .describe("Memo that both transfers must carry."),
  deadline: Timestamp.describe("Latest acceptable payload deadline."),
}).meta({
  id: "IntentsRequirement",
  description:
    "What a payer must sign: transfer(pay_to, amount) and transfer(fee_to, fee_amount), both with memo = binding.",
});
export type IntentsRequirement = z.infer<typeof IntentsRequirement>;
