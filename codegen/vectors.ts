/**
 * Deterministic cross-repo test vectors (lld/00-foundations.md §3 `test-vectors/`, L-F-07).
 * Producer and consumer of each format test against the same file:
 *
 *   ids.json                    TypeID encoding (kit ids ↔ everyone)           + upstream TypeID vectors
 *   destination-fingerprint.json sentinel/identity fingerprint
 *   sentinel-attestation.json   sentinel (signer) ↔ checkout, agent-signer (verifiers)
 *   attestation-ticket.json     payments (signer) ↔ sentinel (verifier)
 *   webhook-signatures.json     webhooks (signer) ↔ @nearpay-money/node (verifier)
 *   intents-payloads.json       checkout, agent-signer (signers) ↔ agentpay, sandbox (verifiers)
 *   billing-tax.json            billing (invoices, PDF) ↔ dashboard, checkout (display): tax + periods
 *   x402-near-intents.json      agentpay (binding, operation token) ↔ @nearpay-money/x402, agent-signer (wire shapes)
 *   vault.json                  subscription vault (events, errors, views) ↔ rails, billing keeper, sandbox stand-in
 *   chains-solana-bitcoin.json, destination-attestation.json, solana-transfer.json — stage 4 chains (vectors-chains.ts)
 *
 * Keys here are TEST-ONLY seeds derived from fixed strings; never use them for anything else.
 * Usage: tsx codegen/vectors.ts [--check]
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import bs58 from "bs58";
import canonicalize from "canonicalize";
import {
  nearPanicStatus,
  SANDBOX_VAULT_DEFAULTS,
  VAULT_KEEPER_ON_TX_FAILURE,
  VAULT_KEEPER_RULES,
  VAULT_SANDBOX_SCENARIOS,
} from "../src/internal-entry.js";
import {
  Attestation,
  AttestationTicketPayload,
  computeInvoiceTotals,
  EVENT_JSON_PREFIX,
  formatSignatureHeader,
  formatVaultEventLog,
  ID_ALPHABET,
  INTENTS_CONTRACT,
  type IntentMessage,
  MultiPayload,
  type MultiPayload as MultiPayloadT,
  NEAR_SDK_GUARD_MESSAGES,
  NearIntentsPaymentPayload,
  NearIntentsSettleResponse,
  NearIntentsVerifyResponse,
  parseOperationToken,
  periodBoundary,
  quotedRequirements,
  routeQuoteDepositKey,
  SignedAttestation,
  SMART_CONTRACT_PANICKED_PREFIX,
  signedPayload,
  taxPercentageToPpm,
  VAULT_CANCEL_ERRORS,
  VAULT_CAP_EXCEEDED_LOGS,
  VAULT_COLLECT_ERRORS,
  VAULT_ERRORS,
  VAULT_EVENT_STANDARD,
  VAULT_EVENT_VERSION,
  VAULT_FUNDING_REJECTIONS,
  VAULT_GAS,
  VAULT_LIMITS,
  VAULT_PERIOD_SECS_PER_INTERVAL,
  VAULT_WITHDRAW_ERRORS,
  type VaultEvent,
  VaultEvent as VaultEventSchema,
  vaultMsgJson,
  vaultSplit,
  X402NearIntentsBindingInput,
  X402OperationTokenInput,
  X402PaymentRequiredAny,
} from "../src/public-entry.js";
import { type Output, toJson, writeOutputs } from "./lib.js";
// stage 4 — chains
import {
  chainsVectors,
  attestationVectors as destinationAttestationVectors,
  solanaTransferVectors,
} from "./vectors-chains.js";

const enc = new TextEncoder();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const jcs = (v: unknown): string => {
  const s = canonicalize(v);
  if (s === undefined) throw new Error("not canonicalizable");
  return s;
};
/** Test-only 32-byte seed: sha256("nearpay test vector: <label>"). */
const seed = (label: string) => sha256(enc.encode(`nearpay test vector: ${label}`));

// ---------------------------------------------------------------------------------------------
// ids (TypeID: 128-bit UUID, left-padded to 130 bits, 26 × 5-bit symbols)
// ---------------------------------------------------------------------------------------------

function typeidSuffix(uuid: string): string {
  let n = BigInt(`0x${uuid.replace(/-/g, "")}`);
  let s = "";
  for (let i = 0; i < 26; i++) {
    s = ID_ALPHABET[Number(n & 31n)] + s;
    n >>= 5n;
  }
  return s;
}

