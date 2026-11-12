/**
 * Asset id shapes (spec 0.5.2): the committed vectors match the parser, every live-list shape maps to the chain
 * 1Click names, the omdep Solana hash20 reproduces the SPL mint, and bridged-looking accounts are never NEAR.
 */
import { readFileSync } from "node:fs";
import { keccak_256 } from "@noble/hashes/sha3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  assetIdBlockchain,
  blockchainOfPrefix,
  parseAssetId,
  parseOmftAssetId,
  SPEC_VERSION,
} from "../src/public-entry.js";

const vectors = JSON.parse(readFileSync(new URL("../test-vectors/asset-ids.json", import.meta.url), "utf8")) as {
  cases: { asset_id: string; blockchain: string | null; parsed: unknown }[];
};

describe("asset-ids.json", () => {
  it("ships in spec 0.5.2", () => expect(SPEC_VERSION).toBe("0.5.2"));
  it("every case matches parseAssetId / assetIdBlockchain", () => {
    expect(vectors.cases.length).toBeGreaterThan(25);
    for (const c of vectors.cases) {
      expect(parseAssetId(c.asset_id)).toEqual(c.parsed);
      expect(assetIdBlockchain(c.asset_id)).toBe(c.blockchain);
    }
  });
});

describe("shapes from the live 1Click token list", () => {
  it.each([
    ["nep141:bnb-0x55d398326f99059ff775485246999027b3197955.omdep.near", "bsc"],
    ["nep141:bnb.omdep.near", "bsc"],
    ["nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near", "pol"],
    ["nep141:avax-0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e.omdep.near", "avax"],
    ["nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", "base"],
    ["1cs_v1:bsc:bep20:0x5382555840ef9f54ef6d3ee5da60f12bcabf4b87", "bsc"],
    ["1cs_v1:bnb:bep20:0x5382555840ef9f54ef6d3ee5da60f12bcabf4b87", "bsc"],
    ["1cs_v1:sol:spl:A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS", "sol"],
    ["1cs_v1:btc:native:coin", "btc"],
    ["nep141:wrap.near", "near"],
  ])("%s → %s", (id, chain) => expect(assetIdBlockchain(id)).toBe(chain));

  it("an omdep Solana token's 0x-written hash20 is hex(keccak256(mint)[12..32])", () => {
    const p = parseAssetId("nep141:sol-0xaad74c68eecfc9f8c5bdcea614f6167048c795ef.omdep.near");
    expect(p).toMatchObject({ scheme: "omdep", blockchain: "sol", kind: "hash20" });
    const mint = bs58.decode("2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv"); // PENGU, live list contractAddress
    expect(Buffer.from(keccak_256(mint).subarray(12)).toString("hex")).toBe((p as { token: string }).token);
  });

  it("EVM contracts are lower-cased; other token shapes are `bridged`", () => {
    expect(parseAssetId("nep141:base-0xC2BC2A4CD04358281C7CF36A057FC15E5552B18B.omdep.near")).toMatchObject({
      kind: "evm",
      token: "0xc2bc2a4cd04358281c7cf36a057fc15e5552b18b",
    });
    expect(parseAssetId("nep141:tron-TXYZ.omft.near")).toMatchObject({
      kind: "bridged",
      token: "TXYZ",
      blockchain: "tron",
    });
  });

  it("parseOmftAssetId stays omft-only (compat)", () => {
    expect(parseOmftAssetId("nep141:bnb.omdep.near")).toBeNull();
    expect(parseOmftAssetId("nep141:sol.omft.near")).toEqual({ blockchain: "sol", kind: "native", token: null });
  });
});

describe("safety rule: never guess NEAR", () => {
  it.each([
    "nep141:bnb-0x55d398326f99059ff775485246999027b3197955.omxyz.near",
    "nep141:avax.omnew.near",
    "nep141:eth.bridge.near",
    "nep141:sol-0xaad74c68eecfc9f8c5bdcea614f6167048c795ef.example.near",
    "nep141:x-0x55d398326f99059ff775485246999027b3197955.anything",
    "nep245:v2_1.omni.hot.tg:56_11111111111111111111",
    "1cs_v1:bsc",
    "",
    "NEP141:wrap.near",
  ])("%s → not derivable", (id) => {
    expect(assetIdBlockchain(id)).toBeNull();
    expect(parseAssetId(id).scheme).toBe("unknown");
  });

  it("plain NEAR tokens stay NEAR", () => {
    for (const id of [
      "nep141:wrap.near",
      "nep141:usdt.tether-token.near",
      "nep141:token.sweat",
      "nep141:853d955acef822db058eb8505911ed77f175b99e.factory.bridge.near",
      "nep141:ethan.near",
      "nep141:eth.near",
    ])
      expect(assetIdBlockchain(id)).toBe("near");
  });

  it("aliases", () => {
    expect(blockchainOfPrefix("bnb")).toBe("bsc");
    expect(blockchainOfPrefix("eth")).toBe("eth");
    expect(parseAssetId(42 as unknown as string).scheme).toBe("unknown");
  });
});
