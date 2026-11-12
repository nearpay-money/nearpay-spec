/**
 * Asset ids → the chain the asset lives on (spec 0.5.2; incident 2026-11-11, lld/sentinel.md §5 R4, ADR-0028).
 *
 * 1Click names assets in several shapes, and the shapes change. Every NearPay service must derive a chain from an
 * id the same way — and must say "not derivable" instead of guessing:
 *
 * | Shape | Example | Chain |
 * |---|---|---|
 * | PoA bridge, `omft` | `nep141:base-0x8335….omft.near`, `nep141:sol.omft.near` | the prefix (a 1Click `blockchain` code) |
 * | PoA bridge, `omdep` (2026-11) | `nep141:bnb-0x55d3….omdep.near`, `nep141:sol-0x<hash20>.omdep.near` | the prefix, through {@link BRIDGE_PREFIX_ALIASES} (`bnb` → `bsc`) |
 * | 1Click v1 | `1cs_v1:bsc:bep20:0x…`, `1cs_v1:sol:spl:<mint>`, `1cs_v1:btc:native:coin` | the second segment (aliases apply) |
 * | NEAR NEP-141 | `nep141:wrap.near`, `nep141:17208628…` | `near` |
 * | anything else | `nep245:…`, a NEP-141 account that looks bridged | not derivable (null) |
 *
 * Safety rule: a `nep141:` account that is not an exact `omft`/`omdep` id but looks bridged — `<prefix>-0x<40 hex>.…`,
 * `<chain>.<x>.near`, or `<chain>[-…].om….near` (a future bridge suffix) — is NOT NEAR: it is not derivable. A wrong
 * chain claim refuses genuine payments (sentinel R4); "not derivable" only skips a check.
 *
 * The result is a 1Click `blockchain` code; kit `chains` maps it to CAIP-2 (`chainByBlockchain`). A code kit does not
 * know is, for chain comparisons, not derivable either.
 */

/** Bridge prefixes and v1 chain segments that differ from 1Click's `blockchain` code. */
export const BRIDGE_PREFIX_ALIASES: Readonly<Record<string, string>> = Object.freeze({ bnb: "bsc" });

/** PoA bridge account suffixes 1Click uses (`nep141:<prefix>[-<token>].<suffix>.near`). */
export const BRIDGE_SUFFIXES = ["omft", "omdep"] as const;
export type BridgeSuffix = (typeof BRIDGE_SUFFIXES)[number];

/**
 * 1Click `blockchain` codes and bridge prefixes seen in the live token list (2026-11-12), used only by the safety
 * rule (a NEP-141 account starting with one of these is treated as possibly bridged).
 */
export const KNOWN_CHAIN_PREFIXES: readonly string[] = Object.freeze([
  "abs",
  "adi",
  "aleo",
  "aptos",
  "arb",
  "avax",
  "base",
  "bch",
  "bera",
  "bnb",
  "bsc",
  "btc",
  "cardano",
  "dash",
  "doge",
  "eth",
  "fogo",
  "gnosis",
  "hood",
  "hypercore",
  "ltc",
  "miden",
  "monad",
  "movement",
  "op",
  "plasma",
  "pol",
  "scroll",
  "sol",
  "starknet",
  "stellar",
  "strk",
  "sui",
  "ton",
  "tron",
  "xlayer",
  "xrp",
  "zec",
]);
const KNOWN = new Set(KNOWN_CHAIN_PREFIXES);

/** The 1Click `blockchain` code a bridge prefix or v1 chain segment stands for. */
export function blockchainOfPrefix(prefix: string): string {
  return BRIDGE_PREFIX_ALIASES[prefix] ?? prefix;
}

