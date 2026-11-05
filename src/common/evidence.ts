/** Settlement evidence (ADR-0012, lld/rails.md §5, §8.8). */
import { AssetId, BaseUnits, ChainAddress, ChainId, Timestamp, TxHash } from "./primitives.js";
import { openEnum, out, z } from "./schema.js";

export const EvidenceSource = openEnum(
  ["watcher", "indexer", "verifier", "provider", "operator"],
  "Detector that produced the evidence.",
);

export const Evidence = out({
  chain: ChainId.describe("Chain where the settlement happened."),
  tx_hash: TxHash.describe("Settlement transaction (NEAR receipt / tx hash for Intents)."),
  block_ref: z.string().nullable().describe("Block height or hash containing the transaction."),
  recipient: ChainAddress.describe("Recipient that received the funds (the merchant destination)."),
  asset_id: AssetId.describe("Asset that settled."),
  amount: BaseUnits.describe("Amount received by the recipient, base units."),
  finality: openEnum(["final", "finalized", "confirmed"], "Finality reached when the evidence was accepted."),
  tier: openEnum(
    ["A", "B"],
    "Verification tier: A = independently verified on chain, B = provider-attested within limits.",
  ),
  source: EvidenceSource,
  observed_at: Timestamp.describe("When NearPay accepted the evidence."),
  explorer_url: z.url().nullable().describe("Block-explorer link for the transaction."),
}).meta({ id: "Evidence", description: "Independent on-chain proof that a settlement reached the merchant (INV-2)." });
export type Evidence = z.infer<typeof Evidence>;
