/**
 * Stage 4 chain-coverage test vectors (Solana and Bitcoin as Tier A chains; lld/rails.md §21,
 * lld/identity.md §8.2, lld/sentinel.md §16, lld/checkout-and-js.md §5.4, lld/sandbox.md §10):
 *
 *   chains-solana-bitcoin.json   chain profiles, assets, address rules, omft ids, payment URIs,
 *                                evidence parsing (rails watchers/verifiers ↔ sentinel audit ↔ kit chains)
 *   destination-attestation.json challenge message, Solana ed25519 and BIP-322 "simple" (P2WPKH, P2TR)
 *                                ownership signatures (dashboard signer ↔ identity verifier)
 *   solana-transfer.json         checkout wallet-path instructions (SOL transfer, SPL transferChecked)
 *
 * Built with @noble/curves + @noble/hashes; `test/vectors-chains.test.ts` re-verifies every file with
 * independent libraries (@scure/btc-signer, @scure/base) and the upstream BIP-322 vectors. Keys are
 * TEST-ONLY seeds derived from fixed strings.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bech32, bech32m } from "@scure/base";
import bs58 from "bs58";
import { ChainProfile } from "../src/internal-entry.js";
import {
  BITCOIN_CONFIRMATION_TIERS,
  BITCOIN_DEFAULT_CONFIRMATION_TIERS,
  BITCOIN_MAINNET,
  bip21Uri,
  Evidence,
  formatBaseUnits,
  parseOmftAssetId,
  requiredConfirmations,
  SOLANA_MAINNET,
  solanaPayUri,
} from "../src/public-entry.js";

const enc = new TextEncoder();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const fromHex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
/** Test-only 32-byte seed: sha256("nearpay test vector: <label>"). */
const seed = (label: string) => sha256(enc.encode(`nearpay test vector: ${label}`));

// =============================================================================================
// Solana primitives
// =============================================================================================

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

export function onCurve(b: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(b);
    return true;
  } catch {
    return false;
  }
}

/** `findProgramAddress`: highest bump whose sha256(seeds‖bump‖program‖"ProgramDerivedAddress") is off-curve. */
export function findProgramAddress(seeds: Uint8Array[], programId: string): { address: string; bump: number } {
  const program = bs58.decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(concat(...seeds, Uint8Array.of(bump), program, enc.encode("ProgramDerivedAddress")));
    if (!onCurve(h)) return { address: bs58.encode(h), bump };
  }
  throw new Error("no program address");
}

export function associatedTokenAddress(owner: string, mint: string, tokenProgram = TOKEN_PROGRAM) {
  return findProgramAddress([bs58.decode(owner), bs58.decode(tokenProgram), bs58.decode(mint)], ATA_PROGRAM);
}

/** omft asset id of an SPL mint: `nep141:sol-` + hex(keccak256(mint bytes)[12..32]) + `.omft.near`. */
export function splOmftAssetId(mint: string): string {
  return `nep141:sol-${hex(keccak_256(bs58.decode(mint)).subarray(12))}.omft.near`;
}

const solKey = (label: string) => {
  const s = seed(label);
  return { seed: s, address: bs58.encode(ed25519.getPublicKey(s)) };
};

// =============================================================================================
// Bitcoin primitives (BIP-173/350 addresses, BIP-322 simple)
// =============================================================================================

const sha256d = (b: Uint8Array) => sha256(sha256(b));
const hash160 = (b: Uint8Array) => ripemd160(sha256(b));
const u32le = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const u64le = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};
const varint = (n: number) => (n < 0xfd ? Uint8Array.of(n) : concat(Uint8Array.of(0xfd), u32le(n).subarray(0, 2)));
const varbytes = (b: Uint8Array) => concat(varint(b.length), b);
const taggedHash = (tag: string, ...msgs: Uint8Array[]) => {
  const t = sha256(enc.encode(tag));
  return sha256(concat(t, t, ...msgs));
};

export function segwitAddress(version: 0 | 1, program: Uint8Array, hrp = "bc"): string {
  const words = [version, ...bech32.toWords(program)];
  return version === 0 ? bech32.encode(hrp, words) : bech32m.encode(hrp, words);
}

/** scriptPubKey of a lower-case P2WPKH / P2TR address. */
export function segwitScript(address: string): Uint8Array {
  const v1 = address.startsWith("bc1p");
  const d = (v1 ? bech32m : bech32).decode(address as `${string}1${string}`);
  const version = d.words[0] as number;
  const program = (v1 ? bech32m : bech32).fromWords(d.words.slice(1));
  return concat(Uint8Array.of(version === 0 ? 0x00 : 0x50 + version, program.length), program);
}

export const bip322MessageHash = (message: string) => taggedHash("BIP0322-signed-message", enc.encode(message));

/** The virtual `to_spend` transaction (BIP-322), serialized, and its txid (display order). */
export function bip322ToSpend(scriptPubKey: Uint8Array, message: string) {
  const raw = concat(
    u32le(0),
    varint(1),
    new Uint8Array(32),
    u32le(0xffffffff),
    varbytes(concat(Uint8Array.of(0x00, 0x20), bip322MessageHash(message))),
    u32le(0),
    varint(1),
    u64le(0n),
    varbytes(scriptPubKey),
    u32le(0),
  );
  const hash = sha256d(raw);
  return { raw, hash, txid: hex(hash.slice().reverse()) };
}

const OP_RETURN_SCRIPT = Uint8Array.of(0x6a);

/** `to_sign` without witness (its txid is what BIP-322 lists). */
export function bip322ToSignTxid(toSpendHash: Uint8Array): string {
  const raw = concat(
    u32le(0),
    varint(1),
    toSpendHash,
    u32le(0),
    varint(0),
    u32le(0),
    varint(1),
    u64le(0n),
    varbytes(OP_RETURN_SCRIPT),
    u32le(0),
  );
  return hex(sha256d(raw).reverse());
}

