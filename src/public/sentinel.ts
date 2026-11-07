/**
 * Sentinel co-signing of deposit instructions (ADR-0010, lld/sentinel.md §5–§6).
 * Checkout renders an address only after verifying `signature` (Ed25519 over the RFC 8785
 * canonical JSON of `attestation`) with a build-pinned key whose `kid` it knows.
 */
import { id } from "../common/ids.js";
import { AssetId, Base64Url, BaseUnits, ChainAddress, ChainId, Livemode, Timestamp } from "../common/primitives.js";
import { route } from "../common/route.js";
import { closedEnum, inp, out, z } from "../common/schema.js";
import { IntentsRequirement } from "../intents/payloads.js";
import { AttestationTicket } from "./payer.js";

export const AttestationKind = closedEnum(["route_quote", "intents_transfer"], "What is being attested.");

export const AttestedDeposit = out({
  address: ChainAddress.describe("Deposit address."),
  memo: z.string().nullable().describe("Deposit memo, or null."),
  chain: ChainId.describe("Origin chain."),
  origin_asset_id: AssetId.describe("Asset to send."),
  amount_in: BaseUnits.describe("Amount to send, base units."),
  deadline: Timestamp.describe("Deposit deadline."),
}).meta({ id: "AttestedDeposit", description: "Deposit instructions as attested." });

export const DepositInstructionsAttestationRequest = inp({
  livemode: z.boolean().describe("Mode of the attempt."),
  kind: AttestationKind,
  attempt_id: id("pa"),
  attestation_ticket: AttestationTicket,
  deposit: inp({
    address: ChainAddress.describe("Deposit address."),
    memo: z.string().nullable().describe("Deposit memo, or null."),
    chain: ChainId.describe("Origin chain."),
    origin_asset_id: AssetId.describe("Asset to send."),
    amount_in: BaseUnits.describe("Amount to send, base units."),
    deadline: Timestamp.describe("Deposit deadline."),
  })
    .optional()
    .describe("Required for `route_quote`."),
  requirement: inp({
    pay_to: z.string().describe("Merchant Intents account."),
    token: AssetId.describe("Asset."),
    amount: BaseUnits.describe("Amount."),
    fee_to: z.string().describe("Treasury Intents account."),
    fee_amount: BaseUnits.describe("Fee."),
    binding: z.string().describe("Binding memo."),
    deadline: Timestamp.describe("Payload deadline."),
  })
    .optional()
    .describe("Required for `intents_transfer`."),
})
  .superRefine((v, ctx) => {
    if (v.kind === "route_quote" && (!v.deposit || v.requirement)) {
      ctx.addIssue({ code: "custom", path: ["deposit"], message: "route_quote needs deposit and no requirement" });
    }
    if (v.kind === "intents_transfer" && (!v.requirement || v.deposit)) {
      ctx.addIssue({
        code: "custom",
        path: ["requirement"],
        message: "intents_transfer needs requirement and no deposit",
      });
    }
  })
  .meta({ id: "DepositInstructionsAttestationRequest", description: "Instructions checkout wants co-signed." });

