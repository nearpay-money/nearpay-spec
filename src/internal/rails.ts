/** Internal rails API (lld/rails.md §6, §8.1; refund legs: lld/payments.md §8.4, §17). */
import {
  AssetId,
  AttemptMethod,
  AttemptStatus,
  BaseUnits,
  Binding,
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
  NearAccountId,
  openEnum,
  out,
  route,
  SettlementDestinationType,
  Timestamp,
  TxHash,
  z,
} from "@nearpay/spec";
import { FeeSchedule } from "./identity.js";

export const RouteClass = openEnum(
  ["same_asset", "stable_pair", "volatile", "intents_transfer"],
  "Route class (rails §8.1).",
);
export const Provider = openEnum(["oneclick", "sandbox", "direct_intents"], "Route provider.");
export const ExecutionKind = openEnum(["payment", "refund"], "What the execution moves value for.");

// stage 2 — payments (refund legs; payments owns these shapes, rails implements them)
/** Which payments object an execution serves (copied by compliance into reviews; never public). */
export const ExecutionReference = out({
  payment_intent: id("pi"),
  payment_attempt: id("pa").nullable().describe("Payment attempt (`kind: payment`)."),
  refund: id("re").nullable().describe("Refund (`kind: refund`)."),
  refund_leg: z.int().min(1).nullable().describe("Refund leg number (`kind: refund`)."),
}).meta({ id: "ExecutionReference", description: "The payments object an execution belongs to." });

/** The single Verifier transfer a refund leg from an Intents account needs (signed by the merchant). */
export const RefundTransfer = out({
  signer_id: NearAccountId.describe("Merchant Intents account (the settlement destination) that signs."),
  receiver_id: NearAccountId.describe(
    "Payer Intents account (`intents_transfer` leg) or the 1Click INTENTS deposit address (`route_quote` leg).",
  ),
  token: AssetId.describe("Asset transferred (the settlement asset)."),
  amount: BaseUnits.describe("Amount, base units."),
  memo: Binding.describe("Binding memo the transfer must carry (agentpay matches it; the indexer attributes by it)."),
  deadline: Timestamp.describe("Latest acceptable payload deadline."),
}).meta({
  id: "RefundTransfer",
  description: "What a merchant signs for a refund leg from an Intents account: exactly one transfer, memo = binding.",
});

/** Refund-leg details of a `kind: refund` execution. */
export const ExecutionRefund = out({
  swap_type: closedEnum(["EXACT_INPUT", "EXACT_OUTPUT"], "Route quote type.")
    .nullable()
    .describe("Route legs only; null for `intents_transfer`."),
  amount: BaseUnits.describe("What the merchant sends, base units of the source (settlement) asset."),
  amount_out_expected: BaseUnits.nullable().describe(
    "What the payer should receive, base units of the recipient asset (quote `amountOut`).",
  ),
  min_amount_out: BaseUnits.nullable().describe("Quote `minAmountOut` (route legs)."),
  token: out({
    standard: openEnum(["native", "erc20", "nep141", "spl", "other"], "Token standard on the source chain."),
    address: z.string().nullable().describe("Contract / mint / NEP-141 account; null for native assets."),
  })
    .nullable()
    .describe("How to transfer the source asset on its chain (`sign_and_send` legs); null for Intents sources."),
  transfer: RefundTransfer.nullable().describe(
    "Set when the source is an Intents account: the transfer to sign (to the payer, or to the 1Click deposit address).",
  ),
}).meta({ id: "ExecutionRefund", description: "Refund-leg details of an execution (`kind: refund`)." });

