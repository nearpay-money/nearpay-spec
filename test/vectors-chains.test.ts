/**
 * Stage 4 chain vectors verify independently of their generator (codegen/vectors-chains.ts):
 * BIP-322 sighashes via @scure/btc-signer, addresses via @scure/btc-signer / @scure/base, Solana
 * signatures and PDAs via @noble/curves, evidence amounts recomputed from the RPC results.
 */
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import * as btc from "@scure/btc-signer";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { ChainProfile, SimTx } from "../src/internal-entry.js";
import {
  BITCOIN_MAINNET,
  BitcoinDestinationAddress,
  Evidence,
  PUBLIC_ROUTES,
  parseOmftAssetId,
  SOLANA_MAINNET,
  SolanaAddress,
  SolanaSignature,
} from "../src/public-entry.js";

const load = (n: string) => JSON.parse(readFileSync(new URL(`../test-vectors/${n}`, import.meta.url), "utf8"));
const enc = new TextEncoder();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const onCurve = (b: Uint8Array) => {
  try {
    ed25519.Point.fromBytes(b);
    return true;
  } catch {
    return false;
  }
};

const chains = load("chains-solana-bitcoin.json");
const att = load("destination-attestation.json");
const transfer = load("solana-transfer.json");

// ---------------------------------------------------------------------------------------------
// chains-solana-bitcoin.json
// ---------------------------------------------------------------------------------------------

describe("chains-solana-bitcoin.json: profiles and assets", () => {
  it("profiles parse as ChainProfile with the documented CAIP-2 ids", () => {
    const ids = chains.chains.map((p: unknown) => ChainProfile.parse(p).chain);
    expect(ids).toEqual([SOLANA_MAINNET, BITCOIN_MAINNET]);
    const btcProfile = chains.chains[1];
    expect(btcProfile.confirmation_tiers).toEqual([
      { below_usd_micros: 1_000_000_000, confirmations: 1 },
      { below_usd_micros: null, confirmations: 2 },
    ]);
  });
  it("SPL asset ids are nep141:sol-<keccak256(mint)[12..32]>.omft.near", () => {
    for (const a of chains.assets) {
      const p = parseOmftAssetId(a.asset_id);
      expect(p?.blockchain).toBe(a.blockchain);
      if (a.token.standard === "spl") {
        expect(p?.kind).toBe("hash20");
        expect(p?.token).toBe(hex(keccak_256(bs58.decode(a.token.address)).subarray(12)));
      } else {
        expect(p?.kind).toBe("native");
      }
    }
    for (const c of chains.omft.cases) expect(parseOmftAssetId(c.asset_id)).toEqual(c.parsed);
  });
});

describe("chains-solana-bitcoin.json: addresses", () => {
  it("Solana: valid iff base58 decodes to 32 bytes; on_curve matches", () => {
    for (const c of chains.addresses.solana) {
      let raw: Uint8Array | null = null;
      try {
        raw = c.address === c.address.trim() ? bs58.decode(c.address) : null;
      } catch {
        raw = null;
      }
      const valid = raw !== null && raw.length === 32;
      expect(valid, c.address).toBe(c.valid);
      if (valid && raw) {
        expect(onCurve(raw), c.address).toBe(c.on_curve);
        expect(SolanaAddress.safeParse(c.address).success).toBe(true);
      }
    }
  });
  it("Bitcoin: validity and type agree with @scure/btc-signer; destinations are p2wpkh/p2tr only", () => {
    const typeOf: Record<string, string> = { wpkh: "p2wpkh", tr: "p2tr", pkh: "p2pkh", sh: "p2sh", wsh: "p2wsh" };
    for (const c of chains.addresses.bitcoin) {
      let decoded: { type: string } | null = null;
      try {
        decoded = btc.Address(btc.NETWORK).decode(c.address) as { type: string };
      } catch {
        decoded = null;
      }
      expect(decoded !== null, `${c.address} (${c.reason ?? c.type})`).toBe(c.valid);
      if (!c.valid || !decoded) continue;
      expect(typeOf[decoded.type], c.address).toBe(c.type);
      expect(BitcoinDestinationAddress.safeParse(c.normalized).success, c.address).toBe(c.destination_allowed);
    }
  });
});

