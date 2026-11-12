/**
 * Stage 4 chain coverage: Solana and Bitcoin as Tier A chains (lld/rails.md §21, lld/identity.md §8.2,
 * lld/sentinel.md §16, lld/checkout-and-js.md §5.4). Wire formats and pure helpers only; the chain
 * registry, address validation with checksums and the SPL asset-id hash live in kit `chains`
 * (`test-vectors/chains-solana-bitcoin.json` pins every rule for both sides).
 */
import { BaseUnits } from "./primitives.js";
import { closedEnum, out, z } from "./schema.js";

// stage 4 — chains

/** CAIP-2 id of Solana mainnet-beta (first 32 base58 chars of the genesis hash). */
export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
/** CAIP-2 id of Bitcoin mainnet (first 16 bytes of the genesis block hash, hex). */
export const BITCOIN_MAINNET = "bip122:000000000019d6689c085ae165831e93" as const;

const B58 = "[1-9A-HJ-NP-Za-km-z]";

/**
 * Solana account address: base58 of a 32-byte ed25519 public key (or program-derived address).
 * The regex is the wire shape; decoding to exactly 32 bytes is checked by kit `chains`.
 */
export const SolanaAddress = z
  .string()
  .regex(new RegExp(`^${B58}{32,44}$`), "must be a base58 Solana address")
  .meta({
    description: "Solana address: base58 of 32 bytes (ed25519 public key or program-derived address).",
    examples: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
  });

/** Solana transaction signature (the transaction id): base58 of 64 bytes. */
export const SolanaSignature = z
  .string()
  .regex(new RegExp(`^${B58}{64,88}$`), "must be a base58 Solana signature")
  .describe("Solana transaction signature (base58 of 64 bytes); it is the transaction id.");

/** Bitcoin transaction id: 32 bytes, hex, in the usual (byte-reversed) display order. */
export const BitcoinTxid = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be a 64-char lower-case hex txid")
  .describe("Bitcoin txid, lower-case hex in display (byte-reversed) order.");

/**
 * Bitcoin settlement-destination address: P2WPKH (`bc1q…`, witness v0, 20-byte program, bech32) or
 * P2TR (`bc1p…`, witness v1, 32-byte program, bech32m), lower-case. Other address types cannot
 * prove ownership with BIP-322 "simple" and are refused for destinations (lld/identity.md §8.2).
 * Payer refund addresses may be any valid Bitcoin address (kit `chains`).
 */
export const BitcoinDestinationAddress = z
  .string()
  .regex(/^bc1(q[02-9ac-hj-np-z]{38}|p[02-9ac-hj-np-z]{58})$/, "must be a lower-case P2WPKH or P2TR address")
  .meta({
    description: "Bitcoin P2WPKH (`bc1q…`) or P2TR (`bc1p…`) address, lower-case; checksum checked by kit `chains`.",
    examples: ["bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l"],
  });

/** Address types a Bitcoin settlement destination may use. */
export const BitcoinAddressType = closedEnum(
  ["p2wpkh", "p2tr"],
  "Bitcoin destination address type: `p2wpkh` (witness v0, 20-byte program) or `p2tr` (witness v1, 32-byte program).",
);

/** Signing standards of destination ownership attestations (lld/identity.md §8.2). */
export const DESTINATION_SIGNING_STANDARDS = ["nep413", "eip191", "solana", "bip322"] as const;

/**
 * Settlement detail of a Solana transfer (lld/rails.md §21.3). The amount is the owner's balance
 * delta for the mint (all of its token accounts of that mint, or lamports for SOL) in a successful
 * transaction read at `confirmed` commitment (ADR-0022 as amended; `finalized` when rails is configured
 * so): `Evidence.amount = post_amount − pre_amount`.
 */