/** BIP-143 sighash of `to_sign` input 0 for a P2WPKH program (amount 0). */
export function bip322SighashP2wpkh(toSpendHash: Uint8Array, program: Uint8Array, hashType: number): Uint8Array {
  const outpoint = concat(toSpendHash, u32le(0));
  const scriptCode = concat(Uint8Array.of(0x19, 0x76, 0xa9, 0x14), program, Uint8Array.of(0x88, 0xac));
  const preimage = concat(
    u32le(0),
    sha256d(outpoint),
    sha256d(u32le(0)),
    outpoint,
    scriptCode,
    u64le(0n),
    u32le(0),
    sha256d(concat(u64le(0n), varbytes(OP_RETURN_SCRIPT))),
    u32le(0),
    u32le(hashType),
  );
  return sha256d(preimage);
}

/** BIP-341 key-path sighash of `to_sign` input 0 (amount 0, no annex). */
export function bip322SighashP2tr(toSpendHash: Uint8Array, scriptPubKey: Uint8Array, hashType: number): Uint8Array {
  const msg = concat(
    Uint8Array.of(0x00, hashType),
    u32le(0),
    u32le(0),
    sha256(concat(toSpendHash, u32le(0))),
    sha256(u64le(0n)),
    sha256(varbytes(scriptPubKey)),
    sha256(u32le(0)),
    sha256(concat(u64le(0n), varbytes(OP_RETURN_SCRIPT))),
    Uint8Array.of(0x00),
    u32le(0),
  );
  return taggedHash("TapSighash", msg);
}

const serializeWitness = (items: Uint8Array[]) => concat(varint(items.length), ...items.map(varbytes));

export function parseWitness(b: Uint8Array): Uint8Array[] | null {
  let o = 0;
  const readVar = () => {
    const f = b[o++];
    if (f === undefined) throw new Error("eof");
    if (f < 0xfd) return f;
    if (f === 0xfd) {
      const v = (b[o] as number) | ((b[o + 1] as number) << 8);
      o += 2;
      return v;
    }
    throw new Error("varint too large");
  };
  try {
    const n = readVar();
    const items: Uint8Array[] = [];
    for (let i = 0; i < n; i++) {
      const len = readVar();
      if (o + len > b.length) return null;
      items.push(b.slice(o, o + len));
      o += len;
    }
    return o === b.length ? items : null;
  } catch {
    return null;
  }
}

const N = secp256k1.Point.Fn.ORDER;
const modN = (x: bigint) => ((x % N) + N) % N;
const toBig = (b: Uint8Array) => BigInt(`0x${hex(b)}`);
const toBytes32 = (x: bigint) => fromHex(x.toString(16).padStart(64, "0"));

/** Taproot output key (BIP-86 style, no script tree) and the tweaked secret key. */
export function taprootKeys(secret: Uint8Array) {
  const P = secp256k1.Point.BASE.multiply(toBig(secret));
  const px = toBytes32(P.toAffine().x);
  const t = toBig(taggedHash("TapTweak", px));
  const d = P.toAffine().y % 2n === 0n ? toBig(secret) : N - toBig(secret);
  const Q = secp256k1.Point.fromAffine(schnorr.utils.lift_x(toBig(px)).toAffine()).add(
    secp256k1.Point.BASE.multiply(t),
  );
  return { outputKey: toBytes32(Q.toAffine().x), tweakedSecret: toBytes32(modN(d + t)) };
}

/** BIP-322 simple signature (base64 witness) for a P2WPKH or P2TR address of `secret`. */
export function bip322Sign(secret: Uint8Array, type: "p2wpkh" | "p2tr", message: string): string {
  if (type === "p2wpkh") {
    const pub = secp256k1.getPublicKey(secret, true);
    const program = hash160(pub);
    const toSpend = bip322ToSpend(concat(Uint8Array.of(0x00, 0x14), program), message);
    const sighash = bip322SighashP2wpkh(toSpend.hash, program, 0x01);
    const der = secp256k1.sign(sighash, secret, { prehash: false, format: "der", lowS: true });
    return b64(serializeWitness([concat(der, Uint8Array.of(0x01)), pub]));
  }
  const { outputKey, tweakedSecret } = taprootKeys(secret);
  const spk = concat(Uint8Array.of(0x51, 0x20), outputKey);
  const toSpend = bip322ToSpend(spk, message);
  const sighash = bip322SighashP2tr(toSpend.hash, spk, 0x00);
  const sig = schnorr.sign(sighash, tweakedSecret, new Uint8Array(32));
  return b64(serializeWitness([sig]));
}

/** Reference BIP-322 simple verifier for P2WPKH / P2TR (the rules identity implements). */
export function bip322Verify(address: string, message: string, signatureB64: string): { ok: boolean; reason?: string } {
  let spk: Uint8Array;
  try {
    spk = segwitScript(address.toLowerCase());
  } catch {
    return { ok: false, reason: "address is not P2WPKH or P2TR" };
  }
  const witness = parseWitness(new Uint8Array(Buffer.from(signatureB64, "base64")));
  if (!witness) return { ok: false, reason: "not a simple-encoded witness stack" };
  const toSpend = bip322ToSpend(spk, message);
  if (spk[0] === 0x00 && spk[1] === 0x14) {
    if (witness.length !== 2) return { ok: false, reason: "P2WPKH witness must be [signature, pubkey]" };
    const [sig, pub] = witness as [Uint8Array, Uint8Array];
    if (pub.length !== 33 || hex(hash160(pub)) !== hex(spk.subarray(2)))
      return { ok: false, reason: "pubkey mismatch" };
    if (sig[sig.length - 1] !== 0x01) return { ok: false, reason: "sighash type must be SIGHASH_ALL" };
    const sighash = bip322SighashP2wpkh(toSpend.hash, spk.subarray(2), 0x01);
    try {
      const ok = secp256k1.verify(sig.subarray(0, -1), sighash, pub, { prehash: false, format: "der", lowS: false });
      return ok ? { ok } : { ok, reason: "bad signature" };
    } catch {
      return { ok: false, reason: "bad signature encoding" };
    }
  }
  if (spk[0] === 0x51 && spk[1] === 0x20) {
    if (witness.length !== 1) return { ok: false, reason: "P2TR key-path witness must be [signature]" };
    const sig = witness[0] as Uint8Array;
    if (sig.length !== 64 && !(sig.length === 65 && sig[64] === 0x01))
      return { ok: false, reason: "sighash type must be SIGHASH_DEFAULT or SIGHASH_ALL" };
    const sighash = bip322SighashP2tr(toSpend.hash, spk, sig.length === 64 ? 0x00 : 0x01);
    const ok = schnorr.verify(sig.subarray(0, 64), sighash, spk.subarray(2));
    return ok ? { ok } : { ok, reason: "bad signature" };
  }
  return { ok: false, reason: "address is not P2WPKH or P2TR" };
}

