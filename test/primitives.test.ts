import { describe, expect, it } from "vitest";
import {
  AssetId,
  BaseUnits,
  Binding,
  ChainId,
  CheckoutSessionCreate,
  decodeX402Header,
  encodeX402Header,
  FiatAmount,
  formatSignatureHeader,
  id,
  idPattern,
  Metadata,
  NearAccountId,
  parseSignatureHeader,
  signedPayload,
  Timestamp,
} from "../src/public-entry.js";

describe("primitives", () => {
  it("validates base units as non-negative integer strings ≤ 78 digits", () => {
    for (const ok of ["0", "1", "25000000", "9".repeat(78)]) expect(BaseUnits.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["", "-1", "01", "1.5", "1e6", "9".repeat(79), 1])
      expect(BaseUnits.safeParse(bad).success, String(bad)).toBe(false);
  });

  it("validates fiat amounts as safe non-negative integers (INV-5)", () => {
    expect(FiatAmount.safeParse(4999).success).toBe(true);
    expect(FiatAmount.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "4999"])
      expect(FiatAmount.safeParse(bad).success, String(bad)).toBe(false);
  });

  it("accepts real NEAR Intents asset ids", () => {
    for (const ok of [
      "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      "nep141:wrap.near",
      "nep245:v2_1.omni.hot.tg:56_11111111111111111111",
    ])
      expect(AssetId.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["nep141:", "erc20:0xabc", "nep141:Upper.near", "nep245:v2_1.omni.hot.tg:"])
      expect(AssetId.safeParse(bad).success, bad).toBe(false);
  });

  it("validates NEAR accounts, CAIP-2 chains, bindings and timestamps", () => {
    for (const ok of ["merchant.near", "a1", "0x42e06263bb5346ae6421ab1ec1019824e7b284e1", "f".repeat(64)])
      expect(NearAccountId.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["a", "Merchant.near", "a..near", "-a.near", "a".repeat(65)])
      expect(NearAccountId.safeParse(bad).success, bad).toBe(false);
    for (const ok of [
      "eip155:8453",
      "near:mainnet",
      "bip122:000000000019d6689c085ae165831e93",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    ])
      expect(ChainId.safeParse(ok).success, ok).toBe(true);
    expect(ChainId.safeParse("base").success).toBe(false);
    expect(Binding.safeParse("np1:5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ").success).toBe(false);
    expect(Binding.safeParse("np1:3yZe7d5Bcv1ZTkNe5U5w4mbR1XK8Wb1pXtZqYfVvR8c1").success).toBe(true);
    expect(Timestamp.safeParse("2026-11-05T10:00:00.000Z").success).toBe(true);
    expect(Timestamp.safeParse("2026-11-05T10:00:00+01:00").success).toBe(false);
  });

  it("limits metadata to 50 keys of ≤ 40 chars with values ≤ 500 chars", () => {
    const fifty = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, "v"]));
    expect(Metadata.safeParse(fifty).success).toBe(true);
    expect(Metadata.safeParse({ ...fifty, k50: "v" }).success).toBe(false);
    expect(Metadata.safeParse({ ["k".repeat(41)]: "v" }).success).toBe(false);
    expect(Metadata.safeParse({ k: "v".repeat(501) }).success).toBe(false);
  });

  it("validates ids per prefix", () => {
    expect(id("pi").safeParse("pi_01jwn6yf40fcq9yk9c3t56pqa0").success).toBe(true);
    expect(id("pi").safeParse("cs_01jwn6yf40fcq9yk9c3t56pqa0").success).toBe(false);
    expect(idPattern("acct").test("acct_8zzzzzzzzzzzzzzzzzzzzzzzzz")).toBe(false);
  });

  it("enforces the fiat/asset pricing combination", () => {
    const base = { success_url: "https://shop.example/thanks" };
    expect(CheckoutSessionCreate.safeParse({ ...base, amount: 200, currency: "usd" }).success).toBe(true);
    expect(
      CheckoutSessionCreate.safeParse({ ...base, amount: "2000000", currency: "asset", asset_id: "nep141:wrap.near" })
        .success,
    ).toBe(true);
    expect(CheckoutSessionCreate.safeParse({ ...base, amount: "200", currency: "usd" }).success).toBe(false);
    expect(
      CheckoutSessionCreate.safeParse({ ...base, amount: 200, currency: "asset", asset_id: "nep141:wrap.near" })
        .success,
    ).toBe(false);
    expect(CheckoutSessionCreate.safeParse({ ...base, amount: "1", currency: "asset" }).success).toBe(false);
    expect(
      CheckoutSessionCreate.safeParse({ ...base, amount: 200, currency: "usd", asset_id: "nep141:wrap.near" }).success,
    ).toBe(false);
    expect(CheckoutSessionCreate.safeParse({ ...base, amount: 200, currency: "usd", unknown_param: 1 }).success).toBe(
      false,
    );
  });
});

describe("webhook signature header", () => {
  const v1 = "a".repeat(64);
  const v1a = "b".repeat(86);
  it("round-trips", () => {
    const h = formatSignatureHeader({ timestamp: 1793873400, v1: [v1, "c".repeat(64)], v1a, kid: "wh-1" });
    expect(h).toBe(`t=1793873400,v1=${v1},v1=${"c".repeat(64)},v1a=${v1a},kid=wh-1`);
    expect(parseSignatureHeader(h)).toEqual({ timestamp: 1793873400, v1: [v1, "c".repeat(64)], v1a, kid: "wh-1" });
    expect(signedPayload(1, "{}")).toBe("1.{}");
  });
  it("rejects malformed headers and ignores unknown keys", () => {
    for (const bad of [
      "",
      "t=1",
      `v1=${v1}`,
      `t=x,v1=${v1}`,
      `t=1,t=2,v1=${v1}`,
      `t=1,v1=zz`,
      `t=1,v1=${v1},v1a=short`,
      "garbage",
      `t=1,v1=${v1},=x`,
    ]) {
      expect(parseSignatureHeader(bad), bad).toBeNull();
    }
    expect(parseSignatureHeader(`t=1,v1=${v1},v2=future`)).toEqual({ timestamp: 1, v1: [v1], v1a: null, kid: null });
    expect(() => formatSignatureHeader({ timestamp: 1, v1: [] })).toThrow();
    expect(() => formatSignatureHeader({ timestamp: -1, v1: [v1] })).toThrow();
  });
});

describe("x402 header codec", () => {
  it("round-trips UTF-8 JSON through standard base64", () => {
    const v = { x402Version: 2, resource: { url: "https://api.example/ünïcode?q=✓" } };
    const h = encodeX402Header(v);
    expect(h).toBe(Buffer.from(JSON.stringify(v)).toString("base64"));
    expect(decodeX402Header(h)).toEqual(v);
  });
  it("rejects invalid input", () => {
    expect(() => decodeX402Header("%%%")).toThrow();
    expect(() => decodeX402Header(Buffer.from([0xff, 0xfe]).toString("base64"))).toThrow();
  });
});
