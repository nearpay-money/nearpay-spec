/** Internal rails API (lld/rails.md §6, §8.1). */
import {
  AssetId,
  AttemptMethod,
  AttemptStatus,
  BaseUnits,
  BlockchainCode,
  Bps,
  ChainAddress,
  ChainId,
  Currency,
  closedEnum,
  Evidence,
  FiatAmount,
  IntentsRequirement,
  id,
  inp,
  openEnum,
  out,
  PricingAmount,
  PricingCurrency,
  route,
  SettlementDestinationType,
  Timestamp,
  TokenContract,
  TxHash,
  z,
} from "@nearpay/spec";
import { FeeSchedule } from "./identity.js";
import { FxRate, PriceRate } from "./pricing.js";

export const RouteClass = openEnum(
  ["same_asset", "stable_pair", "volatile", "intents_transfer"],
  "Route class (rails §8.1).",
);
export const Provider = openEnum(["oneclick", "sandbox", "direct_intents"], "Route provider.");
export const ExecutionKind = openEnum(["payment", "refund"], "What the execution moves value for.");

export const PriceSnapshot = out({
  primary_usd: z.string().nullable().describe("Primary USD price of the settlement asset (decimal string)."),
  secondary_usd: z.string().nullable().describe("Secondary USD price (decimal string)."),
  fx: z.string().nullable().describe("FX rate pricing currency → USD (decimal string), null for USD."),
  par: z.boolean().describe("Settled at par (USD stablecoin, depeg guard passed)."),
  as_of: Timestamp.describe("When prices were read."),
  currency: PricingCurrency.optional().describe(
    "Pricing currency of the payment (spec 0.1.6; rails 0.1.6+ always sends it): an ISO code, or `asset`.",
  ),
  par_currency: Currency.nullable()
    .optional()
    .describe("Currency the settlement asset was taken at par with (`usd` for USD stablecoins), or null (spec 0.1.6)."),
  rates: z
    .array(PriceRate)
    .optional()
    .describe(
      "Every rate used, exact, with source, `as_of` and `valid_until` (spec 0.1.6; rails 0.1.6+ always sends it): the FX rate of a non-USD currency and the primary + secondary prices of a non-par asset.",
    ),
}).meta({ id: "PriceSnapshot", description: "Prices used to compute the settlement amount (INV-6)." });

export const ExecutionDeposit = out({
  address: ChainAddress.describe("Deposit address."),
  memo: z.string().nullable().describe("Memo."),
  amount_in: BaseUnits.describe("Amount to send."),
  min_amount_in: BaseUnits.describe("Provider minimum."),
  chain: ChainId.describe("Origin chain."),
  deadline: Timestamp.describe("Deposit deadline."),
}).meta({ id: "ExecutionDeposit", description: "Deposit instructions of a `route_quote` execution." });

/** Execution view returned by the API and carried by `evt.rails.execution.*` (domain-model §4.3). */
export const Execution = out({
  id: id("ex"),
  version: z.int().min(1).describe("Increments with every applied change (consumers ignore stale versions)."),
  account_id: id("acct"),
  livemode: z.boolean().describe("Mode."),
  kind: ExecutionKind,
  method: AttemptMethod,
  provider: Provider,
  state: AttemptStatus,
  provider_status: z.string().nullable().describe("Last provider status (raw)."),
  route_class: RouteClass,
  applied_fee_bps: Bps.describe("Fee bps applied."),
  origin: out({
    asset_id: AssetId.describe("Origin asset."),
    chain: ChainId.describe("Origin chain."),
    refund_to: ChainAddress.describe("Refund address."),
    refund_type: closedEnum(["origin_chain", "intents"], "Refund address type."),
  }).describe("Payer side."),
  settlement: out({
    asset_id: AssetId.describe("Settlement asset."),
    amount_base: BaseUnits.describe("Settlement amount before the tag."),
    tag: BaseUnits.describe("Amount tag (0 = untagged)."),
    expected: BaseUnits.describe("Expected output = base + tag."),
    recipient: ChainAddress.describe("Merchant destination."),
    recipient_type: closedEnum(["destination_chain", "intents"], "Recipient type."),
    chain: ChainId.describe("Settlement chain."),
  }).describe("Merchant side."),
  price_snapshot: PriceSnapshot.nullable(),
  deposit: ExecutionDeposit.nullable().describe("`route_quote` deposit instructions."),
  intents_requirement: IntentsRequirement.nullable().describe("`intents_transfer` requirement."),
  deposit_tx_hashes: z.array(TxHash).describe("Deposit transactions known so far."),
  settled_amount: BaseUnits.nullable().describe("Amount that reached the recipient."),
  refunded_amount: BaseUnits.nullable().describe("Amount refunded to the payer."),
  refund_reason: z.string().nullable().describe("Provider refund reason."),
  evidence: Evidence.nullable().describe("Accepted evidence (INV-2)."),
  failure_code: z.string().nullable().describe("Failure code."),
  held_reason: openEnum(
    ["evidence_mismatch", "evidence_timeout", "failed_after_deposit", "unknown_status"],
    "Why held.",
  ).nullable(),
  deadline: Timestamp.describe("Execution deadline."),
  terminal_at: Timestamp.nullable().describe("When it reached a terminal state."),
  created_at: Timestamp.describe("Created."),
  updated_at: Timestamp.describe("Updated."),
}).meta({ id: "Execution", description: "A provider run moving value for a payment (rails owns)." });
export type Execution = z.infer<typeof Execution>;