export const PriceSnapshot = out({
  primary_usd: z.string().nullable().describe("Primary USD price of the settlement asset (decimal string)."),
  secondary_usd: z.string().nullable().describe("Secondary USD price (decimal string)."),
  fx: z.string().nullable().describe("FX rate pricing currency → USD (decimal string), null for USD."),
  par: z.boolean().describe("Settled at par (USD stablecoin, depeg guard passed)."),
  as_of: Timestamp.describe("When prices were read."),
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
  // stage 2 — payments (optional in 0.1.x; rails MUST send them from Stage 2)
  reference: ExecutionReference.nullable()
    .optional()
    .describe("Payments object served (from the create request); null for executions created before Stage 2."),
  refund: ExecutionRefund.nullable()
    .optional()
    .describe(
      "Refund legs: `origin` is the merchant side (asset, chain, `refund_to` = the merchant destination) and `settlement` the payer side (`recipient` = the payer's refund address, `tag` 0).",
    ),
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
  // stage 2 — payments
  reference: inp({
    payment_intent: id("pi"),
    payment_attempt: id("pa"),
  })
    .optional()
    .describe("Payments object served; echoed as `Execution.reference` (payments sends it from Stage 2)."),
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
  summary: "Executions that settled on a UTC day, with evidence.",
  auth: ["service:rails.read"],
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
// stage 2 — payments: refund legs (lld/payments.md §8.4, §17; rails §8.1 `kind: refund`)
// =============================================================================================

export const CreateRefundExecution = inp({
  idempotency_key: z
    .string()
    .min(1)
    .max(255)
    .describe("`refund:<re_id>:leg:<n>` — stable across retries of the same leg."),
  account_id: id("acct"),
  livemode: z.boolean().describe("Mode; selects the provider (INV-8)."),
  method: AttemptMethod.describe(
    "`route_quote`: 1Click route back to the payer's origin asset. `intents_transfer`: Verifier transfer to the payer's Intents account (source and recipient asset must be equal; provider `direct_intents`).",
  ),
  reference: inp({
    payment_intent: id("pi"),
    payment_attempt: id("pa", "Attempt whose settlement is refunded."),
    refund: id("re"),
    refund_leg: z.int().min(1).describe("Leg number."),
  }).describe("Payments objects served."),
  source: inp({
    asset_id: AssetId.describe("Settlement asset the merchant holds."),
    type: SettlementDestinationType,
    chain: ChainId.describe("Settlement chain."),
    address: ChainAddress.describe(
      "Merchant destination address or Intents account: the sender, and the 1Click `refundTo` of route legs.",
    ),
  }).describe("Merchant side: the intent's destination snapshot."),
  recipient: inp({
    asset_id: AssetId.describe("Asset the payer receives (the attempt's origin asset)."),
    chain: ChainId.describe("Chain the payer receives on."),
    address: ChainAddress.describe("Payer refund address (attempt `refund_to`) or Intents account."),
    type: closedEnum(["origin_chain", "intents"], "Recipient type."),
  }).describe("Payer side (INV-7)."),
  amount: BaseUnits.describe("Refund amount, base units of the source asset."),
  swap_type: closedEnum(
    ["EXACT_INPUT", "EXACT_OUTPUT"],
    "Route legs: `EXACT_INPUT` quotes `amount` in (payer absorbs route costs); `EXACT_OUTPUT` quotes the equivalent of `amount` out, converted by rails pricing (merchant absorbs). Ignored for `intents_transfer`.",
  ),
  screen: z
    .boolean()
    .optional()
    .describe("Screen the recipient even if cached (an owner override of the recipient, INV-7). Default false."),
}).meta({
  id: "CreateRefundExecution",
  description:
    "Create a refund leg: a route or Intents transfer from the merchant destination to the payer (no app fee).",
});

export const createRefundExecution = route({
  id: "createRefundExecution",
  method: "POST",
  path: "/internal/refund_executions",
  service: "rails",
  visibility: "internal",
  summary: "Prepare a refund leg (idempotent on idempotency_key) → execution with `kind: refund`.",
  description:
    "Screens the recipient (context `refund`), quotes without app fees and returns the execution view with `refund` set: route legs carry `deposit` (+ `refund.token`, or `refund.transfer` when the source is an Intents account: 1Click INTENTS deposit); `intents_transfer` legs carry `refund.transfer` with a fresh binding. Tracking, verification (payer-side evidence, INV-2) and events are those of payment executions (`evt.rails.execution.*`); `GET /internal/executions/{id}` and `POST /internal/executions/{id}/deposit_tx` apply unchanged. Sandbox: `scenario_amount` = `amount`, `scenario_group` = the refund id.",
  auth: ["service:rails.executions.write"],
  idempotent: true,
  body: CreateRefundExecution,
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
  ],
  stage: 2,
});
