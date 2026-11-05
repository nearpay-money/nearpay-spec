/** Public token registry (lld/rails.md §6: `GET /v1/assets`). */
import { AssetId, ChainId } from "../common/primitives.js";
import { route } from "../common/route.js";
import { out, z } from "../common/schema.js";

export const Asset = out({
  asset_id: AssetId,
  object: z.literal("asset").describe("Always `asset`."),
  chain: ChainId.describe("Chain the asset lives on."),
  symbol: z.string().describe("Token symbol."),
  decimals: z.int().min(0).max(255).describe("Decimals."),
  family: z.string().describe("Asset family for same-asset routing (`USDC`, `USDT`, `ETH`, …)."),
  is_usd_stable: z.boolean().describe("A USD stablecoin."),
}).meta({ id: "Asset", description: "An asset NearPay can price, route and settle." });

export const listAssets = route({
  id: "listAssets",
  method: "GET",
  path: "/v1/assets",
  service: "rails",
  visibility: "public",
  summary: "List enabled assets.",
  auth: ["anonymous"],
  idempotent: false,
  response: out({
    object: z.literal("list").describe("Always `list`."),
    data: z.array(Asset).describe("Enabled assets."),
    has_more: z.literal(false).describe("Always `false` (not paginated)."),
    url: z.literal("/v1/assets").describe("Path."),
  }).meta({ id: "AssetList", description: "All enabled assets." }),
  status: 200,
  errors: [],
  stage: 1,
});