export const CreateExecution = inp({
  idempotency_key: z.string().min(1).max(255).describe("`attempt:<pa_id>` (payments) — stable across retries."),
  kind: z.literal("payment").describe("Stage 1: payments only (refunds arrive in Stage 2)."),
  method: AttemptMethod,
  account_id: id("acct"),
  livemode: z.boolean().describe("Mode; selects the provider (INV-8)."),
  origin: inp({
    asset_id: AssetId.describe("Origin asset."),
    chain: ChainId.describe("Origin chain."),
    refund_to: ChainAddress.describe("Refund address (route_quote) or payer Intents account (intents_transfer)."),
    refund_type: closedEnum(["origin_chain", "intents"], "Refund address type."),
  }).describe("Payer side."),
  destination: inp({
    asset_id: AssetId.describe("Settlement asset."),
    type: SettlementDestinationType,
    chain: ChainId.describe("Settlement chain."),
    address: ChainAddress.describe("Destination address or Intents account."),
  }).describe("Snapshotted destination."),
  pricing: z
    .union([
      inp({ currency: Currency, amount: FiatAmount }).describe("Fiat pricing."),
      inp({ currency: z.literal("asset").describe("Asset pricing."), asset_id: AssetId, amount: BaseUnits }).describe(
        "Asset pricing.",
      ),
    ])
    .describe("Price of the payment."),
  fee: inp({ schedule: FeeSchedule, bearer: closedEnum(["payer", "merchant"], "Fee bearer.") }).describe(
    "Fee snapshot.",
  ),
  deadline_cap: Timestamp.nullable().describe("Session expiry, or null when late payments are allowed."),
  slippage_bps: Bps.optional().describe("Override slippage (default per route class)."),
}).meta({ id: "CreateExecution", description: "Create an execution for a payment attempt (rails §8.1)." });

const ExecParams = inp({ id: id("ex") });

/** Optional mode selector for reads that depend on the mode's token registry (test = sandbox registry). */
const OptionalMode = z
  .enum(["true", "false"])
  .transform((v) => v === "true")
  .optional()
  .describe("Mode whose token registry answers (test = sandbox registry). Omitted: live, falling back to test.");

export const createExecution = route({
  id: "createExecution",
  method: "POST",
  path: "/internal/executions",
  service: "rails",
  visibility: "internal",
  summary: "Quote and create an execution (idempotent on idempotency_key).",
  auth: ["service:rails.executions.write"],
  idempotent: true,
  body: CreateExecution,
  response: Execution,
  status: 201,
  errors: [
    "asset_unsupported",
    "route_unavailable",
    "pricing_unavailable",
    "screening_blocked",
    "screening_unavailable",
    "deadline_too_short",
    "quote_rejected",
    "quote_integrity_failed",
    "rail_unavailable",
    "currency_unsupported",
    "fx_rate_unavailable",
  ],
  stage: 1,
});

