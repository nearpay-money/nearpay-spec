/**
 * Scalar wire types shared across public, internal, event and x402 contracts
 * (lld/00-foundations.md §6, architecture/api-conventions.md §2–§3).
 */
import { z } from "./schema.js";

/** Largest integer representable exactly in a JSON number (2^53 − 1). */
export const MAX_SAFE_INTEGER = 9007199254740991;

// ---------------------------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------------------------

/** Unix time in seconds. Used by merchant-facing objects (`created`, `expires_at`, …). */
export const UnixTime = z.int().min(0).max(MAX_SAFE_INTEGER).describe("Unix time in seconds.");

/** RFC 3339 / ISO 8601 UTC timestamp. Used by payer, attestation, internal and event contracts. */
export const Timestamp = z.iso
  .datetime({ offset: false })
  .describe("RFC 3339 UTC timestamp, e.g. `2026-11-05T10:00:00.000Z`.");

// ---------------------------------------------------------------------------------------------
// Money (INV-5): integers only; asset base units are decimal strings
// ---------------------------------------------------------------------------------------------

/** Fiat amount in minor units of its currency (JSON integer ≤ 2^53 − 1). */
export const FiatAmount = z
  .int()
  .min(0)
  .max(MAX_SAFE_INTEGER)
  .describe("Fiat amount in minor units (e.g. cents), integer.");

/** ISO 4217 currency code, lower-case. */
export const Currency = z
  .string()
  .regex(/^[a-z]{3}$/, "must be a lower-case ISO 4217 code")
  .describe("ISO 4217 currency code, lower-case (e.g. `usd`).");

/** Base units of an asset as a decimal string (base units can exceed 2^53 and even 2^64). */
export const BaseUnits = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/, "must be a non-negative integer string of at most 78 digits")
  .describe("Asset amount in base units as a decimal string (no sign, no decimals, ≤ 78 digits).");

/** Basis points 0–10 000. */
export const Bps = z.int().min(0).max(10_000).describe("Basis points (1/100 of a percent), 0–10 000.");

// ---------------------------------------------------------------------------------------------
// Chains, accounts and assets
// ---------------------------------------------------------------------------------------------

const NEAR_ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const NEAR_ACCOUNT_SRC = "(([a-z\\d]+[-_])*[a-z\\d]+\\.)*([a-z\\d]+[-_])*[a-z\\d]+";

/** NEAR account id (named, implicit 64-hex or `0x…` eth-implicit). */
export const NearAccountId = z
  .string()
  .regex(NEAR_ACCOUNT_RE, "must be a valid NEAR account id")
  .describe("NEAR account id (named, implicit or eth-implicit), 2–64 chars.");

/**
 * NEAR Intents asset id: `nep141:<token account>` or `nep245:<token account>:<token id>`.
 * The token account follows NEAR account-id rules.
 */
export const AssetId = z
  .string()
  .regex(
    new RegExp(`^(nep141:${NEAR_ACCOUNT_SRC}|nep245:${NEAR_ACCOUNT_SRC}:[\\x21-\\x7e]{1,128})$`),
    "must be a NEAR Intents asset id (nep141:… or nep245:…)",
  )
  .max(256)
  .meta({
    description:
      "NEAR Intents asset id, e.g. `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`.",
    examples: ["nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"],
  });

/** CAIP-2 chain id (`eip155:8453`, `near:mainnet`, `solana:5eykt4Us…`, `bip122:…`). */
export const ChainId = z
  .string()
  .regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/, "must be a CAIP-2 chain id")
  .meta({ description: "CAIP-2 chain id, e.g. `eip155:8453` or `near:mainnet`.", examples: ["eip155:8453"] });

/** 1Click `blockchain` code (`near`, `eth`, `base`, `arb`, `sol`, `btc`, …). */
export const BlockchainCode = z
  .string()
  .regex(/^[a-z0-9_-]{2,32}$/)
  .describe("1Click `blockchain` code, e.g. `base` or `near`.");

/** Address on any chain, in that chain's canonical text form. Validation per chain lives in kit `chains`. */
export const ChainAddress = z.string().min(1).max(256).describe("Address in the chain's canonical text form.");

/** Transaction hash (hex for EVM, base58 for NEAR, …). */
export const TxHash = z.string().min(8).max(128).describe("Transaction hash in the chain's text form.");

/** NEAR Intents memo binding (`np1:` + base58 sha256). */
export const Binding = z
  .string()
  .regex(/^np1:[1-9A-HJ-NP-Za-km-z]{43,44}$/, "must be an np1 binding")
  .describe("Binding memo `np1:` + base58(sha256(…)) tying a signed transfer to one requirement.");

/** HTTPS URL (http allowed only where a field says so). */
export const Url = z.url().max(2048).describe("Absolute URL.");

/** Two-letter ISO 3166-1 alpha-2 country code, upper-case. */
export const CountryCode = z
  .string()
  .regex(/^[A-Z]{2}$/)
  .describe("ISO 3166-1 alpha-2 country code, upper-case.");

/** Merchant metadata: ≤ 50 keys, key ≤ 40 chars, value ≤ 500 chars (api-conventions §2). */
export const Metadata = z
  .record(z.string().min(1).max(40), z.string().max(500))
  .refine((m) => Object.keys(m).length <= 50, { message: "metadata may have at most 50 keys" })
  .describe("Up to 50 key/value pairs (key ≤ 40 chars, value ≤ 500 chars) for your own use.");

/** Settlement value as shown to merchants (api-conventions §3). */
export const SettlementValue = z
  .looseObject({
    amount: BaseUnits,
    asset_id: AssetId,
    decimals: z.int().min(0).max(255).describe("Decimals of the asset."),
    display: z.string().describe("Human-readable amount, e.g. `25.00 USDC (Base)`."),
  })
  .meta({ id: "SettlementValue", description: "An amount of an asset with display information." });

/** `livemode` flag present on every merchant object. */
export const Livemode = z.boolean().describe("`true` for live mode, `false` for test mode.");

/** A NEAR public key `ed25519:<base58>` or `secp256k1:<base58>`. */
export const CurvePublicKey = z
  .string()
  .regex(/^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{32,90}$/)
  .describe("Public key `<curve>:<base58>`.");

/** A signature `ed25519:<base58>` or `secp256k1:<base58>`. */
export const CurveSignature = z
  .string()
  .regex(/^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{64,100}$/)
  .describe("Signature `<curve>:<base58>`.");

/** base64url without padding. */
export const Base64Url = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .describe("base64url without padding.");