export const SolanaEvidence = out({
  signature: SolanaSignature.describe("Transaction signature (= `Evidence.tx_hash`)."),
  slot: z.int().min(0).describe("Slot of the block that contains the transaction (= `Evidence.block_ref`)."),
  block_time: z.int().min(0).nullable().describe("Block time, unix seconds; null when the node has none."),
  mint: SolanaAddress.nullable().describe("SPL mint that settled; null for native SOL (lamports)."),
  token_program: SolanaAddress.nullable().describe(
    "Owner program of the mint (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` in v1); null for SOL.",
  ),
  owner: SolanaAddress.describe("Wallet whose balance rose (= `Evidence.recipient`, the merchant destination)."),
  token_accounts: z
    .array(SolanaAddress)
    .describe("Token accounts of `owner` for `mint` whose balance changed (usually its ATA); empty for SOL."),
  pre_amount: BaseUnits.nullable().describe(
    "Owner's balance of the mint before the transaction (`meta.preTokenBalances` / `preBalances`); null when the detector did not read balances (test mode).",
  ),
  post_amount: BaseUnits.nullable().describe(
    "Owner's balance of the mint after the transaction; null when the detector did not read balances (test mode).",
  ),
}).meta({ id: "SolanaEvidence", description: "Solana-specific settlement detail (token-balance delta)." });
export type SolanaEvidence = z.infer<typeof SolanaEvidence>;

/**
 * Settlement detail of a Bitcoin transfer (lld/rails.md §21.3): the outputs of `txid` paying the
 * destination's scriptPubKey; `Evidence.amount` = Σ `outputs[].value` (satoshis).
 */
export const BitcoinEvidence = out({
  txid: BitcoinTxid.describe("Transaction id (= `Evidence.tx_hash`)."),
  outputs: z
    .array(
      out({
        vout: z.int().min(0).describe("Output index."),
        value: BaseUnits.describe("Output value, satoshis."),
        script_pubkey: z
          .string()
          .regex(/^[0-9a-f]{2,200}$/)
          .describe("Output scriptPubKey, hex (`0014…` P2WPKH, `5120…` P2TR)."),
      }).describe("An output paying the destination."),
    )
    .min(1)
    .describe("Outputs of the transaction that pay the destination address."),
  block_height: z.int().min(0).describe("Height of the confirming block (= `Evidence.block_ref`)."),
  block_hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .describe("Hash of the confirming block, hex."),
  confirmations: z.int().min(1).describe("Confirmations when the evidence was accepted (`tip − block_height + 1`)."),
  required_confirmations: z
    .int()
    .min(1)
    .describe(
      "Confirmations the chain profile required for this settlement's USD value (`confirmation_tiers`; 1 for every amount by default, ADR-0022 as amended).",
    ),
}).meta({ id: "BitcoinEvidence", description: "Bitcoin-specific settlement detail (outputs and confirmations)." });
export type BitcoinEvidence = z.infer<typeof BitcoinEvidence>;

// ---------------------------------------------------------------------------------------------
// Pure helpers (checkout manual path, sentinel R4, rails)
// ---------------------------------------------------------------------------------------------

/**
 * Renders base units as an exact decimal string (no exponent, no float): trailing fractional
 * zeros are trimmed and an integral value has no decimal point. `formatBaseUnits("1500000", 6)`
 * = `"1.5"`.
 */
