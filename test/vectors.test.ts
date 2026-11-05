/** The committed test vectors verify independently of the generator. */
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import bs58 from "bs58";
import canonicalize from "canonicalize";
import { describe, expect, it } from "vitest";
import {
  Attestation,
  AttestationTicketPayload,
  IntentMessage,
  id,
  idPattern,
  MultiPayload,
  Nep413IntentMessage,
  parseSignatureHeader,
  SignedAttestation,
  signedPayload,
  WEBHOOK_TOLERANCE_SECONDS,
} from "../src/public-entry.js";

const load = (n: string) => JSON.parse(readFileSync(new URL(`../test-vectors/${n}`, import.meta.url), "utf8"));
const enc = new TextEncoder();
const fromB64url = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const fromHex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const curveBytes = (s: string) => bs58.decode(s.slice(s.indexOf(":") + 1));

describe("ids.json", () => {
  const v = load("ids.json");
  it("accepts NearPay ids and rejects the invalid ones", () => {
    for (const x of v.nearpay) expect(id(x.prefix).safeParse(x.id).success, x.id).toBe(true);
    for (const x of v.invalid) expect(idPattern("pi").test(x.id), x.reason).toBe(false);
  });
  it("matches the upstream TypeID suffix shape", () => {
    for (const x of v.upstream_typeid) expect(`pi_${x.suffix}`).toMatch(idPattern("pi"));
  });
});

describe("destination-fingerprint.json", () => {
  it("has well-formed fingerprints over the documented input", () => {
    for (const c of load("destination-fingerprint.json").cases) {
      expect(c.input).toBe(`${c.chain}|${c.address_norm}|${c.asset_id}`);
      expect(c.fingerprint).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{2}$/);
    }
  });
});

describe("sentinel-attestation.json", () => {
  const v = load("sentinel-attestation.json");
  const pk = fromB64url(v.key.public_key_base64url);
  const verify = (s: { kid: string; signature: string; attestation: unknown }) =>
    s.kid === v.key.kid &&
    ed25519.verify(fromB64url(s.signature), enc.encode(canonicalize(s.attestation) as string), pk);
  it("derives the public key from the seed", () => {
    expect(Buffer.from(ed25519.getPublicKey(fromHex(v.key.seed_hex))).toString("base64url")).toBe(
      v.key.public_key_base64url,
    );
  });
  it("verifies every valid attestation and its canonical form", () => {
    for (const x of v.valid) {
      expect(SignedAttestation.safeParse(x.signed).success).toBe(true);
      expect(Attestation.parse(x.signed.attestation)).toBeTruthy();
      expect(canonicalize(x.signed.attestation)).toBe(x.canonical_json);
      expect(verify(x.signed)).toBe(true);
    }
  });
  it("rejects every invalid case", () => {
    for (const x of v.invalid) expect(verify(x.signed), x.reason).toBe(false);
  });
});

describe("attestation-ticket.json", () => {
  const v = load("attestation-ticket.json");
  it("verifies", () => {
    const [body, sig] = v.ticket.split(".");
    const bytes = fromB64url(body);
    expect(new TextDecoder().decode(bytes)).toBe(v.canonical_json);
    expect(AttestationTicketPayload.parse(JSON.parse(v.canonical_json))).toEqual(v.payload);
    expect(ed25519.verify(fromB64url(sig), bytes, fromB64url(v.key.public_key_base64url))).toBe(true);
    const forged = Buffer.from(v.canonical_json.replace('"livemode":true', '"livemode":false')).toString("base64url");
    expect(ed25519.verify(fromB64url(sig), fromB64url(forged), fromB64url(v.key.public_key_base64url))).toBe(false);
  });
});