export const getExecution = route({
  id: "getExecution",
  method: "GET",
  path: "/internal/executions/{id}",
  service: "rails",
  visibility: "internal",
  summary: "An execution with its latest evidence.",
  auth: ["service:rails.read", "ops:rails.read"],
  idempotent: false,
  params: ExecParams,
  response: Execution,
  status: 200,
  errors: [],
  stage: 1,
});

export const lookupExecutionByDeposit = route({
  id: "lookupExecutionByDeposit",
  method: "GET",
  path: "/internal/executions",
  service: "rails",
  visibility: "internal",
  summary: "Did NearPay issue this deposit address? (sentinel kill-switch decision only)",
  auth: ["service:rails.read"],
  idempotent: false,
  query: inp({
    deposit_address: ChainAddress.describe("Deposit address."),
    memo: z.string().optional().describe("Deposit memo."),
  }),
  response: out({
    exists: z.boolean().describe("NearPay issued this deposit address."),
    execution_id: id("ex").nullable().describe("Execution, if it exists."),
    account_id: id("acct").nullable().describe("Account, if it exists."),
    livemode: z.boolean().nullable().describe("Mode, if it exists."),
  }).meta({ id: "DepositLookup", description: "Whether a deposit address was issued by NearPay." }),
  status: 200,
  errors: [],
  stage: 1,
});

export const InternalAsset = out({
  asset_id: AssetId,
  chain: ChainId.describe("Chain."),
  blockchain: BlockchainCode,
  symbol: z.string().describe("Symbol."),
  decimals: z.int().min(0).max(255).describe("Decimals."),
  family: z.string().describe("Asset family."),
  is_usd_stable: z.boolean().describe("USD stablecoin."),
  price_usd: z.string().nullable().describe("USD price (decimal string)."),
  price_ok: z.boolean().describe("Primary and secondary prices agree and are fresh (rails §8.2)."),
  as_of: Timestamp.nullable().describe("Price time."),
  peg_currency: Currency.nullable()
    .optional()
    .describe("Fiat currency the asset is a stablecoin of (`usd`, `eur`, …), or null (spec 0.1.6)."),
  par_ok: z
    .boolean()
    .optional()
    .describe("The depeg guard passes, so the asset settles at par with `peg_currency` (rails §8.2; spec 0.1.6)."),
  prices: z
    .array(PriceRate)
    .optional()
    .describe("Primary and secondary USD prices with source, `as_of` and `valid_until` (spec 0.1.6)."),
  token: TokenContract.nullable().optional().describe("On-chain token contract (CR-15-06; spec 0.1.6)."),
}).meta({ id: "InternalAsset", description: "An asset with pricing state." });

export const getInternalAsset = route({
  id: "getInternalAsset",
  method: "GET",
  path: "/internal/assets/{asset_id}",
  service: "rails",
  visibility: "internal",
  summary: "Asset decimals and price state.",
  auth: ["service:rails.read"],
  idempotent: false,
  params: inp({ asset_id: AssetId }),
  query: inp({ livemode: OptionalMode }),
  response: InternalAsset,
  status: 200,
  errors: ["asset_unsupported"],
  stage: 1,
});

export const submitExecutionDepositTx = route({
  id: "submitExecutionDepositTx",
  method: "POST",
  path: "/internal/executions/{id}/deposit_tx",
  service: "rails",
  visibility: "internal",
  summary: "Record a deposit tx and forward it to the provider (best effort).",
  auth: ["service:rails.executions.write"],
  idempotent: true,
  params: ExecParams,
  body: inp({ tx_hash: TxHash, sender: z.string().optional().describe("Sender (NEAR deposits).") }),
  response: null,
  status: 202,
  errors: ["state_conflict"],
  stage: 1,
});

export const signalExecution = route({
  id: "signalExecution",
  method: "POST",
  path: "/internal/executions/{id}/signals",
  service: "rails",
  visibility: "internal",
  summary: "Payer signal that raises polling priority.",
  auth: ["service:rails.executions.write"],
  idempotent: true,
  params: ExecParams,
  body: inp({ type: z.literal("payer_sent").describe("Signal type.") }),
  response: null,
  status: 202,
  errors: [],
  stage: 1,
});