const btcKey = (label: string) => {
  const secret = seed(label);
  const pub = secp256k1.getPublicKey(secret, true);
  return {
    secret,
    pub,
    p2wpkh: segwitAddress(0, hash160(pub)),
    p2tr: segwitAddress(1, taprootKeys(secret).outputKey),
  };
};

// =============================================================================================
// Assets and chain profiles
// =============================================================================================

export const USDC_SOL_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_SOL_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

/** Live 1Click `/v0/tokens` entries (recorded 2026-11-06, rails fixture `oneclick/tokens.json`). */
const ASSETS = [
  {
    asset_id: "nep141:sol.omft.near",
    chain: SOLANA_MAINNET,
    blockchain: "sol",
    symbol: "SOL",
    decimals: 9,
    token: { standard: "native", address: null },
    token_program: null,
  },
  {
    asset_id: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    chain: SOLANA_MAINNET,
    blockchain: "sol",
    symbol: "USDC",
    decimals: 6,
    token: { standard: "spl", address: USDC_SOL_MINT },
    token_program: TOKEN_PROGRAM,
  },
  {
    asset_id: "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near",
    chain: SOLANA_MAINNET,
    blockchain: "sol",
    symbol: "USDT",
    decimals: 6,
    token: { standard: "spl", address: USDT_SOL_MINT },
    token_program: TOKEN_PROGRAM,
  },
  {
    asset_id: "nep141:btc.omft.near",
    chain: BITCOIN_MAINNET,
    blockchain: "btc",
    symbol: "BTC",
    decimals: 8,
    token: { standard: "native", address: null },
    token_program: null,
  },
] as const;

function chainProfiles() {
  return [
    ChainProfile.parse({
      chain: SOLANA_MAINNET,
      blockchain: "sol",
      family: "solana",
      tier: "A",
      min_deadline_s: 300,
      default_deadline_s: 1800,
      finality: "solana: confirmed commitment",
      verification_timeout_s: 1800,
      memo_mode: "none",
      explorer_tx_url: "https://solscan.io/tx/{tx}",
      explorer_address_url: "https://solscan.io/account/{address}",
      confirmation_tiers: null,
    }),
    ChainProfile.parse({
      chain: BITCOIN_MAINNET,
      blockchain: "btc",
      family: "bitcoin",
      tier: "A",
      min_deadline_s: 3600,
      default_deadline_s: 7200,
      finality: "bitcoin: 1 confirmation",
      verification_timeout_s: 7200,
      memo_mode: "none",
      explorer_tx_url: "https://mempool.space/tx/{tx}",
      explorer_address_url: "https://mempool.space/address/{address}",
      confirmation_tiers: BITCOIN_DEFAULT_CONFIRMATION_TIERS,
    }),
  ];
}

// =============================================================================================
// chains-solana-bitcoin.json
// =============================================================================================

function addressCases() {
  const payer = solKey("solana payer");
  const ata = associatedTokenAddress(payer.address, USDC_SOL_MINT).address;
  const zero31 = bs58.encode(new Uint8Array(31).fill(7));
  const zero33 = bs58.encode(new Uint8Array(33).fill(7));
  const solana = [
    { address: payer.address, note: "test wallet (ed25519 public key)" },
    { address: USDC_SOL_MINT, note: "USDC mint" },
    { address: SYSTEM_PROGRAM, note: "System Program (32 zero bytes), the sandbox simulated payer" },
    { address: ata, note: "an associated token account (program-derived, off-curve)" },
  ].map((c) => {
    const raw = bs58.decode(c.address);
    if (raw.length !== 32) throw new Error("bad solana vector");
    return { chain: SOLANA_MAINNET, ...c, valid: true, normalized: c.address, on_curve: onCurve(raw) };
  });
  const solanaInvalid = [
    { address: zero31, reason: "decodes to 31 bytes" },
    { address: zero33, reason: "decodes to 33 bytes" },
    { address: `${payer.address.slice(0, -1)}0`, reason: "not base58 (contains 0)" },
    { address: `${payer.address.slice(0, -1)}l`, reason: "not base58 (contains l)" },
    { address: ` ${payer.address}`, reason: "padded" },
    { address: "", reason: "empty" },
  ].map((c) => ({ chain: SOLANA_MAINNET, ...c, valid: false }));

  const k = btcKey("bitcoin destination");
  const legacyP2pkh = (() => {
    const payload = concat(Uint8Array.of(0x00), hash160(k.pub));
    return bs58.encode(concat(payload, sha256d(payload).subarray(0, 4)));
  })();
  const p2shP2wpkh = (() => {
    const redeem = concat(Uint8Array.of(0x00, 0x14), hash160(k.pub));
    const payload = concat(Uint8Array.of(0x05), hash160(redeem));
    return bs58.encode(concat(payload, sha256d(payload).subarray(0, 4)));
  })();
  const p2wsh = segwitAddress(0, sha256(concat(Uint8Array.of(0x21), k.pub, Uint8Array.of(0xac))));
  const flip = (a: string) => `${a.slice(0, -1)}${a.endsWith("q") ? "p" : "q"}`;
  const v1AsBech32 = bech32.encode("bc", [1, ...bech32.toWords(taprootKeys(k.secret).outputKey)]);
  const bitcoin = [
    { address: k.p2wpkh, valid: true, type: "p2wpkh", destination_allowed: true, normalized: k.p2wpkh },
    { address: k.p2tr, valid: true, type: "p2tr", destination_allowed: true, normalized: k.p2tr },
    {
      address: k.p2wpkh.toUpperCase(),
      valid: true,
      type: "p2wpkh",
      destination_allowed: true,
      normalized: k.p2wpkh,
      note: "upper-case bech32 is valid and normalises to lower case",
    },
    { address: "bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l", valid: true, type: "p2wpkh", destination_allowed: true },
    { address: legacyP2pkh, valid: true, type: "p2pkh", destination_allowed: false, normalized: legacyP2pkh },
    { address: p2shP2wpkh, valid: true, type: "p2sh", destination_allowed: false, normalized: p2shP2wpkh },
    { address: p2wsh, valid: true, type: "p2wsh", destination_allowed: false, normalized: p2wsh },
    { address: flip(k.p2wpkh), valid: false, reason: "bech32 checksum mismatch" },
    { address: flip(k.p2tr), valid: false, reason: "bech32m checksum mismatch" },
    { address: v1AsBech32, valid: false, reason: "witness v1 encoded with bech32 instead of bech32m" },
    { address: `${k.p2wpkh.slice(0, 6)}${k.p2wpkh.slice(6).toUpperCase()}`, valid: false, reason: "mixed case" },
    { address: segwitAddress(0, hash160(k.pub), "tb"), valid: false, reason: "testnet HRP (tb)" },
  ].map((c) => {
    const n = (c as { normalized?: string }).normalized;
    return { chain: BITCOIN_MAINNET, ...c, ...(c.valid && !n ? { normalized: c.address } : {}) };
  });
  return {
    rules: {
      solana:
        "valid = base58 (Bitcoin alphabet) decoding to exactly 32 bytes; normalized = as given. on_curve is informational: an off-curve (program-derived) address cannot sign the ownership attestation, so it can only become an `unverified` destination (identity §5 mark_unverified).",
      bitcoin:
        "valid = BIP-173 bech32 (witness v0) / BIP-350 bech32m (v1+) with HRP `bc`, single case, or base58check P2PKH (version 0x00) / P2SH (0x05); normalized = lower-case for bech32, as given for base58. Destinations: `p2wpkh` and `p2tr` only (`destination_allowed`), refused otherwise with `address_invalid`; payer refund addresses: any valid type.",
    },
    solana: [...solana, ...solanaInvalid],
    bitcoin,
  };
}