describe("chains-solana-bitcoin.json: payment URIs", () => {
  const dec = (amount: string, decimals: number) => {
    const s = BigInt(amount);
    const d = 10n ** BigInt(decimals);
    const frac = (s % d).toString().padStart(decimals, "0").replace(/0+$/, "");
    return frac ? `${s / d}.${frac}` : `${s / d}`;
  };
  it("formats base units exactly", () => {
    for (const c of chains.payment_uris.format_base_units) expect(c.decimal).toBe(dec(c.amount, c.decimals));
  });
  it("BIP-21 and Solana Pay URIs carry the exact amount", () => {
    for (const c of chains.payment_uris.bip21) {
      const u = new URL(c.uri);
      expect(u.protocol).toBe("bitcoin:");
      expect(u.pathname).toBe(c.address);
      expect(u.searchParams.get("amount")).toBe(dec(c.amount_sats, 8));
    }
    for (const c of chains.payment_uris.solana_pay) {
      const u = new URL(c.uri);
      expect(u.protocol).toBe("solana:");
      expect(u.pathname).toBe(c.recipient);
      expect(u.searchParams.get("amount")).toBe(dec(c.amount_base, c.decimals));
      expect(u.searchParams.get("spl-token")).toBe(c.spl_mint);
    }
  });
});