export const InternalPaymentOption = out({
  method: AttemptMethod,
  origin_asset_id: AssetId.describe("Origin asset."),
  chain: ChainId.describe("Origin chain."),
  symbol: z.string().describe("Symbol."),
  decimals: z.int().min(0).max(255).describe("Decimals."),
  estimated_amount_in: BaseUnits.nullable().describe("Indicative amount in."),
  route_class: RouteClass,
  applied_fee_bps: Bps.describe("Fee bps."),
  min_deadline_s: z.int().min(0).describe("Minimum deposit window."),
  available: z.boolean().describe("Usable now."),
  reason: z.string().nullable().describe("Why unavailable."),
  token: TokenContract.nullable().optional().describe("Token contract to pay with (CR-15-06; spec 0.1.6)."),
}).meta({ id: "InternalPaymentOption", description: "Indicative option (rails view)." });

export const listInternalOptions = route({
  id: "listInternalOptions",
  method: "GET",
  path: "/internal/options",
  service: "rails",
  visibility: "internal",
  summary: "Indicative payment options for a destination and amount.",
  auth: ["service:rails.read"],
  idempotent: false,
  query: inp({
    destination_asset: AssetId.describe("Settlement asset."),
    destination_type: SettlementDestinationType,
    amount_out: BaseUnits.describe("Settlement amount."),
    chain: ChainId.optional().describe("Only this origin chain."),
    wallet: ChainAddress.optional().describe("Connected wallet."),
    livemode: OptionalMode,
  }),
  response: out({ options: z.array(InternalPaymentOption).describe("Options.") }).meta({
    id: "InternalPaymentOptions",
    description: "Indicative options.",
  }),
  status: 200,
  errors: [],
  stage: 1,
});

export const DestinationMinimum = out({
  min_amount_base: BaseUnits.nullable().describe("Minimum in base units of the asset."),
  min_usd_micros: z.int().min(0).nullable().describe("Minimum in USD micros."),
  computed_at: Timestamp.nullable().describe("When computed (null = unavailable)."),
}).meta({ id: "DestinationMinimum", description: "Minimum economic payment for a destination (rails §8.9)." });

export const getDestinationMinimums = route({
  id: "getDestinationMinimums",
  method: "GET",
  path: "/internal/destination-minimums",
  service: "rails",
  visibility: "internal",
  summary: "Minimum payment per destination key (`chain|address_norm|asset_id`).",
  auth: ["service:rails.read"],
  idempotent: false,
  query: inp({ keys: z.string().min(1).max(8192).describe("Comma-separated destination keys.") }),
  response: z.record(z.string(), DestinationMinimum).meta({ id: "DestinationMinimums", description: "Key → minimum." }),
  status: 200,
  errors: [],
  stage: 1,
});

export const ChainProfile = out({
  chain: ChainId,
  blockchain: BlockchainCode,
  family: openEnum(["evm", "near", "solana", "bitcoin", "other"], "Chain family."),
  tier: openEnum(["A", "B"], "Verification tier."),
  min_deadline_s: z.int().min(0).describe("Minimum deposit window."),
  default_deadline_s: z.int().min(0).describe("Default deposit window."),
  finality: z.string().describe("Finality rule."),
  verification_timeout_s: z.int().min(0).describe("Evidence timeout before `held`."),
  memo_mode: closedEnum(["none", "required"], "Memo mode."),
  explorer_tx_url: z.string().describe("Explorer URL template with `{tx}`."),
}).meta({ id: "ChainProfile", description: "Chain profile (public subset)." });

export const listChainProfiles = route({
  id: "listChainProfiles",
  method: "GET",
  path: "/internal/chain-profiles",
  service: "rails",
  visibility: "internal",
  summary: "Enabled chain profiles.",
  auth: ["service:rails.read"],
  idempotent: false,
  response: out({ profiles: z.array(ChainProfile).describe("Profiles.") }).meta({
    id: "ChainProfiles",
    description: "Profiles.",
  }),
  status: 200,
  errors: [],
  stage: 1,
});