function omftCases() {
  const cases = [
    ...ASSETS.map((a) => a.asset_id),
    "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    "nep245:v2_1.omni.hot.tg:56_11111111111111111111",
  ].map((asset_id) => ({ asset_id, parsed: parseOmftAssetId(asset_id) }));
  const spl = [USDC_SOL_MINT, USDT_SOL_MINT].map((mint) => ({
    mint,
    keccak256_hex: hex(keccak_256(bs58.decode(mint))),
    asset_id: splOmftAssetId(mint),
  }));
  for (const a of ASSETS)
    if (a.token.standard === "spl" && splOmftAssetId(a.token.address) !== a.asset_id)
      throw new Error(`omft rule broken for ${a.asset_id}`);
  return {
    rule: "nep141:<1Click blockchain code>[-<token>].omft.near. <token> absent = the chain's native coin; `0x<40 hex>` = an EVM contract; 40 hex = hex(keccak256(raw 32 mint bytes)[12..32]) for a Solana SPL mint (checked against all 12 `sol-` omft entries of the live registry, 2026-11-06). Checkout and sentinel accept an attested SPL mint only if it reproduces the asset id.",
    cases,
    spl_mints: spl,
  };
}

function uriCases() {
  return {
    rule: "Manual-path QR (checkout §5.5): Bitcoin BIP-21 `bitcoin:<address>?amount=<BTC>`; Solana Pay transfer request `solana:<recipient>?amount=<decimal>[&spl-token=<mint>]`. Amounts are exact decimals of the attested base units: trailing zeros trimmed, no exponent, no thousands separator.",
    format_base_units: [
      ["0", 6],
      ["1", 8],
      ["1500000", 6],
      ["25012345", 6],
      ["100000000", 8],
      ["123", 0],
      ["1000000000", 9],
      ["999999999999999999999999", 24],
    ].map(([amount, decimals]) => ({
      amount,
      decimals,
      decimal: formatBaseUnits(amount as string, decimals as number),
    })),
    bip21: [
      { address: btcKey("bitcoin destination").p2wpkh, amount_sats: "123450" },
      { address: btcKey("bitcoin destination").p2tr, amount_sats: "100000000" },
    ].map((c) => ({ ...c, uri: bip21Uri(c.address, c.amount_sats) })),
    solana_pay: [
      { recipient: solKey("solana deposit").address, amount_base: "25012345", decimals: 6, spl_mint: USDC_SOL_MINT },
      { recipient: solKey("solana deposit").address, amount_base: "1500000000", decimals: 9, spl_mint: null },
    ].map((c) => ({ ...c, uri: solanaPayUri(c.recipient, c.amount_base, c.decimals, c.spl_mint) })),
  };
}

const sig58 = (label: string) => bs58.encode(ed25519.sign(enc.encode(label), seed("solana tx signer")));
const hash32 = (label: string) => hex(seed(label));