export const Attestation = out({
  v: z.literal(1).describe("Attestation format version."),
  kind: AttestationKind,
  attempt_id: id("pa"),
  livemode: Livemode,
  deposit: AttestedDeposit.optional().describe("Present for `route_quote`."),
  requirement: IntentsRequirement.optional().describe("Present for `intents_transfer`."),
  merchant: out({
    name: z.string().describe("Merchant name (KYB-verified legal name when available)."),
    kyb_verified: z.boolean().describe("Whether `name` is KYB-verified."),
  }).describe("Who receives the payment."),
  destination: out({
    asset_id: AssetId.describe("Settlement asset."),
    chain: ChainId.describe("Settlement chain."),
    fingerprint: z
      .string()
      .regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{2}$/)
      .describe("Destination fingerprint (also shown in the merchant dashboard)."),
  }).describe("Matched settlement destination."),
  asset: out({
    asset_id: AssetId.describe("Asset the payer sends (`deposit.origin_asset_id` or `requirement.token`)."),
    symbol: z.string().min(1).max(32).describe("Token symbol from sentinel's own registry read."),
    decimals: z.int().min(0).max(255).describe("Token decimals from sentinel's own registry read."),
  })
    .optional()
    .describe(
      "Display data of the asset the payer sends, attested so checkout renders `amount_in` with signed decimals (CR-15-07, spec 0.2.0). Optional: older sentinels omit it.",
    ),
  issued_at: Timestamp.describe("Issue time."),
  expires_at: Timestamp.describe("Expiry; never after the deposit/payload deadline."),
}).meta({ id: "Attestation", description: "What sentinel vouches for." });
export type Attestation = z.infer<typeof Attestation>;

export const SignedAttestation = out({
  attestation: Attestation,
  kid: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/)
    .describe("Signing key id (pinned in checkout and agent-signer)."),
  signature: Base64Url.describe("Ed25519 signature over RFC 8785 canonical JSON of `attestation`, base64url."),
}).meta({ id: "SignedAttestation", description: "A sentinel co-signature (FR-PAY-10)." });
export type SignedAttestation = z.infer<typeof SignedAttestation>;

export const SentinelKey = out({
  kid: z.string().describe("Key id."),
  public_key: Base64Url.describe("Raw 32-byte Ed25519 public key, base64url."),
  not_after: Timestamp.describe("Key retirement time."),
}).meta({ id: "SentinelKey", description: "A sentinel signing key." });

/**
 * Payload of the attestation ticket payments issues with each attempt (lld/payments.md §8.2).
 * Ticket = `base64url(JCS(payload)) + "." + base64url(Ed25519(payments ticket key, JCS bytes))`.
 */
export const AttestationTicketPayload = out({
  attempt_id: id("pa"),
  livemode: Livemode,
  deposit_key: z
    .string()
    .min(1)
    .describe("`<provider>|<address>|<memo or empty>` (route_quote) or the binding (intents_transfer)."),
  exp: z.int().describe("Expiry, unix seconds (issue + 15 min)."),
}).meta({ id: "AttestationTicketPayload", description: "Claims of an attestation ticket." });
export type AttestationTicketPayload = z.infer<typeof AttestationTicketPayload>;

/** Builds the deposit key of a `route_quote` attempt. `provider` is `oneclick` (live) or `sandbox` (test). */
export function routeQuoteDepositKey(provider: "oneclick" | "sandbox", address: string, memo: string | null): string {
  return `${provider}|${address}|${memo ?? ""}`;
}

export const createDepositInstructionsAttestation = route({
  id: "createDepositInstructionsAttestation",
  method: "POST",
  path: "/v1/attestations/deposit_instructions",
  service: "sentinel",
  visibility: "public",
  summary: "Co-sign deposit instructions or an Intents-transfer requirement.",
  description: "Fail-closed: without a valid signature, checkout shows no address and no wallet prompt.",
  auth: ["anonymous"],
  idempotent: false,
  body: DepositInstructionsAttestationRequest,
  response: SignedAttestation,
  status: 200,
  errors: ["ticket_invalid", "attestation_refused", "attestation_stale", "attestation_unavailable"],
  stage: 1,
});

export const listAttestationKeys = route({
  id: "listAttestationKeys",
  method: "GET",
  path: "/v1/attestations/keys",
  service: "sentinel",
  visibility: "public",
  summary: "Sentinel public keys (informational; clients pin keys at build time).",
  auth: ["anonymous"],
  idempotent: false,
  response: out({
    object: z.literal("list").describe("Always `list`."),
    keys: z.array(SentinelKey).describe("Current and next keys."),
  }).meta({ id: "SentinelKeys", description: "Sentinel public keys." }),
  status: 200,
  errors: [],
  stage: 1,
});