export const listEvidence = route({
  id: "listEvidence",
  method: "GET",
  path: "/internal/evidence",
  service: "rails",
  visibility: "internal",
  summary: "Executions that reached a terminal state on a UTC day, with evidence.",
  description:
    "Default: executions that settled (`succeeded`) on the day, by `terminal_at`. Since spec 0.1.6 `states` and `kind` select other terminal states and refund legs (reconciliation, rails §8.10).",
  auth: ["service:rails.read", "ops:rails.read"],
  idempotent: false,
  query: inp({
    account_id: id("acct"),
    livemode: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .describe("Mode."),
    day: z.iso.date().describe("UTC day `YYYY-MM-DD`."),
    starting_after: id("ex").optional().describe("Cursor."),
    limit: z.coerce.number().int().min(1).max(1000).default(500).describe("Page size."),
    states: z
      .string()
      .regex(/^(succeeded|refunded|failed)(,(succeeded|refunded|failed))*$/)
      .optional()
      .describe("Comma-separated terminal states (default `succeeded`; spec 0.1.6)."),
    kind: ExecutionKind.optional().describe("Only payments or only refund legs (default both; spec 0.1.6)."),
  }),
  response: out({
    data: z.array(Execution).describe("Settled executions."),
    has_more: z.boolean().describe("More pages."),
  }).meta({ id: "EvidencePage", description: "Settled executions for a day." }),
  status: 200,
  errors: [],
  stage: 1,
});

// =============================================================================================
// stage 2 — rails-fx: pricing/FX (rails §8.2), observation archive (§8.11), reconciliation evidence
// (§8.10), ops reads for the console's Verifier holds & executions explorer (§6)
// =============================================================================================

const ModeQuery = z
  .enum(["true", "false"])
  .transform((v) => v === "true")
  .describe("Mode.");

export const FxRates = out({
  base: z.literal("usd").describe("Every rate is to USD."),
  livemode: z.boolean().describe("Mode whose sources answered (test mode: the fixed test table)."),
  currencies: z
    .array(FxRate)
    .describe("Pricing currencies rails accepts (`NP_PRICING_CURRENCIES`), `usd` first, each with its rate."),
  as_of: Timestamp.describe("When this answer was assembled."),
}).meta({ id: "FxRates", description: "Accepted pricing currencies and their FX rates to USD (rails §8.2)." });
export type FxRates = z.infer<typeof FxRates>;

export const listFxRates = route({
  id: "listFxRates",
  method: "GET",
  path: "/internal/fx-rates",
  service: "rails",
  visibility: "internal",
  summary: "Accepted pricing currencies with their current FX rate to USD, source, as_of and staleness.",
  description:
    "Payments uses it to answer `currency_unsupported` (currency absent) and `fx_rate_unavailable` (present but `available: false`) at session/intent creation, and to show the rate source; a stale rate is reported, never used.",
  auth: ["service:rails.read", "ops:rails.read"],
  idempotent: false,
  query: inp({
    livemode: OptionalMode,
    currencies: z
      .string()
      .regex(/^[a-z]{3}(,[a-z]{3}){0,49}$/)
      .optional()
      .describe("Comma-separated currencies to return (default all accepted)."),
  }),
  response: FxRates,
  status: 200,
  errors: [],
  stage: 2,
});

export const SettlementEstimate = out({
  pricing: out({
    amount: PricingAmount,
    currency: PricingCurrency,
    asset_id: AssetId.nullable().describe("Pricing asset when `currency` is `asset`."),
  }).describe("What was valued."),
  usd_micros: BaseUnits.describe("Value in USD micros, rounded down (integer string)."),
  settlement: out({
    asset_id: AssetId.describe("Settlement asset."),
    amount_base: BaseUnits.describe(
      "Settlement amount before fees and tag, rounded down (rails §8.2; the attempt computes the binding amount).",
    ),
    par: z.boolean().describe("Taken at par (stablecoin of the pricing currency, depeg guard passed)."),
  })
    .nullable()
    .describe("Settlement amount in `settlement_asset`, when one was asked for."),
  price_snapshot: PriceSnapshot,
}).meta({
  id: "SettlementEstimate",
  description: "Indicative valuation of a price in USD and in a settlement asset (not a quote; rails §8.2).",
});
export type SettlementEstimate = z.infer<typeof SettlementEstimate>;