function solanaEvidenceCases() {
  const merchant = solKey("solana merchant").address;
  const solver = solKey("solana solver").address;
  const merchantAta = associatedTokenAddress(merchant, USDC_SOL_MINT).address;
  const solverAta = associatedTokenAddress(solver, USDC_SOL_MINT).address;
  const usdc = ASSETS[1];
  const tb = (accountIndex: number, owner: string, amount: string) => ({
    accountIndex,
    mint: USDC_SOL_MINT,
    owner,
    programId: TOKEN_PROGRAM,
    uiTokenAmount: { amount, decimals: 6 },
  });
  const ev = (o: {
    sig: string;
    slot: number;
    asset_id: string;
    amount: string;
    mint: string | null;
    token_accounts: string[];
    pre: string;
    post: string;
  }) =>
    Evidence.parse({
      chain: SOLANA_MAINNET,
      tx_hash: o.sig,
      block_ref: String(o.slot),
      recipient: merchant,
      asset_id: o.asset_id,
      amount: o.amount,
      finality: "confirmed",
      tier: "A",
      source: "verifier",
      observed_at: "2026-11-08T12:00:30.000Z",
      explorer_url: `https://solscan.io/tx/${o.sig}`,
      sender: null,
      solana: {
        signature: o.sig,
        slot: o.slot,
        block_time: 1_794_139_200,
        mint: o.mint,
        token_program: o.mint ? TOKEN_PROGRAM : null,
        owner: merchant,
        token_accounts: o.token_accounts,
        pre_amount: o.pre,
        post_amount: o.post,
      },
      bitcoin: null,
    });
  const s1 = sig58("usdc payout, ata exists");
  const s2 = sig58("usdc payout, ata created");
  const s3 = sig58("sol payout");
  const s4 = sig58("failed tx");
  const keys = [solver, solverAta, merchantAta, merchant, USDC_SOL_MINT, TOKEN_PROGRAM];
  return {
    rule: "getTransaction(signature, {commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'jsonParsed'}) — `confirmed` is Solana's one-block confirmation (ADR-0022 as amended; `processed` never counts; a post-success re-check reads `finalized`); require meta.err == null. SPL: amount = Σ post − Σ pre of the token balances whose `owner` = recipient and `mint` = the asset's mint (a missing pre entry counts 0: the ATA was created in the transaction). SOL: amount = postBalances[i] − preBalances[i] at the recipient's account index (static keys then loadedAddresses.writable, loadedAddresses.readonly). Compare with amount_out_expected: ≥ → pass, 0 < amount < expected → short, else mismatch (rails §8.8).",
    expected_amount: "25000000",
    cases: [
      {
        name: "USDC payout to an existing ATA",
        rpc_result: {
          slot: 380_000_001,
          blockTime: 1_794_139_200,
          meta: {
            err: null,
            preBalances: [5_000_000_000, 2_039_280, 2_039_280, 1_000_000_000, 1_461_600, 1],
            postBalances: [4_999_995_000, 2_039_280, 2_039_280, 1_000_000_000, 1_461_600, 1],
            preTokenBalances: [tb(1, solver, "900000000"), tb(2, merchant, "10000000")],
            postTokenBalances: [tb(1, solver, "875000000"), tb(2, merchant, "35000000")],
          },
          transaction: { signatures: [s1], message: { accountKeys: keys } },
        },
        result: "pass",
        evidence: ev({
          sig: s1,
          slot: 380_000_001,
          asset_id: usdc.asset_id,
          amount: "25000000",
          mint: USDC_SOL_MINT,
          token_accounts: [merchantAta],
          pre: "10000000",
          post: "35000000",
        }),
      },
      {
        name: "USDC payout creating the ATA in the same transaction",
        rpc_result: {
          slot: 380_000_002,
          blockTime: 1_794_139_200,
          meta: {
            err: null,
            preBalances: [5_000_000_000, 2_039_280, 0, 1_000_000_000, 1_461_600, 1],
            postBalances: [4_997_955_720, 2_039_280, 2_039_280, 1_000_000_000, 1_461_600, 1],
            preTokenBalances: [tb(1, solver, "900000000")],
            postTokenBalances: [tb(1, solver, "875000000"), tb(2, merchant, "25000000")],
          },
          transaction: { signatures: [s2], message: { accountKeys: keys } },
        },
        result: "pass",
        evidence: ev({
          sig: s2,
          slot: 380_000_002,
          asset_id: usdc.asset_id,
          amount: "25000000",
          mint: USDC_SOL_MINT,
          token_accounts: [merchantAta],
          pre: "0",
          post: "25000000",
        }),
      },
      {
        name: "SOL payout (lamports delta at the recipient's index)",
        expected_amount: "1500000000",
        rpc_result: {
          slot: 380_000_003,
          blockTime: 1_794_139_200,
          meta: {
            err: null,
            preBalances: [9_000_000_000, 250_000_000, 1],
            postBalances: [7_499_995_000, 1_750_000_000, 1],
            preTokenBalances: [],
            postTokenBalances: [],
          },
          transaction: { signatures: [s3], message: { accountKeys: [solver, merchant, SYSTEM_PROGRAM] } },
        },
        result: "pass",
        evidence: ev({
          sig: s3,
          slot: 380_000_003,
          asset_id: ASSETS[0].asset_id,
          amount: "1500000000",
          mint: null,
          token_accounts: [],
          pre: "250000000",
          post: "1750000000",
        }),
      },
      {
        name: "failed transaction (meta.err set): no evidence, keep retrying until the timeout",
        rpc_result: {
          slot: 380_000_004,
          blockTime: 1_794_139_200,
          meta: {
            err: { InstructionError: [1, { Custom: 1 }] },
            preBalances: [5_000_000_000, 2_039_280, 2_039_280, 1_000_000_000, 1_461_600, 1],
            postBalances: [4_999_995_000, 2_039_280, 2_039_280, 1_000_000_000, 1_461_600, 1],
            preTokenBalances: [tb(1, solver, "900000000"), tb(2, merchant, "10000000")],
            postTokenBalances: [tb(1, solver, "900000000"), tb(2, merchant, "10000000")],
          },
          transaction: { signatures: [s4], message: { accountKeys: keys } },
        },
        result: "mismatch",
        evidence: null,
      },
    ],
  };
}