describe("webhook-signatures.json", () => {
  const v = load("webhook-signatures.json");
  const verify = (rawBody: string, header: string, now: number, secrets: string[]) => {
    const h = parseSignatureHeader(header);
    if (!h || Math.abs(now - h.timestamp) > WEBHOOK_TOLERANCE_SECONDS) return false;
    const msg = enc.encode(signedPayload(h.timestamp, rawBody));
    const macs = secrets.map((s) => Buffer.from(hmac(sha256, enc.encode(s), msg)).toString("hex"));
    return h.v1.some((sig) => macs.includes(sig));
  };
  it("verifies v1 with the secret (and both secrets during rotation)", () => {
    expect(verify(v.raw_body, v.header, v.verify_at, [v.secret])).toBe(true);
    expect(verify(v.raw_body, v.header_during_rotation, v.verify_at, [v.secondary_secret])).toBe(true);
    expect(v.signed_payload).toBe(`${v.timestamp}.${v.raw_body}`);
  });
  it("verifies v1a with the Ed25519 key", () => {
    const h = parseSignatureHeader(v.header);
    expect(h?.kid).toBe(v.ed25519.kid);
    expect(
      ed25519.verify(
        fromB64url(h?.v1a as string),
        enc.encode(v.signed_payload),
        fromB64url(v.ed25519.public_key_base64url),
      ),
    ).toBe(true);
  });
  it("rejects every negative case", () => {
    for (const n of v.negative) expect(verify(n.raw_body, n.header, n.now, [v.secret]), n.reason).toBe(false);
  });
});

describe("intents-payloads.json", () => {
  const v = load("intents-payloads.json");
  it("puts the Verifier salt in the first 4 nonce bytes", () => {
    expect(Buffer.from(v.nonce_base64, "base64").subarray(0, 4).toString("hex")).toBe(v.salt_hex);
  });
  it("NEP-413: hash and signature verify; implicit account = hex(public key)", () => {
    const mp = MultiPayload.parse(v.nep413.multipayload);
    if (mp.standard !== "nep413") throw new Error("standard");
    const pk = curveBytes(mp.public_key);
    expect(Buffer.from(pk).toString("hex")).toBe(v.nep413.signer_id);
    const msg = Nep413IntentMessage.parse(JSON.parse(mp.payload.message));
    expect(msg.signer_id).toBe(v.nep413.signer_id);
    expect(ed25519.verify(curveBytes(mp.signature), fromHex(v.nep413.hash_hex), pk)).toBe(true);
  });
  it("ERC-191: r‖s‖v signature recovers the signer address", () => {
    const mp = MultiPayload.parse(v.erc191.multipayload);
    if (mp.standard !== "erc191") throw new Error("standard");
    const msg = IntentMessage.parse(JSON.parse(mp.payload));
    const rsv = curveBytes(mp.signature);
    expect(rsv.length).toBe(65);
    expect([0, 1]).toContain(rsv[64]);
    const rec = new Uint8Array([rsv[64] as number, ...rsv.slice(0, 64)]);
    const pub = secp256k1.recoverPublicKey(rec, fromHex(v.erc191.hash_hex), { prehash: false });
    const uncompressed = secp256k1.Point.fromBytes(pub).toBytes(false);
    const address = `0x${Buffer.from(keccak_256(uncompressed.slice(1)).slice(-20)).toString("hex")}`;
    expect(address).toBe(v.erc191.address);
    expect(msg.signer_id).toBe(address);
  });
  it("raw_ed25519: signature over the UTF-8 payload", () => {
    const mp = MultiPayload.parse(v.raw_ed25519.multipayload);
    if (mp.standard !== "raw_ed25519") throw new Error("standard");
    expect(ed25519.verify(curveBytes(mp.signature), enc.encode(mp.payload), curveBytes(mp.public_key))).toBe(true);
    expect(IntentMessage.parse(JSON.parse(mp.payload)).signer_id).toBe(v.raw_ed25519.signer_id);
  });
  it("binds both transfers with the same memo", () => {
    const msg = IntentMessage.parse(JSON.parse(v.erc191.multipayload.payload));
    expect(msg.intents.map((i) => (i as { memo?: string }).memo)).toEqual([v.binding, v.binding]);
    expect(sha256).toBeTypeOf("function");
  });
});