export const estimateSettlement = route({
  id: "estimateSettlement",
  method: "GET",
  path: "/internal/settlement-estimate",
  service: "rails",
  visibility: "internal",
  summary: "Value a fiat or asset price in USD micros and, optionally, in a settlement asset.",
  description:
    "Same rules as execution pricing (par policy, dual-source prices, FX staleness). Payments compares `usd_micros` with destination minimums and the unverified-destination cap for non-USD prices, and uses `settlement.amount_base` as the options `amount_out`.",
  auth: ["service:rails.read", "ops:rails.read"],
  idempotent: false,
  query: inp({
    amount: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,77})$/)
      .describe("Fiat minor units, or asset base units when `currency` is `asset`."),
    currency: PricingCurrency,
    asset_id: AssetId.optional().describe("Pricing asset; required when `currency` is `asset`."),
    settlement_asset: AssetId.optional().describe("Also compute the settlement amount in this asset."),
    livemode: OptionalMode,
  }),
  response: SettlementEstimate,
  status: 200,
  errors: ["currency_unsupported", "asset_unsupported", "pricing_unavailable", "fx_rate_unavailable"],
  stage: 2,
});

export const ObservationSource = openEnum(
  ["quote", "submit", "hot_poll", "explorer", "indexer", "watcher", "verifier", "operator"],
  "Detector that recorded the observation (rails §4 `provider_observations.source`).",
);

export const ProviderObservation = out({
  id: id("obs"),
  execution_id: id("ex"),
  source: ObservationSource,
  provider_status: z.string().nullable().describe("Provider status in the payload (raw), if any."),
  provider_updated_at: Timestamp.nullable().describe("Provider's update time, if any."),
  applied: z.boolean().describe("The observation changed the execution (monotonic, changed-status rules, rails §5)."),
  observed_at: Timestamp.describe("When rails recorded it."),
  payload_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .describe("SHA-256 (hex) of the raw payload bytes as received; kept forever."),
  payload: z
    .unknown()
    .nullable()
    .describe("Raw provider payload (JSON); null once archived (fetch it with `archive`)."),
  archive: out({
    object_key: z.string().min(1).max(1024).describe("Object-storage key of the Parquet file."),
    row: z.int().min(0).describe("Row index inside the file."),
    archived_at: Timestamp.describe("When the payload moved."),
  })
    .nullable()
    .describe("Where the payload lives after the 90-day archive (rails §8.11), or null."),
}).meta({
  id: "ProviderObservation",
  description: "One raw provider/tracker observation of an execution (evidence trail).",
});
export type ProviderObservation = z.infer<typeof ProviderObservation>;

export const listExecutionObservations = route({
  id: "listExecutionObservations",
  method: "GET",
  path: "/internal/executions/{id}/observations",
  service: "rails",
  visibility: "internal",
  summary: "Observations of an execution, oldest first (archived ones carry their archive reference).",
  auth: ["service:rails.read", "ops:rails.read"],
  idempotent: false,
  params: ExecParams,
  query: inp({
    starting_after: id("obs").optional().describe("Cursor: last observation of the previous page."),
    limit: z.coerce.number().int().min(1).max(500).default(100).describe("Page size."),
  }),
  response: out({
    data: z.array(ProviderObservation).describe("Observations, oldest first."),
    has_more: z.boolean().describe("More pages."),
  }).meta({ id: "ProviderObservationPage", description: "Observations of an execution." }),
  status: 200,
  errors: [],
  stage: 2,
});

export const listOpsExecutions = route({
  id: "listOpsExecutions",
  method: "GET",
  path: "/internal/ops/executions",
  service: "rails",
  visibility: "internal",
  summary: "Executions across accounts for the console (Verifier holds, executions explorer), newest first.",
  description: "`state=held` lists open holds; `held_reason` narrows them. Always one mode at a time (INV-8).",
  auth: ["ops:rails.read"],
  idempotent: false,
  query: inp({
    livemode: ModeQuery,
    account_id: id("acct").optional().describe("Only this account."),
    state: AttemptStatus.optional().describe("Only this state."),
    held_reason: openEnum(
      ["evidence_mismatch", "evidence_timeout", "failed_after_deposit", "unknown_status"],
      "Only this hold reason.",
    ).optional(),
    kind: ExecutionKind.optional().describe("Only payments or refund legs."),
    provider: Provider.optional().describe("Only this provider."),
    deposit_address: ChainAddress.optional().describe("Only this deposit address."),
    created_gte: Timestamp.optional().describe("Created at or after."),
    created_lte: Timestamp.optional().describe("Created at or before."),
    starting_after: id("ex").optional().describe("Cursor: last execution of the previous page."),
    limit: z.coerce.number().int().min(1).max(100).default(50).describe("Page size."),
  }),
  response: out({
    data: z.array(Execution).describe("Executions, newest first."),
    has_more: z.boolean().describe("More pages."),
  }).meta({ id: "ExecutionPage", description: "A page of executions." }),
  status: 200,
  errors: [],
  stage: 2,
});