function bitcoinEvidenceCases() {
  const merchant = btcKey("bitcoin merchant").p2wpkh;
  const spk = hex(segwitScript(merchant));
  const other = btcKey("bitcoin solver").p2tr;
  const otherSpk = hex(segwitScript(other));
  const blockHash = hash32("btc block 900000");
  const tx = (label: string, outs: Array<[string, string, number]>, height: number | null) => ({
    txid: hash32(label),
    vout: outs.map(([address, script, value]) => ({
      scriptpubkey: script,
      scriptpubkey_address: address,
      scriptpubkey_type: script.startsWith("0014") ? "v0_p2wpkh" : "v1_p2tr",
      value,
    })),
    status: height === null ? { confirmed: false } : { confirmed: true, block_height: height, block_hash: blockHash },
  });
  const ev = (t: ReturnType<typeof tx>, tip: number, usdMicros: bigint) => {
    const outs = t.vout
      .map((o, vout) => ({ vout, value: String(o.value), script_pubkey: o.scriptpubkey, addr: o.scriptpubkey_address }))
      .filter((o) => o.addr === merchant)
      .map(({ addr: _a, ...o }) => o);
    const height = (t.status as { block_height: number }).block_height;
    return Evidence.parse({
      chain: BITCOIN_MAINNET,
      tx_hash: t.txid,
      block_ref: String(height),
      recipient: merchant,
      asset_id: "nep141:btc.omft.near",
      amount: String(outs.reduce((n, o) => n + BigInt(o.value), 0n)),
      finality: "confirmed",
      tier: "A",
      source: "verifier",
      observed_at: "2026-11-08T12:30:00.000Z",
      explorer_url: `https://mempool.space/tx/${t.txid}`,
      sender: null,
      solana: null,
      bitcoin: {
        txid: t.txid,
        outputs: outs,
        block_height: height,
        block_hash: blockHash,
        confirmations: tip - height + 1,
        required_confirmations: requiredConfirmations(BITCOIN_DEFAULT_CONFIRMATION_TIERS, usdMicros),
      },
    });
  };
  const small = tx(
    "btc payout small",
    [
      [merchant, spk, 625_000],
      [other, otherSpk, 9_000_000],
    ],
    900_000,
  );
  const large = tx("btc payout large", [[merchant, spk, 1_250_000]], 900_000);
  const split = tx(
    "btc payout split",
    [
      [merchant, spk, 400_000],
      [other, otherSpk, 1_000],
      [merchant, spk, 225_000],
    ],
    900_000,
  );
  const mempool = tx("btc payout mempool", [[merchant, spk, 625_000]], null);
  return {
    rule: "Esplora GET /tx/{txid} + GET /blocks/tip/height. amount = Σ value of outputs whose scriptpubkey_address (lower-case) = recipient (re-derived from scriptpubkey). confirmations = tip − block_height + 1 (unconfirmed = 0). required = requiredConfirmations(profile confirmation_tiers, settlement USD value from the execution's price snapshot); the default tiers are BITCOIN_DEFAULT_CONFIRMATION_TIERS = 1 confirmation for every amount (ADR-0022 as amended; a post-success re-check follows at 6 confirmations); below → not final, retry until verification_timeout_s → held(evidence_timeout).",
    tiers: BITCOIN_DEFAULT_CONFIRMATION_TIERS,
    required_confirmations: [
      {
        usd_micros: "999999999",
        confirmations: requiredConfirmations(BITCOIN_DEFAULT_CONFIRMATION_TIERS, 999_999_999n),
      },
      {
        usd_micros: "1000000000",
        confirmations: requiredConfirmations(BITCOIN_DEFAULT_CONFIRMATION_TIERS, 1_000_000_000n),
      },
      {
        usd_micros: "250000000000",
        confirmations: requiredConfirmations(BITCOIN_DEFAULT_CONFIRMATION_TIERS, 250_000_000_000n),
      },
    ],
    override_tiers_note:
      "A profile may opt back into USD tiers via confirmation_tiers (NP_CHAINS_FILE); BITCOIN_CONFIRMATION_TIERS (the Stage 4 tiers, 1 below USD 1,000, else 2) is the example. Not the default.",
    override_tiers: BITCOIN_CONFIRMATION_TIERS,
    override_required_confirmations: [
      { usd_micros: "999999999", confirmations: requiredConfirmations(BITCOIN_CONFIRMATION_TIERS, 999_999_999n) },
      { usd_micros: "1000000000", confirmations: requiredConfirmations(BITCOIN_CONFIRMATION_TIERS, 1_000_000_000n) },
      {
        usd_micros: "250000000000",
        confirmations: requiredConfirmations(BITCOIN_CONFIRMATION_TIERS, 250_000_000_000n),
      },
    ],
    cases: [
      {
        name: "USD 500 payout, 1 confirmation: final",
        expected_amount: "625000",
        settlement_usd_micros: "500000000",
        esplora_tx: small,
        tip_height: 900_000,
        result: "pass",
        evidence: ev(small, 900_000, 500_000_000n),
      },
      {
        name: "USD 1,000 payout, 1 confirmation: final (1 confirmation for every amount)",
        expected_amount: "1250000",
        settlement_usd_micros: "1000000000",
        esplora_tx: large,
        tip_height: 900_000,
        result: "pass",
        evidence: ev(large, 900_000, 1_000_000_000n),
      },
      {
        name: "USD 1,000 payout, 2 confirmations: final",
        expected_amount: "1250000",
        settlement_usd_micros: "1000000000",
        esplora_tx: large,
        tip_height: 900_001,
        result: "pass",
        evidence: ev(large, 900_001, 1_000_000_000n),
      },
      {
        name: "two outputs to the destination are summed",
        expected_amount: "625000",
        settlement_usd_micros: "500000000",
        esplora_tx: split,
        tip_height: 900_002,
        result: "pass",
        evidence: ev(split, 900_002, 500_000_000n),
      },
      {
        name: "in the mempool: not final",
        expected_amount: "625000",
        settlement_usd_micros: "500000000",
        esplora_tx: mempool,
        tip_height: 900_002,
        result: "not_final",
        evidence: null,
      },
    ],
  };
}

export function chainsVectors() {
  return {
    description:
      "Solana and Bitcoin as Tier A chains (spec 0.4.0; confirmation samples per ADR-0022 as amended since 0.4.2: Solana `confirmed` commitment, Bitcoin 1 confirmation for every amount; lld/rails.md §21). Chain profiles (ChainProfile, rails config/chains.yaml), assets from the live 1Click registry (asset ids are nep141 omft ids; neither chain has a nep245 form for these assets), address rules (kit chains), omft parsing and the SPL mint ↔ asset-id rule (sentinel R4/token reconciliation, checkout), manual-path payment URIs (checkout), and evidence parsing from RPC results (rails verifiers/watchers ↔ sentinel audit).",
    chains: chainProfiles(),
    assets: ASSETS.map((a) => ({ ...a, omft: parseOmftAssetId(a.asset_id) })),
    destination_types: {
      [SOLANA_MAINNET]: ["chain_address"],
      [BITCOIN_MAINNET]: ["chain_address"],
      note: "intents_account destinations are on near:mainnet only; neither chain uses a memo (memo_mode none).",
    },
    addresses: addressCases(),
    omft: omftCases(),
    payment_uris: uriCases(),
    evidence: { solana: solanaEvidenceCases(), bitcoin: bitcoinEvidenceCases() },
  };
}