function idsVectors() {
  // Upstream TypeID spec vectors (github.com/jetify-com/typeid, spec/valid.yml) — independent reference.
  const upstream = [
    { uuid: "00000000-0000-0000-0000-000000000000", suffix: "00000000000000000000000000" },
    { uuid: "00000000-0000-0000-0000-000000000001", suffix: "00000000000000000000000001" },
    { uuid: "00000000-0000-0000-0000-00000000000a", suffix: "0000000000000000000000000a" },
    { uuid: "00000000-0000-0000-0000-000000000010", suffix: "0000000000000000000000000g" },
    { uuid: "00000000-0000-0000-0000-000000000020", suffix: "00000000000000000000000010" },
    { uuid: "ffffffff-ffff-ffff-ffff-ffffffffffff", suffix: "7zzzzzzzzzzzzzzzzzzzzzzzzz" },
    { uuid: "01890a5d-ac96-774b-bcce-b302099a8057", suffix: "01h455vb4pex5vsknk084sn02q" },
  ];
  for (const v of upstream) {
    if (typeidSuffix(v.uuid) !== v.suffix) throw new Error(`typeid mismatch for ${v.uuid}`);
  }
  const nearpay = [
    { prefix: "pi", uuid: "01972a6f-3c80-7b2e-9f4d-2c1e8a6b5d40" },
    { prefix: "acct", uuid: "01972a6f-3c80-7000-8000-000000000001" },
    { prefix: "cs", uuid: "0196f000-0000-7fff-bfff-ffffffffffff" },
  ].map((v) => ({ ...v, id: `${v.prefix}_${typeidSuffix(v.uuid)}` }));
  const invalid = [
    { id: "pi_8zzzzzzzzzzzzzzzzzzzzzzzzz", reason: "first character > 7 (overflow)" },
    { id: "pi_01H455VB4PEX5VSKNK084SN02Q", reason: "upper case" },
    { id: "pi_01h455vb4pex5vsknk084sn02", reason: "25 characters" },
    { id: "pi_01h455vb4pex5vsknk084sn0iq", reason: "contains i" },
    { id: "pi-01h455vb4pex5vsknk084sn02q", reason: "wrong separator" },
  ];
  return {
    description: "TypeID-encoded UUIDv7 ids: lower-case Crockford base32, 26 chars, first char 0-7.",
    alphabet: ID_ALPHABET,
    upstream_typeid: upstream,
    nearpay,
    invalid,
  };
}

// ---------------------------------------------------------------------------------------------
// destination fingerprint (sentinel §5): first 10 base32 chars of sha256(chain|address_norm|asset_id)
// ---------------------------------------------------------------------------------------------

const CROCKFORD_UPPER = ID_ALPHABET.toUpperCase();

