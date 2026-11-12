/**
 * asset-ids.json (spec 0.5.2): which chain an asset id names, for every shape 1Click uses (omft, omdep, 1cs_v1,
 * NEP-141) and the safety rule (bridged-looking NEP-141 accounts are not derivable). Ids are real entries of the live
 * 1Click token list (2026-11-07 fixture and 2026-11-12 pull), plus safety-rule probes. Consumers: sentinel (R4),
 * rails (token registry, verifiers, drift check), checkout (chains, wallets, QR), console, sandbox, agentkit.
 */
import { assetIdBlockchain, BRIDGE_PREFIX_ALIASES, parseAssetId } from "../src/public-entry.js";

const IDS = [
  // omft (unchanged)
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  "nep141:eth.omft.near",
  "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  "nep141:btc.omft.near",
  "nep141:hood.omft.near",
  // omdep (2026-11): EVM tokens, natives, the bnb prefix of BNB Smart Chain, Solana SPL with a 0x-written hash20
  "nep141:bnb-0x55d398326f99059ff775485246999027b3197955.omdep.near",
  "nep141:bnb.omdep.near",
  "nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near",
  "nep141:pol.omdep.near",
  "nep141:avax-0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e.omdep.near",
  "nep141:base-0xc2bc2a4cd04358281c7cf36a057fc15e5552b18b.omdep.near",
  "nep141:abs.omdep.near",
  "nep141:fogo.omdep.near",
  "nep141:sol-0xaad74c68eecfc9f8c5bdcea614f6167048c795ef.omdep.near",
  "nep141:strk-0xe646ef2a705bf5147ceffc8dfbcc7bee4946b8f7.omdep.near",
  // 1cs_v1
  "1cs_v1:base:erc20:0x0382e3fee4a420bd446367d468a6f00225853420",
  "1cs_v1:bsc:bep20:0x5382555840ef9f54ef6d3ee5da60f12bcabf4b87",
  "1cs_v1:sol:spl:A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS",
  "1cs_v1:btc:native:coin",
  "1cs_v1:near:nep141:zec.omft.near",
  "1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054",
  // NEAR NEP-141
  "nep141:wrap.near",
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "nep141:usdt.tether-token.near",
  "nep141:853d955acef822db058eb8505911ed77f175b99e.factory.bridge.near",
  "nep141:token.sweat",
  // not derivable
  "nep245:v2_1.omni.hot.tg:56_11111111111111111111",
  "nep141:bnb-0x55d398326f99059ff775485246999027b3197955.omxyz.near",
  "nep141:eth.bridge.near",
  "nep141:sol-0xaad74c68eecfc9f8c5bdcea614f6167048c795ef.example.near",
  "nep141:avax.omnew.near",
  "garbage",
];

export function assetIdVectors() {
  return {
    description:
      "Which chain an asset id names (spec 0.5.2, parseAssetId / assetIdBlockchain). `blockchain` is a 1Click blockchain code (aliases resolved: " +
      `${Object.entries(BRIDGE_PREFIX_ALIASES)
        .map(([a, b]) => `${a} → ${b}`)
        .join(", ")}` +
      "); null = not derivable (never guess NEAR): a chain check is skipped, never failed. omdep Solana tokens write the SPL hash20 as `sol-0x<hex>`.",
    cases: IDS.map((asset_id) => ({
      asset_id,
      blockchain: assetIdBlockchain(asset_id),
      parsed: parseAssetId(asset_id),
    })),
  };
}