// =============================================================================================
// destination-attestation.json
// =============================================================================================

/** identity §8.2 challenge message (exact UTF-8; mirrors nearpay-identity `attestationMessage`). */
export function destinationMessage(m: {
  account: string;
  livemode: boolean;
  asset_id: string;
  chain: string;
  address: string;
  nonce_hex: string;
  expires_at: string;
}): string {
  return [
    "NearPay settlement destination",
    `Account: ${m.account}`,
    `Mode: ${m.livemode ? "live" : "test"}`,
    `Asset: ${m.asset_id}`,
    `Network: ${m.chain}`,
    `Address: ${m.address}`,
    `Nonce: ${m.nonce_hex}`,
    `Expires: ${m.expires_at}`,
  ].join("\n");
}

/** Solana off-chain message (v0 header) — NOT accepted in v1; used as a negative vector. */
function solanaOffchainMessage(message: string): Uint8Array {
  const body = enc.encode(message);
  const len = new Uint8Array(2);
  new DataView(len.buffer).setUint16(0, body.length, true);
  return concat(Uint8Array.of(0xff), enc.encode("solana offchain"), Uint8Array.of(0, 0), len, body);
}

export function attestationVectors() {
  const account = "acct_01jc6q0f7rm9t3ga4x2b8n5k1d";
  const base = {
    account,
    livemode: true,
    nonce_hex: hash32("attestation nonce"),
    expires_at: "2026-11-08T10:10:00.000Z",
  };

  // --- Solana -----------------------------------------------------------------------------------
  const sol = solKey("solana merchant");
  const other = solKey("solana other wallet");
  const solInput = { ...base, asset_id: ASSETS[1].asset_id, chain: SOLANA_MAINNET, address: sol.address };
  const solMessage = destinationMessage(solInput);
  const sign = (s: Uint8Array, m: Uint8Array) => bs58.encode(ed25519.sign(m, s));
  const solSig = sign(sol.seed, enc.encode(solMessage));
  const testModeMessage = destinationMessage({ ...solInput, livemode: false });
  const solCases = [
    { name: "valid", signature: solSig, valid: true },
    { name: "signed the test-mode message", signature: sign(sol.seed, enc.encode(testModeMessage)), valid: false },
    { name: "signed by another wallet", signature: sign(other.seed, enc.encode(solMessage)), valid: false },
    {
      name: "off-chain message format (\\xffsolana offchain header) — not accepted in v1",
      signature: sign(sol.seed, solanaOffchainMessage(solMessage)),
      valid: false,
    },
    {
      name: "base64 instead of base58",
      signature: b64(ed25519.sign(enc.encode(solMessage), sol.seed)),
      valid: false,
    },
  ];
  for (const c of solCases) {
    let ok = false;
    try {
      const raw = bs58.decode(c.signature);
      ok = raw.length === 64 && ed25519.verify(raw, enc.encode(solMessage), bs58.decode(sol.address));
    } catch {
      ok = false;
    }
    if (ok !== c.valid) throw new Error(`solana vector ${c.name}`);
  }

  // --- BIP-322: upstream vectors ------------------------------------------------------------------
  const upstreamAddr = "bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l";
  const upstreamTr = "bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3";
  const upstream = {
    source: "BIP-322 test vectors (github.com/bitcoin/bips/blob/master/bip-0322.mediawiki)",
    private_key_wif: "L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k",
    message_hashes: ["", "Hello World"].map((message) => ({ message, hash: hex(bip322MessageHash(message)) })),
    transactions: ["", "Hello World"].map((message) => {
      const ts = bip322ToSpend(segwitScript(upstreamAddr), message);
      return { address: upstreamAddr, message, to_spend_txid: ts.txid, to_sign_txid: bip322ToSignTxid(ts.hash) };
    }),
    signatures: [
      {
        address: upstreamAddr,
        message: "",
        signature:
          "AkcwRAIgM2gBAQqvZX15ZiysmKmQpDrG83avLIT492QBzLnQIxYCIBaTpOaD20qRlEylyxFSeEA2ba9YOixpX8z46TSDtS40ASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI=",
      },
      {
        address: upstreamAddr,
        message: "Hello World",
        signature:
          "AkcwRAIgZRfIY3p7/DoVTty6YZbWS71bc5Vct9p9Fia83eRmw2QCICK/ENGfwLtptFluMGs2KsqoNSk89pO7F29zJLUx9a/sASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI=",
      },
      {
        address: upstreamTr,
        message: "Hello World",
        signature: "AUHd69PrJQEv+oKTfZ8l+WROBHuy9HKrbFCJu7U1iK2iiEy1vMU5EfMtjc+VSHM7aU0SDbak5IUZRVno2P5mjSafAQ==",
      },
    ],
  };
  for (const s of upstream.signatures)
    if (!bip322Verify(s.address, s.message, s.signature).ok) throw new Error(`upstream BIP-322 ${s.address} fails`);

  // --- BIP-322: NearPay challenge -----------------------------------------------------------------
  const k = btcKey("bitcoin merchant");
  const wrongKey = btcKey("bitcoin other wallet");
  const btcCase = (type: "p2wpkh" | "p2tr") => {
    const address = k[type];
    const input = { ...base, asset_id: "nep141:btc.omft.near", chain: BITCOIN_MAINNET, address };
    const message = destinationMessage(input);
    const ts = bip322ToSpend(segwitScript(address), message);
    const signature = bip322Sign(k.secret, type, message);
    const cases = [
      { name: "valid", signature, valid: true },
      {
        name: "signed the test-mode message",
        signature: bip322Sign(k.secret, type, destinationMessage({ ...input, livemode: false })),
        valid: false,
      },
      { name: "signed by another key", signature: bip322Sign(wrongKey.secret, type, message), valid: false },
      {
        name: '"full" encoding (a serialized transaction) instead of "simple"',
        signature: b64(concat(u32le(0), Uint8Array.of(0x00, 0x01), new Uint8Array(40))),
        valid: false,
      },
    ];
    if (type === "p2wpkh") {
      const pub = secp256k1.getPublicKey(k.secret, true);
      const sighashNone = bip322SighashP2wpkh(ts.hash, hash160(pub), 0x02);
      const der = secp256k1.sign(sighashNone, k.secret, { prehash: false, format: "der" });
      cases.push({
        name: "SIGHASH_NONE instead of SIGHASH_ALL",
        signature: b64(serializeWitness([concat(der, Uint8Array.of(0x02)), pub])),
        valid: false,
      });
    }
    for (const c of cases)
      if (bip322Verify(address, message, c.signature).ok !== c.valid) throw new Error(`bip322 ${type} ${c.name}`);
    return {
      type,
      secret_hex: hex(k.secret),
      address,
      input,
      message,
      message_hash: hex(bip322MessageHash(message)),
      to_spend_txid: ts.txid,
      to_sign_txid: bip322ToSignTxid(ts.hash),
      cases,
    };
  };

  return {
    description:
      'Destination ownership attestations (spec 0.4.0, lld/identity.md §8.2). The challenge message is the exact UTF-8 text identity issues (AttestationChallenge.message). Solana (`standard: solana`): signature = base58 of ed25519(message bytes) by the address\'s key (wallet-standard `solana:signMessage`, raw bytes, no off-chain header); valid iff it decodes to 64 bytes and verifies against base58-decode(address). Bitcoin (`standard: bip322`): BIP-322 "simple" — base64 of the witness stack of `to_sign` spending `to_spend` (message hash = tagged hash `BIP0322-signed-message`); P2WPKH: witness [DER ECDSA ‖ 0x01 (SIGHASH_ALL only), 33-byte pubkey] with hash160(pubkey) = program, BIP-143 sighash, amount 0; P2TR: witness [64-byte Schnorr (SIGHASH_DEFAULT) or 65 bytes ending 0x01], BIP-341 key-path sighash, verified against the output key (the witness program). Other address types, script-path spends and the "full"/legacy formats are refused (`attestation_invalid`). Keys are TEST-ONLY.',
    message: { input: solInput, text: solMessage },
    solana: {
      seed_hex: hex(sol.seed),
      address: sol.address,
      message: solMessage,
      cases: solCases,
    },
    bip322: {
      upstream,
      nearpay: [btcCase("p2wpkh"), btcCase("p2tr")],
      note: "P2TR signatures here use an all-zero BIP-340 aux_rand so they are reproducible; verifiers must not depend on it.",
    },
  };
}