export function formatBaseUnits(amount: string, decimals: number): string {
  if (!/^(0|[1-9][0-9]*)$/.test(amount)) throw new RangeError(`not a base-unit integer string: ${amount}`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new RangeError(`bad decimals: ${decimals}`);
  if (decimals === 0) return amount;
  const padded = amount.padStart(decimals + 1, "0");
  const int = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

/**
 * BIP-21 payment URI for the manual path QR on Bitcoin: `bitcoin:<address>?amount=<BTC>`
 * (amount from satoshis, exact). The address is emitted as given (lower-case bech32).
 */
export function bip21Uri(address: string, amountSats: string): string {
  return `bitcoin:${address}?amount=${formatBaseUnits(amountSats, 8)}`;
}

/**
 * Solana Pay transfer-request URI for the manual path QR on Solana:
 * `solana:<recipient>?amount=<decimal>[&spl-token=<mint>]` (amount from base units, exact; no
 * `reference`, `label`, `message` or `memo` — the 1Click deposit address is unique per quote).
 */
export function solanaPayUri(recipient: string, amountBase: string, decimals: number, splMint: string | null): string {
  const amount = formatBaseUnits(amountBase, decimals);
  return `solana:${recipient}?amount=${amount}${splMint ? `&spl-token=${splMint}` : ""}`;
}

/** Parsed omft bridge asset id `nep141:<blockchain>[-<token>].omft.near` (1Click POA bridge). */
export interface OmftAsset {
  /** 1Click `blockchain` code of the asset's chain (`sol`, `btc`, `eth`, `base`, …). */
  readonly blockchain: string;
  /**
   * `native`: the chain's coin; `evm`: an ERC-20 whose contract is `token`; `hash20`: a token named by
   * 20 bytes of a hash (Solana SPL: `token` = hex(keccak256(mint bytes)[12..32])).
   */
  readonly kind: "native" | "evm" | "hash20";
  /** Contract (`evm`, lower-case `0x…`), hash hex (`hash20`) or null (`native`). */
  readonly token: string | null;
}

/**
 * Parses an omft asset id. Returns null for anything else (NEAR NEP-141 tokens, `nep245:` ids, and the 2026-11
 * `omdep` / `1cs_v1:` shapes). To know which chain an asset lives on, use `parseAssetId` / `assetIdBlockchain`
 * (common/asset-ids.ts, spec 0.5.2), which also read `omdep` and `1cs_v1:` ids and never guess NEAR.
 * Sentinel R4 derives the deposit chain from `blockchain`; checkout reconciles the attested SPL
 * mint with `token` (lld/sentinel.md §16, lld/checkout-and-js.md §5.4).
 */
export function parseOmftAssetId(assetId: string): OmftAsset | null {
  const m = /^nep141:([a-z0-9]+)(?:-(0x[0-9a-f]{40}|[0-9a-f]{40}))?\.omft\.near$/.exec(assetId);
  if (!m) return null;
  const blockchain = m[1] as string;
  const token = m[2] ?? null;
  if (token === null) return { blockchain, kind: "native", token: null };
  return { blockchain, kind: token.startsWith("0x") ? "evm" : "hash20", token };
}

/** A confirmation requirement by settlement value (Bitcoin chain profile, lld/rails.md §21.1). */
export const ConfirmationTier = out({
  below_usd_micros: z
    .int()
    .min(1)
    .nullable()
    .describe("Applies to settlements worth less than this many USD micros; null = no upper bound (last tier)."),
  confirmations: z.int().min(1).max(100).describe("Confirmations required."),
}).meta({ id: "ConfirmationTier", description: "Confirmations required below a USD value." });
export type ConfirmationTier = z.infer<typeof ConfirmationTier>;

/**
 * Confirmations required for a settlement worth `usdMicros`: the first tier whose
 * `below_usd_micros` is null or greater than the value. Tiers are ordered ascending.
 */
export function requiredConfirmations(tiers: readonly ConfirmationTier[], usdMicros: bigint): number {
  for (const t of tiers)
    if (t.below_usd_micros === null || usdMicros < BigInt(t.below_usd_micros)) return t.confirmations;
  throw new RangeError("confirmation tiers must end with an unbounded tier");
}

/**
 * Default Bitcoin-family confirmations (BTC; LTC/DOGE profiles): ONE confirmation for every amount
 * (ADR-0022 as amended by the owner 2026-11-10 17:10 — every chain confirms on one block of its own
 * consensus). Rails uses this when a profile sets no `confirmation_tiers`. Spec 0.4.2.
 */
export const BITCOIN_DEFAULT_CONFIRMATION_TIERS: readonly ConfirmationTier[] = Object.freeze([
  { below_usd_micros: null, confirmations: 1 },
]);

/**
 * The Stage 4 USD tiers (lld/rails.md §21.1): 1 confirmation below USD 1,000, else 2. No longer the
 * default since ADR-0022 as amended (see {@link BITCOIN_DEFAULT_CONFIRMATION_TIERS}); kept unchanged for
 * profiles that opt back in via `confirmation_tiers` and for sentinel's stricter independent audit.
 */
export const BITCOIN_CONFIRMATION_TIERS: readonly ConfirmationTier[] = Object.freeze([
  { below_usd_micros: 1_000_000_000, confirmations: 1 },
  { below_usd_micros: null, confirmations: 2 },
]);
// end stage 4 — chains