export type AssetIdInfo =
  | {
      /** PoA bridge id `nep141:<prefix>[-<token>].<suffix>.near`. */
      readonly scheme: BridgeSuffix;
      readonly prefix: string;
      /** 1Click `blockchain` code (alias-resolved). */
      readonly blockchain: string;
      /**
       * `native`: the chain's coin; `evm`: an EVM token whose contract is `token` (lower-case `0x…`); `hash20`: a token
       * named by 20 bytes of a hash (Solana SPL: hex(keccak256(mint bytes)[12..32]), written `sol-<hex>` (omft) or
       * `sol-0x<hex>` (omdep); `token` is the bare hex); `bridged`: another token shape of that chain.
       */
      readonly kind: "native" | "evm" | "hash20" | "bridged";
      readonly token: string | null;
    }
  | {
      /** 1Click v1 id `1cs_v1:<chain>:<standard>:<address>`. */
      readonly scheme: "1cs_v1";
      readonly blockchain: string;
      readonly standard: string;
      readonly address: string;
    }
  | {
      /** A NEP-141 token on NEAR. */
      readonly scheme: "nep141";
      readonly blockchain: "near";
      readonly account: string;
    }
  | {
      /** Not derivable: `nep245:`, a bridged-looking NEP-141 account, or an unknown shape. */
      readonly scheme: "unknown";
      readonly reason: string;
    };

const BRIDGE = /^nep141:([a-z0-9]+)(?:-([0-9a-zA-Z]+))?\.(omft|omdep)\.near$/;
const V1 = /^1cs_v1:([a-z0-9_-]+):([a-z0-9_-]+):(\S+)$/;
const NEP141 = /^nep141:([a-z0-9][a-z0-9._-]*)$/;

/** Parses an asset id into the shape that says which chain the asset lives on (module doc). Never throws. */
export function parseAssetId(assetId: string): AssetIdInfo {
  if (typeof assetId !== "string") return { scheme: "unknown", reason: "not a string" };
  const b = BRIDGE.exec(assetId);
  if (b) {
    const prefix = b[1] as string;
    const blockchain = blockchainOfPrefix(prefix);
    const scheme = b[3] as BridgeSuffix;
    const raw = b[2];
    if (raw === undefined) return { scheme, prefix, blockchain, kind: "native", token: null };
    const t = raw.toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(t))
      return blockchain === "sol"
        ? { scheme, prefix, blockchain, kind: "hash20", token: t.slice(2) }
        : { scheme, prefix, blockchain, kind: "evm", token: t };
    if (/^[0-9a-f]{40}$/.test(t)) return { scheme, prefix, blockchain, kind: "hash20", token: t };
    return { scheme, prefix, blockchain, kind: "bridged", token: raw };
  }
  const v = V1.exec(assetId);
  if (v) {
    return {
      scheme: "1cs_v1",
      blockchain: blockchainOfPrefix(v[1] as string),
      standard: v[2] as string,
      address: v[3] as string,
    };
  }
  const n = NEP141.exec(assetId);
  if (n) {
    const account = n[1] as string;
    const labels = account.split(".");
    const head = (labels[0] as string).split("-")[0] as string;
    if (/^[a-z0-9]+-0x[0-9a-f]{40}\./.test(account))
      return { scheme: "unknown", reason: "a bridged-looking NEP-141 account (<prefix>-0x<40 hex>.…)" };
    if (KNOWN.has(head) && labels.length >= 3 && labels.at(-1) === "near") {
      if (/^om/.test(labels.at(-2) as string))
        return {
          scheme: "unknown",
          reason: `an unknown bridge suffix (.${labels.at(-2)}.near) for chain prefix ${head}`,
        };
      if (head === labels[0])
        return { scheme: "unknown", reason: `a NEP-141 account named after chain ${head} (<chain>.<x>.near)` };
    }
    return { scheme: "nep141", blockchain: "near", account };
  }
  return { scheme: "unknown", reason: "not an omft/omdep, 1cs_v1 or NEP-141 id" };
}

/** The 1Click `blockchain` code of the chain an asset lives on, or null when its id does not say (module doc). */
export function assetIdBlockchain(assetId: string): string | null {
  const a = parseAssetId(assetId);
  return a.scheme === "unknown" ? null : a.blockchain;
}