// =============================================================================================
// solana-transfer.json (checkout wallet path)
// =============================================================================================

type Meta = { pubkey: string; is_signer: boolean; is_writable: boolean };
const meta = (pubkey: string, is_signer: boolean, is_writable: boolean): Meta => ({ pubkey, is_signer, is_writable });

export function solanaTransferVectors() {
  const payer = solKey("solana payer").address;
  const deposit = solKey("solana deposit").address;
  const recentBlockhash = bs58.encode(seed("solana recent blockhash"));
  const payerAta = associatedTokenAddress(payer, USDC_SOL_MINT);
  const depositAta = associatedTokenAddress(deposit, USDC_SOL_MINT);
  const amountSpl = 25_012_345n;
  const amountSol = 1_500_000_000n;
  return {
    description:
      "Checkout wallet-path instructions for Solana (spec 0.4.0, lld/checkout-and-js.md §5.4). Built only from the verified sentinel attestation: deposit.address, deposit.amount_in, asset.decimals and asset.token (SOL: `native`, asset `nep141:sol.omft.near`; SPL: `spl` whose mint reproduces the omft asset id, owned by the classic Token program). No memo and no Solana Pay `reference` (wallet path only when deposit.memo is null). Fee payer = the connected wallet; recent blockhash from the checkout's Solana RPC. The instructions (program, account metas, data) are normative; how a library orders the message's account keys is not, so no serialized message is pinned. ATA = findProgramAddress([owner, TOKEN_PROGRAM, mint], ATA_PROGRAM).",
    programs: { system: SYSTEM_PROGRAM, token: TOKEN_PROGRAM, associated_token: ATA_PROGRAM },
    inputs: { payer, deposit_address: deposit, recent_blockhash: recentBlockhash },
    spl: {
      asset_id: ASSETS[1].asset_id,
      mint: USDC_SOL_MINT,
      decimals: 6,
      amount_in: String(amountSpl),
      payer_ata: payerAta,
      deposit_ata: depositAta,
      instructions: [
        {
          name: "AssociatedTokenAccount.CreateIdempotent",
          program_id: ATA_PROGRAM,
          accounts: [
            meta(payer, true, true),
            meta(depositAta.address, false, true),
            meta(deposit, false, false),
            meta(USDC_SOL_MINT, false, false),
            meta(SYSTEM_PROGRAM, false, false),
            meta(TOKEN_PROGRAM, false, false),
          ],
          data_hex: "01",
        },
        {
          name: "Token.TransferChecked",
          program_id: TOKEN_PROGRAM,
          accounts: [
            meta(payerAta.address, false, true),
            meta(USDC_SOL_MINT, false, false),
            meta(depositAta.address, false, true),
            meta(payer, true, false),
          ],
          data_hex: hex(concat(Uint8Array.of(12), u64le(amountSpl), Uint8Array.of(6))),
        },
      ],
    },
    sol: {
      asset_id: ASSETS[0].asset_id,
      decimals: 9,
      amount_in: String(amountSol),
      instructions: [
        {
          name: "System.Transfer",
          program_id: SYSTEM_PROGRAM,
          accounts: [meta(payer, true, true), meta(deposit, false, true)],
          data_hex: hex(concat(u32le(2), u64le(amountSol))),
        },
      ],
    },
    after_broadcast:
      "The wallet's `solana:signAndSendTransaction` returns the signature; checkout posts it to `…/deposit_tx {tx_hash: <base58 signature>}`. Test mode never broadcasts (Simulate payment).",
  };
}