export const reverifyExecution = route({
  id: "reverifyExecution",
  method: "POST",
  path: "/internal/executions/{id}/reverify",
  service: "rails",
  visibility: "internal",
  summary: "Run the verifier again now for a held or verifying execution (e.g. after an RPC outage).",
  description:
    "Never forces a state: the execution moves only if the verifier now finds evidence (INV-2). Audited with the ops principal and reason (observation source `operator`).",
  auth: ["ops:rails.verify"],
  idempotent: true,
  params: ExecParams,
  body: inp({ reason: z.string().min(1).max(500).describe("Why (audited).") }),
  response: null,
  status: 202,
  errors: ["state_conflict"],
  stage: 2,
});

const TerminalState = closedEnum(["succeeded", "refunded", "failed"], "Terminal execution state.");

export const EvidenceSummary = out({
  account_id: id("acct"),
  livemode: z.boolean().describe("Mode."),
  day: z.iso.date().describe("UTC day `YYYY-MM-DD` (executions by `terminal_at`)."),
  complete: z
    .boolean()
    .describe(
      "The day is closed for rails: it has ended, every tracker cursor is past its end and no execution created on or before it is still non-terminal except holds (rails §8.10). Reconcile only complete days.",
    ),
  in_flight: z.int().min(0).describe("Executions of the account created on or before the day and still non-terminal."),
  held_open: z.int().min(0).describe("Of those, executions currently `held`."),
  totals: z
    .array(
      out({
        kind: ExecutionKind,
        state: TerminalState,
        asset_id: AssetId.describe("Settlement asset (payments) or origin asset returned to the payer (refunds)."),
        count: z.int().min(0).describe("Executions."),
        settled_amount: BaseUnits.describe("Sum of `settled_amount`."),
        refunded_amount: BaseUnits.describe("Sum of `refunded_amount`."),
      }).describe("Totals for one kind, state and asset."),
    )
    .describe("Totals of executions that reached a terminal state on the day."),
  tier_b: out({
    count: z.int().min(0).describe("Tier-B (provider-attested) settlements on the day."),
    explorer_confirmed: z.int().min(0).describe("Of those, confirmed by an Explorer row with the same status."),
    unconfirmed: z.array(id("ex")).describe("Tier-B settlements without a matching Explorer row yet."),
  }).describe("Tier-B cross-check against the Explorer (ADR-0012; empty when the Explorer feed is disabled)."),
  digest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .describe(
      "SHA-256 (hex) over the day's `(execution id, version)` pairs in id order; unchanged digest ⇒ unchanged evidence.",
    ),
  generated_at: Timestamp.describe("When computed."),
}).meta({ id: "EvidenceSummary", description: "Per-day evidence totals of one account (reconciliation input)." });
export type EvidenceSummary = z.infer<typeof EvidenceSummary>;

export const getEvidenceSummary = route({
  id: "getEvidenceSummary",
  method: "GET",
  path: "/internal/evidence/summary",
  service: "rails",
  visibility: "internal",
  summary: "Per-day evidence totals of an account (payments reconciliation, sentinel, console).",
  auth: ["service:rails.read", "ops:rails.read"],
  idempotent: false,
  query: inp({ account_id: id("acct"), livemode: ModeQuery, day: z.iso.date().describe("UTC day `YYYY-MM-DD`.") }),
  response: EvidenceSummary,
  status: 200,
  errors: [],
  stage: 2,
});
// end stage 2 — rails-fx