function fingerprint(chain: string, addressNorm: string, assetId: string): string {
  const h = sha256(enc.encode(`${chain}|${addressNorm}|${assetId}`));
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const byte of h) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 10) {
      out += CROCKFORD_UPPER[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
    if (out.length === 10) break;
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 10)}`;
}

const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";

function fingerprintVectors() {
  const cases = [
    { chain: "near:mainnet", address_norm: "merchant.near", asset_id: USDC_NEAR },
    { chain: "eip155:8453", address_norm: "0x52908400098527886e0f7030069857d2e4169ee7", asset_id: USDC_BASE },
    {
      chain: "near:mainnet",
      address_norm: "e2e4c3f1d1e8b37f9d8c1c64b9d1a8e2b0c7f5a1c9d3e8f2a4b6c8d0e1f3a5b7",
      asset_id: USDC_NEAR,
    },
  ];
  return {
    description:
      "fingerprint = first 10 symbols of upper-case Crockford base32 (MSB-first bit stream) of sha256(UTF-8 `chain|address_norm|asset_id`), grouped 4-4-2.",
    cases: cases.map((c) => ({
      ...c,
      input: `${c.chain}|${c.address_norm}|${c.asset_id}`,
      fingerprint: fingerprint(c.chain, c.address_norm, c.asset_id),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// sentinel attestation (Ed25519 over RFC 8785 JCS of `attestation`)
// ---------------------------------------------------------------------------------------------

function attestationVectors() {
  const sk = seed("sentinel signing key");
  const pk = ed25519.getPublicKey(sk);
  const kid = "sent-test-1";
  const routeQuote = Attestation.parse({
    v: 1,
    kind: "route_quote",
    attempt_id: "pa_01jbz9k3m4n5p6q7r8s9t0v1w2",
    livemode: true,
    deposit: {
      address: "0x76b4c56085ed136a8744d52be956396624a730e8",
      memo: null,
      chain: "eip155:8453",
      origin_asset_id: USDC_BASE,
      amount_in: "2005013",
      deadline: "2026-11-05T10:15:00.000Z",
    },
    merchant: { name: "Acme GmbH", kyb_verified: true },
    destination: {
      asset_id: USDC_NEAR,
      chain: "near:mainnet",
      fingerprint: fingerprint("near:mainnet", "merchant.near", USDC_NEAR),
    },
    issued_at: "2026-11-05T10:00:01.000Z",
    expires_at: "2026-11-05T10:15:00.000Z",
  });
  const intents = Attestation.parse({
    v: 1,
    kind: "intents_transfer",
    attempt_id: "pa_01jbz9k3m4n5p6q7r8s9t0v1w3",
    livemode: false,
    requirement: {
      pay_to: "merchant.near",
      token: USDC_NEAR,
      amount: "2000000",
      fee_to: "treasury.nearpay.near",
      fee_amount: "6000",
      binding: `np1:${bs58.encode(sha256(enc.encode("binding vector")))}`,
      deadline: "2026-11-05T10:02:00.000Z",
    },
    merchant: { name: "Acme (unverified)", kyb_verified: false },
    destination: {
      asset_id: USDC_NEAR,
      chain: "near:mainnet",
      fingerprint: fingerprint("near:mainnet", "merchant.near", USDC_NEAR),
    },
    issued_at: "2026-11-05T10:00:01.000Z",
    expires_at: "2026-11-05T10:02:00.000Z",
  });
  const sign = (att: unknown) => {
    const canonical = jcs(att);
    const signature = b64url(ed25519.sign(enc.encode(canonical), sk));
    const signed = SignedAttestation.parse({ attestation: att, kid, signature });
    return { canonical_json: canonical, signed };
  };
  const rq = sign(routeQuote);
  const tampered = {
    ...rq.signed,
    attestation: {
      ...rq.signed.attestation,
      deposit: { ...routeQuote.deposit, address: "0x0000000000000000000000000000000000000bad" },
    },
  };
  return {
    description:
      "signature = base64url(Ed25519(UTF-8 of RFC 8785 canonical JSON of `attestation`)). Verify with the pinned key for `kid`.",
    key: { kid, seed_hex: hex(sk), public_key_base64url: b64url(pk) },
    valid: [rq, sign(intents)],
    invalid: [
      { reason: "deposit address changed after signing", signed: tampered },
      { reason: "unknown kid", signed: { ...rq.signed, kid: "sent-unknown" } },
      {
        reason: "signature of a different attestation",
        signed: { ...rq.signed, signature: sign(intents).signed.signature },
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// attestation ticket (payments → sentinel)
// ---------------------------------------------------------------------------------------------

function ticketVectors() {
  const sk = seed("payments ticket key");
  const pk = ed25519.getPublicKey(sk);
  const payload = AttestationTicketPayload.parse({
    attempt_id: "pa_01jbz9k3m4n5p6q7r8s9t0v1w2",
    livemode: true,
    deposit_key: routeQuoteDepositKey("oneclick", "0x76b4c56085ed136a8744d52be956396624a730e8", null),
    exp: 1793873700,
  });
  const body = jcs(payload);
  const sig = ed25519.sign(enc.encode(body), sk);
  const ticket = `${b64url(enc.encode(body))}.${b64url(sig)}`;
  return {
    description:
      "ticket = base64url(JCS(payload)) + '.' + base64url(Ed25519(payments ticket key, JCS bytes)). Sentinel verifies, checks exp > now and that attempt_id, livemode and deposit_key match the request.",
    key: { seed_hex: hex(sk), public_key_base64url: b64url(pk) },
    payload,
    canonical_json: body,
    ticket,
  };
}

// ---------------------------------------------------------------------------------------------
// webhook signatures
// ---------------------------------------------------------------------------------------------

function webhookVectors() {
  const secret = "whsec_testvector0000000000000000000000000001";
  const secondary = "whsec_testvector0000000000000000000000000002";
  const sk = seed("webhook signing key");
  const pk = ed25519.getPublicKey(sk);
  const kid = "wh-test-1";
  const timestamp = 1793873400;
  const rawBody =
    '{"id":"evt_01jbz9k3m4n5p6q7r8s9t0v1w2","object":"event","type":"payment_intent.succeeded","api_version":"2026-11-01","created":1793873400,"livemode":false,"data":{"object":{"id":"pi_01jbz9k3m4n5p6q7r8s9t0v1w2","object":"payment_intent","amount":200,"currency":"usd","note":"naïve ✓"}},"request":{"id":null,"idempotency_key":null}}';
  const msg = enc.encode(signedPayload(timestamp, rawBody));
  const mac = (s: string) => hex(hmac(sha256, enc.encode(s), msg));
  const v1a = b64url(ed25519.sign(msg, sk));
  return {
    description:
      "v1 = hex(HMAC-SHA256(key = UTF-8 bytes of the full secret incl. `whsec_`, msg = UTF-8 `<t>.<raw body>`)); v1a = base64url(Ed25519 over the same bytes). Tolerance 300 s; compare in constant time; verify the raw body bytes.",
    secret,
    secondary_secret: secondary,
    ed25519: { kid, seed_hex: hex(sk), public_key_base64url: b64url(pk) },
    timestamp,
    raw_body: rawBody,
    signed_payload: signedPayload(timestamp, rawBody),
    header: formatSignatureHeader({ timestamp, v1: [mac(secret)], v1a, kid }),
    header_during_rotation: formatSignatureHeader({ timestamp, v1: [mac(secret), mac(secondary)], v1a, kid }),
    negative: [
      {
        reason: "body changed",
        raw_body: rawBody.replace("200", "201"),
        header: formatSignatureHeader({ timestamp, v1: [mac(secret)], v1a, kid }),
        now: timestamp,
      },
      {
        reason: "timestamp outside tolerance",
        raw_body: rawBody,
        header: formatSignatureHeader({ timestamp, v1: [mac(secret)], v1a, kid }),
        now: timestamp + 301,
      },
      {
        reason: "signed with another secret",
        raw_body: rawBody,
        header: formatSignatureHeader({ timestamp, v1: [mac("whsec_other00000000000000000000000000000000")], kid }),
        now: timestamp,
      },
    ],
    verify_at: timestamp + 10,
  };
}

// ---------------------------------------------------------------------------------------------
// NEAR Intents payloads (foundations §14)
// ---------------------------------------------------------------------------------------------

/** NEP-413 payload hash: sha256(borsh(u32 2^31+413) ‖ borsh(Nep413Payload)). */
function nep413Hash(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  const u32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
  };
  const str = (s: string) => {
    const bytes = enc.encode(s);
    return [u32(bytes.length), bytes];
  };
  const parts = [u32(2 ** 31 + 413), ...str(message), nonce, ...str(recipient), new Uint8Array([0])];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  return sha256(buf);
}

function erc191Hash(payload: string): Uint8Array {
  const bytes = enc.encode(payload);
  return keccak_256(new Uint8Array([...enc.encode(`\x19Ethereum Signed Message:\n${bytes.length}`), ...bytes]));
}

function intentsVectors() {
  const salt = Uint8Array.from(Buffer.from("252812b3", "hex"));
  const nonce = new Uint8Array(32);
  nonce.set(salt, 0);
  nonce.set(sha256(enc.encode("nonce vector")).slice(0, 28), 4);
  const nonceB64 = b64(nonce);
  const deadline = "2026-11-05T10:02:00.000Z";
  const binding = `np1:${bs58.encode(sha256(enc.encode("binding vector")))}`;
  const transfers = (payTo: string, fee: string) => [
    { intent: "transfer", receiver_id: payTo, tokens: { [USDC_NEAR]: "2000000" }, memo: binding },
    { intent: "transfer", receiver_id: "treasury.nearpay.near", tokens: { [USDC_NEAR]: fee }, memo: binding },
  ];

  // NEP-413 (NEAR implicit account)
  const edSk = seed("near payer key");
  const edPk = ed25519.getPublicKey(edSk);
  const implicit = hex(edPk);
  const nepMessage = JSON.stringify({ signer_id: implicit, deadline, intents: transfers("merchant.near", "6000") });
  const nepSig = ed25519.sign(nep413Hash(nepMessage, nonce, INTENTS_CONTRACT), edSk);
  const nep413: MultiPayloadT = MultiPayload.parse({
    standard: "nep413",
    payload: { recipient: INTENTS_CONTRACT, nonce: nonceB64, message: nepMessage },
    public_key: `ed25519:${bs58.encode(edPk)}`,
    signature: `ed25519:${bs58.encode(nepSig)}`,
  });

  // ERC-191 (EVM wallet → eth-implicit account 0x…)
  const kSk = seed("evm payer key");
  const kPkU = secp256k1.getPublicKey(kSk, false);
  const address = `0x${hex(keccak_256(kPkU.slice(1)).slice(-20))}`;
  const ercMessage: IntentMessage = {
    signer_id: address,
    verifying_contract: INTENTS_CONTRACT,
    deadline,
    nonce: nonceB64,
    intents: transfers("merchant.near", "6000") as IntentMessage["intents"],
  };
  const ercPayload = JSON.stringify(ercMessage);
  const rec = secp256k1.sign(erc191Hash(ercPayload), kSk, { prehash: false, format: "recovered" });
  const rsv = new Uint8Array([...rec.slice(1), rec[0] as number]); // noble: [v, r, s] → Verifier: r ‖ s ‖ v (v ∈ {0,1})
  const erc191 = MultiPayload.parse({
    standard: "erc191",
    payload: ercPayload,
    signature: `secp256k1:${bs58.encode(rsv)}`,
  });

  // raw_ed25519 (agents)
  const rawSk = seed("agent key");
  const rawPk = ed25519.getPublicKey(rawSk);
  const rawMessage: IntentMessage = { ...ercMessage, signer_id: hex(rawPk) };
  const rawPayload = JSON.stringify(rawMessage);
  const raw = MultiPayload.parse({
    standard: "raw_ed25519",
    payload: rawPayload,
    public_key: `ed25519:${bs58.encode(rawPk)}`,
    signature: `ed25519:${bs58.encode(ed25519.sign(enc.encode(rawPayload), rawSk))}`,
  });

  return {
    description:
      "MultiPayload vectors. NEP-413: ed25519 over sha256(borsh(u32 2147484061) ‖ borsh({message, nonce[32], recipient, callback_url: None})). ERC-191: secp256k1 over keccak256('\\x19Ethereum Signed Message:\\n' + len + payload), signature r‖s‖v with v∈{0,1}. raw_ed25519: ed25519 over the UTF-8 payload. Nonce = 4-byte Verifier salt ‖ 28 bytes.",
    salt_hex: "252812b3",
    nonce_base64: nonceB64,
    binding,
    nep413: {
      seed_hex: hex(edSk),
      signer_id: implicit,
      hash_hex: hex(nep413Hash(nepMessage, nonce, INTENTS_CONTRACT)),
      multipayload: nep413,
    },
    erc191: { private_key_hex: hex(kSk), address, hash_hex: hex(erc191Hash(ercPayload)), multipayload: erc191 },
    raw_ed25519: { seed_hex: hex(rawSk), signer_id: hex(rawPk), multipayload: raw },
  };
}

// ---------------------------------------------------------------------------------------------
// stage 3 — billing: tax arithmetic and billing periods (lld/billing.md §11)
// ---------------------------------------------------------------------------------------------

function billingTaxVectors() {
  const rate = (id: string, percentage: string, inclusive: boolean) => ({
    id,
    percentage,
    rate_ppm: taxPercentageToPpm(percentage),
    inclusive,
  });
  const vat19 = rate("txr_vat19", "19", true);
  const vat7 = rate("txr_vat7", "7", true);
  const nyc = rate("txr_nyc", "8.875", false);
  const ca = rate("txr_ca", "7.25", false);
  const city = rate("txr_city", "1.5", false);
  const cases: { name: string; lines: { unit_amount: string; quantity: number; rates: (typeof vat19)[] }[] }[] = [
    { name: "no tax", lines: [{ unit_amount: "4999", quantity: 2, rates: [] }] },
    { name: "exclusive 8.875%: 88.75 rounds to 89", lines: [{ unit_amount: "1000", quantity: 1, rates: [nyc] }] },
    {
      name: "exclusive 1.5%: exact half 1.5 rounds up to 2",
      lines: [{ unit_amount: "100", quantity: 1, rates: [city] }],
    },
    { name: "inclusive 19%", lines: [{ unit_amount: "11900", quantity: 1, rates: [vat19] }] },
    {
      name: "inclusive 19%: exact half 478.5 rounds up to 479",
      lines: [{ unit_amount: "999", quantity: 3, rates: [vat19] }],
    },
    { name: "two exclusive rates on one line", lines: [{ unit_amount: "1999", quantity: 1, rates: [ca, city] }] },
    { name: "two inclusive rates on one line", lines: [{ unit_amount: "10000", quantity: 1, rates: [vat19, vat7] }] },
    {
      name: "mixed lines: inclusive, exclusive, untaxed; per-line rounding (2 × 0.62 → 1 + 1, not 1)",
      lines: [
        { unit_amount: "333", quantity: 3, rates: [vat19] },
        { unit_amount: "1", quantity: 7, rates: [nyc] },
        { unit_amount: "1", quantity: 7, rates: [nyc] },
        { unit_amount: "500", quantity: 1, rates: [] },
      ],
    },
    {
      name: "asset base units beyond 2^53",
      lines: [{ unit_amount: "25000000000000000000", quantity: 3, rates: [nyc] }],
    },
  ];
  const s = (n: bigint) => n.toString();
  const anchor = Date.UTC(2026, 0, 31, 12, 0, 0) / 1000;
  const leap = Date.UTC(2028, 1, 29, 0, 0, 0) / 1000;
  return {
    description:
      "Normative billing arithmetic (lld/billing.md §11, `computeInvoiceTotals`, `periodBoundary`). Amounts are integer strings in the invoice currency (fiat minor units or asset base units). Tax per line: exclusive `round_half_up(amount × ppm / 10^6)`; inclusive `round_half_up(amount × ppm / (10^6 + Σppm))`; totals sum the rounded line taxes. Period boundaries are computed from the anchor with calendar months clamped to the month's last day.",
    tax_cases: cases.map((c) => {
      const totals = computeInvoiceTotals(
        c.lines.map((l) => ({ amount: BigInt(l.unit_amount) * BigInt(l.quantity), tax_rates: l.rates })),
      );
      return {
        name: c.name,
        lines: c.lines.map((l) => ({ ...l, rates: l.rates.map((r) => r.id) })),
        tax_rates: [vat19, vat7, nyc, ca, city].filter((r) => c.lines.some((l) => l.rates.includes(r))),
        expected: {
          lines: totals.lines.map((l) => ({
            amount: s(l.amount),
            taxes: l.taxes.map((t) => ({
              tax_rate: t.tax_rate,
              inclusive: t.inclusive,
              amount: s(t.amount),
              taxable_amount: s(t.taxable_amount),
            })),
          })),
          subtotal: s(totals.subtotal),
          tax: s(totals.tax),
          total: s(totals.total),
          total_excluding_tax: s(totals.total_excluding_tax),
          total_tax_amounts: totals.total_tax_amounts.map((t) => ({
            tax_rate: t.tax_rate,
            inclusive: t.inclusive,
            amount: s(t.amount),
            taxable_amount: s(t.taxable_amount),
          })),
        },
      };
    }),
    period_cases: [
      { anchor, interval: "month" as const, interval_count: 1, n: [0, 1, 2, 3, 13] },
      { anchor, interval: "month" as const, interval_count: 3, n: [1, 2] },
      { anchor: leap, interval: "year" as const, interval_count: 1, n: [1, 4] },
      { anchor, interval: "week" as const, interval_count: 2, n: [1, 2] },
      { anchor, interval: "day" as const, interval_count: 1, n: [1, 30] },
    ].map((p) => ({
      ...p,
      boundaries: p.n.map((n) => {
        const t = periodBoundary(p.anchor, p.interval, p.interval_count, n);
        return { n, unix: t, iso: new Date(t * 1000).toISOString() };
      }),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// stage 3 — agent-commerce: x402 `near-intents` (lld/agentpay.md §3.1)
// ---------------------------------------------------------------------------------------------

function nearIntentsVectors() {
  const resource = { url: "https://merchant.example/premium", description: "Premium data" };
  const ORIGIN_USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
  const bindingInput = X402NearIntentsBindingInput.parse({
    method: "near-intents",
    account_id: "acct_01jbz9k3m4n5p6q7r8s9t0v1w2",
    resource_url: resource.url,
    origin_network: "eip155:8453",
    origin_asset_id: ORIGIN_USDC_BASE,
    pay_to: "merchant.near",
    asset_id: USDC_NEAR,
    amount: "1000000",
    max_timeout_s: 1800,
    nonce16: hex(sha256(enc.encode("near-intents nonce vector")).slice(0, 16)),
    expires_at: 1794132300,
  });
  const bindingJcs = jcs(bindingInput);
  const binding = `np1:${bs58.encode(sha256(enc.encode(bindingJcs)))}`;
  const destination = { network: "near:mainnet", asset: USDC_NEAR, amount: "1000000", recipient: "merchant.near" };
  const unquoted = {
    scheme: "exact",
    network: "eip155:8453",
    amount: "",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "",
    maxTimeoutSeconds: 1800,
    extra: {
      assetTransferMethod: "near-intents",
      paymentFlow: "upfront",
      destination,
      indicativeAmount: "1012000",
      binding,
      deadline: "2026-11-08T10:05:00.000Z",
      originAssetId: ORIGIN_USDC_BASE,
      slippageTolerance: { min: 10, max: 300, default: 50 },
    },
  } as const;
  const paymentRequired = X402PaymentRequiredAny.parse({ x402Version: 2, resource, accepts: [unquoted] });
  const quotePayload = NearIntentsPaymentPayload.parse({
    x402Version: 2,
    resource: { url: resource.url },
    accepted: unquoted,
    payload: { type: "quote", refundTo: "0x2527D02599Ba641c19Fea793Cd0f9A6e8457c317", slippageTolerance: 50 },
  });

  // operation token: <kid>.<expiry>.<b64url(HMAC-SHA256(key, JCS(X402OperationTokenInput)))>
  const key = seed("x402 operation token key");
  const kid = "k1";
  const refundDeadline = "2026-11-08T10:32:00.000Z";
  const expiry = Date.parse(refundDeadline) / 1000 + 86_400;
  const depositAddress = "0x76b4c56085ED136a8744D52bE956396624a730E8";
  const tokenInput = X402OperationTokenInput.parse({
    v: 1,
    binding,
    network: "eip155:8453",
    deposit_address: depositAddress,
    deposit_memo: null,
    resource_url: resource.url,
    destination,
    expiry,
  });
  const tokenJcs = jcs(tokenInput);
  const mac = b64url(hmac(sha256, key, enc.encode(tokenJcs)));
  const operationToken = `${kid}.${expiry}.${mac}`;
  if (!parseOperationToken(operationToken)) throw new Error("operation token vector does not parse");
  const quote = NearIntentsVerifyResponse.parse({
    isValid: true,
    extra: { depositAddress, amountIn: "1012000", minAmountIn: "1007000", refundDeadline, operationToken },
  });
  if (!quote.extra) throw new Error("quote vector without extra");
  const quoted = quotedRequirements(paymentRequired.accepts[0] as never, quote.extra);
  const depositTx = "0x9bcff372aee89b648c922b850573b22387c31d693079f5e37cd255814e2d615a";
  const depositPayload = NearIntentsPaymentPayload.parse({
    x402Version: 2,
    resource: { url: resource.url },
    accepted: unquoted,
    payload: { type: "deposit", operationToken, depositAddress, txHash: depositTx },
  });
  const settled = NearIntentsSettleResponse.parse({
    success: true,
    transaction: "9gnJ1EoQy3yqCDqGKiCGJm6YrwTqwYbL1n9vFhJ3nWVd",
    network: "near:mainnet",
    payer: "0x2527D02599Ba641c19Fea793Cd0f9A6e8457c317",
    amount: "1000000",
    extra: { originNetwork: "eip155:8453", originTxHash: depositTx, agentPayment: "ap_01jbz9k3m4n5p6q7r8s9t0v1w2" },
  });
  const pending = NearIntentsSettleResponse.parse({
    success: false,
    errorReason: "settlement_pending",
    transaction: depositTx,
    network: "eip155:8453",
    payer: "0x2527D02599Ba641c19Fea793Cd0f9A6e8457c317",
    extra: { status: "PROCESSING" },
  });
  const failed = NearIntentsSettleResponse.parse({
    success: false,
    errorReason: "exact_near_intents_payment_failed",
    transaction: "",
    network: "eip155:8453",
    payer: "0x2527D02599Ba641c19Fea793Cd0f9A6e8457c317",
    extra: { status: "REFUNDED", refundTo: "0x2527D02599Ba641c19Fea793Cd0f9A6e8457c317" },
  });
  return {
    description:
      "x402 exact + near-intents (lld/agentpay.md §3.1). binding = 'np1:' + base58(sha256(UTF-8 JCS(X402NearIntentsBindingInput))). operationToken = kid '.' expiry '.' base64url-unpadded(HMAC-SHA256(key, UTF-8 JCS(X402OperationTokenInput))), expiry = refundDeadline + 86400 s; the facilitator recomputes the MAC from accepted.network, payload.depositAddress/depositMemo, resource.url and its own entry. quoted = quotedRequirements(unquoted, quote.extra). The key is TEST-ONLY.",
    binding: { input: bindingInput, jcs: bindingJcs, binding },
    operation_token: { key_hex: hex(key), kid, input: tokenInput, jcs: tokenJcs, mac, token: operationToken },
    headers: {
      payment_required_unquoted: paymentRequired,
      payment_signature_quote: quotePayload,
      verify_response_quote: quote,
      payment_required_quoted: { x402Version: 2, resource, accepts: [quoted] },
      payment_signature_deposit: depositPayload,
      payment_response_settled: settled,
      payment_response_pending: pending,
      payment_response_failed: failed,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// stage 4 — autodebit: subscription vault wire strings (lld/contracts-vault.md §3–§4, OQ-T-03)
// ---------------------------------------------------------------------------------------------

/** Every value below is reproduced byte for byte by the contract (test/fixtures/vault-contract-wire.json). */
function vaultVectors() {
  const payer = "alice.near";
  const merchant = "merchant-demo.near";
  const usdc = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
  const usdt = "usdt.tether-token.near";
  const ext = "sub_01jbz9k3m4n5p6q7r8s9t0v1w2";
  const start = "1794268800000000000"; // 2026-11-10T00:00:00Z
  const ev = <E extends VaultEvent>(e: E): E => VaultEventSchema.parse(e) as E;
  const env = { standard: VAULT_EVENT_STANDARD, version: VAULT_EVENT_VERSION } as const;
  const events: Record<string, VaultEvent> = {
    mandate_created: ev({
      ...env,
      event: "mandate_created",
      data: [
        {
          mandate_id: 7,
          payer,
          merchant_receiver: merchant,
          token: usdc,
          amount_per_period: "10000000",
          period_secs: 2_629_746,
          start_at: start,
          max_periods: null,
          fee_bps: 100,
          ext_ref: ext,
          receiver_kind: "intents_account",
          balance: "30000000",
        },
      ],
    }),
    mandate_created_max_periods_near_account: ev({
      ...env,
      event: "mandate_created",
      data: [
        {
          mandate_id: 8,
          payer,
          merchant_receiver: merchant,
          token: usdt,
          amount_per_period: "5000000",
          period_secs: 604_800,
          start_at: start,
          max_periods: 12,
          fee_bps: 0,
          ext_ref: "",
          receiver_kind: "near_account",
          balance: "5000000",
        },
      ],
    }),
    topped_up: ev({ ...env, event: "topped_up", data: [{ mandate_id: 7, amount: "10000000", balance: "40000000" }] }),
    collected: ev({
      ...env,
      event: "collected",
      data: [
        { mandate_id: 7, period: 1, amount: "10000000", merchant_share: "9900000", fee: "100000", balance: "30000000" },
      ],
    }),
    collected_fee_leg_failed: ev({
      ...env,
      event: "collected",
      data: [{ mandate_id: 7, period: 2, amount: "9900000", merchant_share: "9900000", fee: "0", balance: "20100000" }],
    }),
    collected_partial: ev({
      ...env,
      event: "collected",
      data: [{ mandate_id: 7, period: 3, amount: "4950000", merchant_share: "4950000", fee: "0", balance: "15150000" }],
    }),
    collect_failed: ev({
      ...env,
      event: "collect_failed",
      data: [{ mandate_id: 7, period: 4, reason: "merchant_transfer_failed" }],
    }),
    canceled: ev({ ...env, event: "canceled", data: [{ mandate_id: 7, by: payer, refunded: "15150000" }] }),
    canceled_refund_failed: ev({ ...env, event: "canceled", data: [{ mandate_id: 7, by: merchant, refunded: "0" }] }),
    withdrawn: ev({ ...env, event: "withdrawn", data: [{ mandate_id: 7, amount: "15150000" }] }),
    exhausted: ev({ ...env, event: "exhausted", data: [{ mandate_id: 8 }] }),
  };

  // Views, keys in the contract's struct order (JSON.stringify keeps insertion order).
  const view7 = {
    mandate_id: 7,
    payer,
    merchant_receiver: merchant,
    receiver_kind: "intents_account",
    token: usdc,
    amount_per_period: "10000000",
    period_secs: 2_629_746,
    start_at: start,
    max_periods: null,
    fee_bps: 100,
    collected_periods: 1,
    balance: "30000000",
    status: "active",
    in_flight: false,
    refund_in_flight: "0",
    ext_ref: ext,
    next_collect_at: (BigInt(start) + 2_629_746n * 1_000_000_000n).toString(),
  };
  const view8 = {
    mandate_id: 8,
    payer,
    merchant_receiver: merchant,
    receiver_kind: "near_account",
    token: usdt,
    amount_per_period: "5000000",
    period_secs: 604_800,
    start_at: start,
    max_periods: 12,
    fee_bps: 0,
    collected_periods: 12,
    balance: "1",
    status: "exhausted",
    in_flight: false,
    refund_in_flight: "0",
    ext_ref: "",
    next_collect_at: null,
  };
  const caps = (token: string) => ({ token, cap: "1000000000000", mandate_cap: "100000000000" });
  const views: Record<string, { method: string; args: Record<string, unknown>; result: unknown }> = {
    get_mandate: { method: "get_mandate", args: { mandate_id: 7 }, result: view7 },
    get_mandate_exhausted: { method: "get_mandate", args: { mandate_id: 8 }, result: view8 },
    get_mandate_missing: { method: "get_mandate", args: { mandate_id: 999 }, result: null },
    get_mandates_by_payer: { method: "get_mandates_by_payer", args: { payer }, result: [view7, view8] },
    next_collect_at: { method: "next_collect_at", args: { mandate_id: 7 }, result: view7.next_collect_at },
    next_collect_at_none: { method: "next_collect_at", args: { mandate_id: 8 }, result: null },
    get_config: {
      method: "get_config",
      args: {},
      result: {
        allowed_tokens: [usdc, usdt],
        fee_receiver: "treasury.nearpay.near",
        max_fee_bps: 500,
        intents_account: "intents.near",
        min_period_secs: VAULT_LIMITS.min_period_secs,
        caps: [caps(usdc), caps(usdt)],
        mandate_storage_cost: VAULT_LIMITS.mandate_storage_cost,
        storage_registration_cost: VAULT_LIMITS.storage_registration_cost,
      },
    },
    get_token_tvl: {
      method: "get_token_tvl",
      args: { token: usdc },
      result: { token: usdc, tvl: "30000000", cap: "1000000000000", mandate_cap: "100000000000" },
    },
    storage_balance_of: {
      method: "storage_balance_of",
      args: { account_id: payer },
      result: { total: "12000000000000000000000", available: "0" },
    },
    storage_balance_bounds: {
      method: "storage_balance_bounds",
      args: {},
      result: { min: VAULT_LIMITS.storage_registration_cost, max: null },
    },
  };

  const createMsg = {
    create_mandate: {
      merchant_receiver: merchant,
      receiver_kind: "intents_account" as const,
      amount_per_period: "10000000",
      period_secs: 2_629_746,
      start_at: null,
      max_periods: null,
      fee_bps: 100,
      ext_ref: ext,
    },
  };
  const rejectionLines = [
    ...VAULT_FUNDING_REJECTIONS.filter((c) => c !== "ERR_CAP_EXCEEDED"),
    ...VAULT_CAP_EXCEEDED_LOGS,
  ];
  const collectLog = formatVaultEventLog(events.collected as VaultEvent);
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const share = vaultSplit(10_000_000n, 100);
  return {
    description:
      "Subscription vault wire strings (lld/contracts-vault.md §3–§4.1): NEP-297 event lines exactly as the contract logs them (formatVaultEventLog), the stable error strings and rejection log lines, view results as the contract serialises them (`result_json` is the exact byte string a `query call_function` returns), the msg serialisation billing prepares, and the NEAR RPC shapes of a vault panic and of a collect outcome. The vault's unit tests and the sandbox stand-in's contract tests both assert against this file (OQ-T-03).",
    standard: VAULT_EVENT_STANDARD,
    version: VAULT_EVENT_VERSION,
    event_json_prefix: EVENT_JSON_PREFIX,
    events: Object.entries(events).map(([name, event]) => ({ case: name, event, log: formatVaultEventLog(event) })),
    errors: {
      codes: VAULT_ERRORS,
      funding_rejection_log_lines: rejectionLines,
      cap_exceeded_log_lines: VAULT_CAP_EXCEEDED_LOGS,
      collect_check_order: VAULT_COLLECT_ERRORS,
      cancel_check_order: VAULT_CANCEL_ERRORS,
      withdraw_check_order: VAULT_WITHDRAW_ERRORS,
      panic_messages: VAULT_ERRORS.map((c) => `${SMART_CONTRACT_PANICKED_PREFIX}${c}`),
      near_sdk_guards: NEAR_SDK_GUARD_MESSAGES,
    },
    views: Object.entries(views).map(([name, v]) => ({
      case: name,
      method: v.method,
      args: v.args,
      result_json: JSON.stringify(v.result),
    })),
    msgs: [
      { case: "create_mandate_start_now", msg: createMsg, json: vaultMsgJson(createMsg) },
      {
        case: "create_mandate_start_at",
        msg: { create_mandate: { ...createMsg.create_mandate, start_at: start, max_periods: 12 } },
        json: vaultMsgJson({ create_mandate: { ...createMsg.create_mandate, start_at: start, max_periods: 12 } }),
      },
      { case: "top_up", msg: { top_up: { mandate_id: 7 } }, json: vaultMsgJson({ top_up: { mandate_id: 7 } }) },
    ],
    split: [
      [10_000_000n, 100],
      [1n, 0],
      [1n, 1],
      [9_999n, 1],
      [0n, 500],
      [340282366920938463463374607431768211455n, 0],
      [100n, 10_000],
    ].map(([amount, bps]) => {
      const r = vaultSplit(amount as bigint, bps as number);
      return {
        amount_per_period: String(amount),
        fee_bps: bps,
        merchant_share: String(r.merchantShare),
        fee: String(r.fee),
      };
    }),
    period_secs_per_interval: VAULT_PERIOD_SECS_PER_INTERVAL,
    limits: VAULT_LIMITS,
    gas: VAULT_GAS,
    rpc: {
      collect_not_due_status: nearPanicStatus("ERR_NOT_DUE"),
      collect_success: {
        status: { SuccessValue: b64("true") },
        vault_receipt: {
          executor_id: "v1.vault.nearpay.near",
          logs: [collectLog],
          status_success_value_base64: b64("true"),
        },
        merchant_share: String(share.merchantShare),
        fee: String(share.fee),
      },
      call_function_result_bytes_get_mandate_missing: [...Buffer.from("null", "utf8")],
    },
    keeper: { on_tx_failure: VAULT_KEEPER_ON_TX_FAILURE, rules: VAULT_KEEPER_RULES },
    sandbox: { defaults: SANDBOX_VAULT_DEFAULTS, scenarios_by_amount_suffix: VAULT_SANDBOX_SCENARIOS },
  };
}

export function vectorOutputs(): Output[] {
  return [
    { path: "test-vectors/ids.json", content: toJson(idsVectors()) },
    { path: "test-vectors/destination-fingerprint.json", content: toJson(fingerprintVectors()) },
    { path: "test-vectors/sentinel-attestation.json", content: toJson(attestationVectors()) },
    { path: "test-vectors/attestation-ticket.json", content: toJson(ticketVectors()) },
    { path: "test-vectors/webhook-signatures.json", content: toJson(webhookVectors()) },
    { path: "test-vectors/intents-payloads.json", content: toJson(intentsVectors()) },
    // stage 3 — billing
    { path: "test-vectors/billing-tax.json", content: toJson(billingTaxVectors()) },
    // stage 3 — agent-commerce
    { path: "test-vectors/x402-near-intents.json", content: toJson(nearIntentsVectors()) },
    // stage 4 — autodebit
    { path: "test-vectors/vault.json", content: toJson(vaultVectors()) },
    // stage 4 — chains
    { path: "test-vectors/chains-solana-bitcoin.json", content: toJson(chainsVectors()) },
    { path: "test-vectors/destination-attestation.json", content: toJson(destinationAttestationVectors()) },
    { path: "test-vectors/solana-transfer.json", content: toJson(solanaTransferVectors()) },
  ];
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const check = process.argv.includes("--check");
  const stale = writeOutputs(vectorOutputs(), check);
  if (check && stale.length) {
    console.error(`test vectors are stale (run pnpm vectors):\n  ${stale.join("\n  ")}`);
    process.exit(1);
  }
  console.log(check ? "test vectors are up to date" : "test vectors written");
}