describe("chains-solana-bitcoin.json: evidence parsing", () => {
  it("Solana: amount = owner's token-balance (or lamport) delta in a successful tx", () => {
    const sol = chains.evidence.solana;
    for (const c of sol.cases) {
      const r = c.rpc_result;
      const expected = BigInt(c.expected_amount ?? sol.expected_amount);
      if (r.meta.err !== null) {
        expect(c.evidence).toBeNull();
        continue;
      }
      const ev = Evidence.parse(c.evidence);
      const owner = ev.recipient;
      const mint = ev.solana?.mint ?? null;
      let delta: bigint;
      if (mint) {
        const sum = (rows: { owner: string; mint: string; uiTokenAmount: { amount: string } }[]) =>
          rows
            .filter((t) => t.owner === owner && t.mint === mint)
            .reduce((n, t) => n + BigInt(t.uiTokenAmount.amount), 0n);
        delta = sum(r.meta.postTokenBalances) - sum(r.meta.preTokenBalances);
      } else {
        const i = r.transaction.message.accountKeys.indexOf(owner);
        delta = BigInt(r.meta.postBalances[i]) - BigInt(r.meta.preBalances[i]);
      }
      expect(String(delta)).toBe(ev.amount);
      expect(delta >= expected ? "pass" : "mismatch").toBe(c.result);
      expect(ev.tx_hash).toBe(r.transaction.signatures[0]);
      expect(ev.block_ref).toBe(String(r.slot));
      expect(SolanaSignature.safeParse(ev.tx_hash).success).toBe(true);
      expect(bs58.decode(ev.tx_hash)).toHaveLength(64);
      expect(BigInt(ev.solana?.post_amount ?? "0") - BigInt(ev.solana?.pre_amount ?? "0")).toBe(delta);
    }
  });
  it("Bitcoin: amount = Σ outputs to the address, confirmations against the tier", () => {
    const b = chains.evidence.bitcoin;
    for (const c of b.cases) {
      const t = c.esplora_tx;
      const usd = BigInt(c.settlement_usd_micros);
      const required = usd < 1_000_000_000n ? 1 : 2;
      const confs = t.status.confirmed ? c.tip_height - t.status.block_height + 1 : 0;
      if (confs < required) {
        expect(c.result).toBe("not_final");
        expect(c.evidence).toBeNull();
        continue;
      }
      const ev = Evidence.parse(c.evidence);
      const outs = t.vout
        .map((o: { scriptpubkey_address: string; value: number }, vout: number) => ({ ...o, vout }))
        .filter((o: { scriptpubkey_address: string }) => o.scriptpubkey_address === ev.recipient);
      expect(String(outs.reduce((n: bigint, o: { value: number }) => n + BigInt(o.value), 0n))).toBe(ev.amount);
      expect(ev.bitcoin?.outputs.map((o) => o.vout)).toEqual(outs.map((o: { vout: number }) => o.vout));
      expect(ev.bitcoin?.confirmations).toBe(confs);
      expect(ev.bitcoin?.required_confirmations).toBe(required);
      // the scriptPubKey re-derives the address
      for (const o of ev.bitcoin?.outputs ?? [])
        expect(btc.Address(btc.NETWORK).encode(btc.OutScript.decode(Buffer.from(o.script_pubkey, "hex")))).toBe(
          ev.recipient,
        );
      expect(BigInt(ev.amount) >= BigInt(c.expected_amount) ? "pass" : "short").toBe(c.result);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// destination-attestation.json
// ---------------------------------------------------------------------------------------------

describe("destination-attestation.json: message", () => {
  it("is the identity §8.2 text", () => {
    const i = att.message.input;
    expect(att.message.text).toBe(
      `NearPay settlement destination\nAccount: ${i.account}\nMode: live\nAsset: ${i.asset_id}\nNetwork: ${i.chain}\nAddress: ${i.address}\nNonce: ${i.nonce_hex}\nExpires: ${i.expires_at}`,
    );
  });
});

describe("destination-attestation.json: Solana", () => {
  it("address derives from the seed and only the valid case verifies", () => {
    const s = att.solana;
    expect(bs58.encode(ed25519.getPublicKey(Buffer.from(s.seed_hex, "hex")))).toBe(s.address);
    for (const c of s.cases) {
      let ok = false;
      try {
        const sig = bs58.decode(c.signature);
        ok = sig.length === 64 && ed25519.verify(sig, enc.encode(s.message), bs58.decode(s.address));
      } catch {
        ok = false;
      }
      expect(ok, c.name).toBe(c.valid);
    }
  });
});

let lastToSpendId = "";
/** Independent BIP-322 simple verifier: sighashes from @scure/btc-signer. */
function verifyBip322(address: string, message: string, signatureB64: string): boolean {
  const spk = btc.OutScript.encode(btc.Address(btc.NETWORK).decode(address));
  const tag = sha256(enc.encode("BIP0322-signed-message"));
  const msgHash = sha256(new Uint8Array([...tag, ...tag, ...enc.encode(message)]));
  const toSpend = new btc.Transaction({
    version: 0,
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
    disableScriptCheck: true,
    allowUnknownVersion: true,
  });
  toSpend.addOutput({ script: spk, amount: 0n });
  toSpend.addInput({
    txid: new Uint8Array(32),
    index: 0xffffffff,
    sequence: 0,
    finalScriptSig: new Uint8Array([0x00, 0x20, ...msgHash]),
  });
  lastToSpendId = toSpend.id;
  const toSign = new btc.Transaction({ version: 0, allowUnknownOutputs: true, allowUnknownVersion: true });
  toSign.addInput({ txid: toSpend.id, index: 0, sequence: 0, witnessUtxo: { script: spk, amount: 0n } });
  toSign.addOutput({ script: new Uint8Array([0x6a]), amount: 0n });
  let witness: Uint8Array[];
  try {
    witness = btc.RawWitness.decode(fromB64(signatureB64));
  } catch {
    return false;
  }
  const out = btc.OutScript.decode(spk);
  if (out.type === "wpkh") {
    if (witness.length !== 2) return false;
    const [sig, pub] = witness as [Uint8Array, Uint8Array];
    if (sig[sig.length - 1] !== btc.SigHash.ALL) return false;
    if (hex(btc.p2wpkh(pub).script) !== hex(spk)) return false;
    const sighash = toSign.preimageWitnessV0(0, btc.p2pkh(pub).script, btc.SigHash.ALL, 0n);
    try {
      return secp256k1.verify(sig.subarray(0, -1), sighash, pub, { prehash: false, format: "der", lowS: false });
    } catch {
      return false;
    }
  }
  if (out.type === "tr") {
    if (witness.length !== 1) return false;
    const sig = witness[0] as Uint8Array;
    const type = sig.length === 64 ? btc.SigHash.DEFAULT : sig.length === 65 ? (sig[64] as number) : -1;
    if (type !== btc.SigHash.DEFAULT && type !== btc.SigHash.ALL) return false;
    const sighash = toSign.preimageWitnessV1(0, [spk], type, [0n]);
    return schnorr.verify(sig.subarray(0, 64), sighash, out.pubkey);
  }
  return false;
}

describe("destination-attestation.json: BIP-322 simple", () => {
  it("upstream message hashes and virtual txids match the BIP", () => {
    const u = att.bip322.upstream;
    expect(u.message_hashes).toEqual([
      { message: "", hash: "c90c269c4f8fcbe6880f72a721ddfbf1914268a794cbb21cfafee13770ae19f1" },
      { message: "Hello World", hash: "f0eb03b1a75ac6d9847f55c624a99169b5dccba2a31f5b23bea77ba270de0a7a" },
    ]);
    expect(
      u.transactions.map((t: { to_spend_txid: string; to_sign_txid: string }) => [t.to_spend_txid, t.to_sign_txid]),
    ).toEqual([
      [
        "c5680aa69bb8d860bf82d4e9cd3504b55dde018de765a91bb566283c545a99a7",
        "1e9654e951a5ba44c8604c4de6c67fd78a27e81dcadcfe1edf638ba3aaebaed6",
      ],
      [
        "b79d196740ad5217771c1098fc4a4b51e0535c32236c71f1ea4d61a2d603352b",
        "88737ae86f2077145f93cc4b153ae9a1cb8d56afa511988c149c5c8c9d93bddf",
      ],
    ]);
  });
  it("upstream signatures (P2WPKH, P2TR) verify with btc-signer sighashes", () => {
    const priv = btc.WIF().decode(att.bip322.upstream.private_key_wif);
    const pub = secp256k1.getPublicKey(priv, true);
    expect(btc.p2wpkh(pub).address).toBe(att.bip322.upstream.signatures[0].address);
    expect(btc.p2tr(pub.subarray(1)).address).toBe(att.bip322.upstream.signatures[2].address);
    for (const s of att.bip322.upstream.signatures)
      expect(verifyBip322(s.address, s.message, s.signature), s.address).toBe(true);
    verifyBip322(att.bip322.upstream.signatures[1].address, "Hello World", att.bip322.upstream.signatures[1].signature);
    expect(lastToSpendId).toBe(att.bip322.upstream.transactions[1].to_spend_txid);
    expect(
      verifyBip322(
        att.bip322.upstream.signatures[0].address,
        "Hello World",
        att.bip322.upstream.signatures[0].signature,
      ),
    ).toBe(false);
  });
  it("NearPay challenge cases verify exactly as labelled; addresses derive from the test keys", () => {
    for (const v of att.bip322.nearpay) {
      const priv = Buffer.from(v.secret_hex, "hex");
      const pub = secp256k1.getPublicKey(priv, true);
      const derived = v.type === "p2wpkh" ? btc.p2wpkh(pub).address : btc.p2tr(pub.subarray(1)).address;
      expect(derived).toBe(v.address);
      for (const c of v.cases)
        expect(verifyBip322(v.address, v.message, c.signature), `${v.type}: ${c.name}`).toBe(c.valid);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// solana-transfer.json
// ---------------------------------------------------------------------------------------------

describe("solana-transfer.json", () => {
  const pda = (seeds: Uint8Array[], program: string, bump: number) =>
    sha256(
      new Uint8Array([
        ...seeds.flatMap((s) => [...s]),
        bump,
        ...bs58.decode(program),
        ...enc.encode("ProgramDerivedAddress"),
      ]),
    );
  it("ATAs are the canonical (highest off-curve bump) program addresses", () => {
    const { token, associated_token } = transfer.programs;
    for (const [owner, ata] of [
      [transfer.inputs.payer, transfer.spl.payer_ata],
      [transfer.inputs.deposit_address, transfer.spl.deposit_ata],
    ]) {
      const seeds = [bs58.decode(owner), bs58.decode(token), bs58.decode(transfer.spl.mint)];
      for (let b = 255; b > ata.bump; b--) expect(onCurve(pda(seeds, associated_token, b))).toBe(true);
      const h = pda(seeds, associated_token, ata.bump);
      expect(onCurve(h)).toBe(false);
      expect(bs58.encode(h)).toBe(ata.address);
    }
  });
  it("instruction data encodes amount_in and decimals (little-endian)", () => {
    const [create, xfer] = transfer.spl.instructions;
    expect(create.data_hex).toBe("01");
    const d = Buffer.from(xfer.data_hex, "hex");
    expect(d[0]).toBe(12);
    expect(d.readBigUInt64LE(1)).toBe(BigInt(transfer.spl.amount_in));
    expect(d[9]).toBe(transfer.spl.decimals);
    const sd = Buffer.from(transfer.sol.instructions[0].data_hex, "hex");
    expect(sd.readUInt32LE(0)).toBe(2);
    expect(sd.readBigUInt64LE(4)).toBe(BigInt(transfer.sol.amount_in));
    expect(parseOmftAssetId(transfer.spl.asset_id)?.token).toBe(
      hex(keccak_256(bs58.decode(transfer.spl.mint)).subarray(12)),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// contract additions (spec 0.4.0)
// ---------------------------------------------------------------------------------------------

describe("spec 0.4.0 chains: contract additions", () => {
  it("attestSettlementDestination accepts solana and bip322", () => {
    const r = PUBLIC_ROUTES.find((x) => x.id === "attestSettlementDestination");
    const body = r?.body as unknown as { safeParse(v: unknown): { success: boolean } };
    const base = { challenge_id: "chl_01jc6q0f7rm9t3ga4x2b8n5k1d", signature: att.solana.cases[0].signature };
    for (const standard of ["nep413", "eip191", "solana", "bip322"])
      expect(body.safeParse({ ...base, standard }).success, standard).toBe(true);
    expect(body.safeParse({ ...base, standard: "siws" }).success).toBe(false);
  });
  it("Evidence stays valid without the chain details (older producers)", () => {
    const ev = { ...chains.evidence.solana.cases[0].evidence };
    delete ev.solana;
    delete ev.bitcoin;
    expect(Evidence.safeParse(ev).success).toBe(true);
  });
  it("SimTx accepts Bitcoin and Solana simulation fields and stays valid without them", () => {
    const t = { token: "nep141:btc.omft.near", to: "bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l", amount: "625000" };
    expect(SimTx.safeParse({ finalized: true, transfers: [t] }).success).toBe(true);
    expect(
      SimTx.safeParse({ finalized: false, transfers: [{ ...t, vout: 0 }], block_ref: "900000", confirmations: 0 })
        .success,
    ).toBe(true);
    expect(SimTx.safeParse({ finalized: true, transfers: [], failed: true, block_ref: "380000004" }).success).toBe(
      true,
    );
  });
});
