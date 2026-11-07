/**
 * nearpay-sandbox (lld/sandbox.md §3): a 1Click-compatible API plus simulated chains and Verifier.
 * Internal network only; every call needs a service token with `sandbox.use`; live-mode calls are
 * rejected (INV-8).
 */
import {
  AssetId,
  BaseUnits,
  ChainAddress,
  ChainId,
  closedEnum,
  inp,
  MultiPayload,
  NearAccountId,
  out,
  route,
  TxHash,
  z,
} from "@nearpay/spec";
import {
  OneClickQuoteRequest,
  OneClickQuoteResponse,
  OneClickStatusResponse,
  OneClickSubmitDepositRequest,
  OneClickToken,
} from "./oneclick.js";

const SANDBOX_AUTH = ["service:sandbox.use"] as const;

/**
 * Sandbox quote request: the 1Click request plus the merchant-facing amount that picks the
 * test-mode scenario (sandbox LLD §4: last two digits of the fiat amount in minor units, or of the
 * asset amount in base units). The quoted `amount` cannot carry it: it is the settlement amount
 * plus the amount tag. Rails' sandbox provider sets it; 1Click never sees it.
 */
export const SandboxQuoteRequest = OneClickQuoteRequest.extend({
  scenario_amount: z
    .string()
    .regex(/^\d{1,78}$/)
    .optional()
    .describe(
      "Pricing amount of the payment (fiat minor units or asset base units); its last two digits pick the scenario. Defaults to `amount`.",
    ),
  // stage 2 — payments
  scenario_group: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "Quotes of one payment (`pi_…`) or one refund (`re_…`). Scenario `06` (duplicate settlement) pays the other open quotes of the same group only; without it the sandbox groups as in Stage 1.",
    ),
  scenario_kind: z
    .enum(["payment", "refund"])
    .optional()
    .describe("`refund`: a refund leg (rails sets `scenario_amount` to the refund amount). Default `payment`."),
}).meta({
  id: "SandboxQuoteRequest",
  description: "Sandbox `POST /v0/quote` request (1Click request + scenario amount).",
});
export type SandboxQuoteRequest = z.infer<typeof SandboxQuoteRequest>;

export const sandboxTokens = route({
  id: "sandboxTokens",
  method: "GET",
  path: "/v0/tokens",
  service: "sandbox",
  visibility: "internal",
  summary: "1Click mirror: fixed token registry with fixed prices.",
  auth: SANDBOX_AUTH,
  idempotent: false,
  response: z.array(OneClickToken).meta({ id: "OneClickTokenList", description: "Tokens." }),
  status: 200,
  errors: [],
  stage: 1,
});

export const sandboxQuote = route({
  id: "sandboxQuote",
  method: "POST",
  path: "/v0/quote",
  service: "sandbox",
  visibility: "internal",
  summary: "1Click mirror: deterministic quote; scenario from the amount suffix or refund address.",
  auth: SANDBOX_AUTH,
  idempotent: false,
  body: SandboxQuoteRequest,
  response: OneClickQuoteResponse,
  status: 200,
  errors: [],
  stage: 1,
});

export const sandboxStatus = route({
  id: "sandboxStatus",
  method: "GET",
  path: "/v0/status",
  service: "sandbox",
  visibility: "internal",
  summary: "1Click mirror: scenario timeline status.",
  auth: SANDBOX_AUTH,
  idempotent: false,
  query: inp({
    depositAddress: z.string().describe("Deposit address."),
    depositMemo: z.string().optional().describe("Deposit memo."),
  }),
  response: OneClickStatusResponse,
  status: 200,
  errors: [],
  stage: 1,
});

export const sandboxSubmitDeposit = route({
  id: "sandboxSubmitDeposit",
  method: "POST",
  path: "/v0/deposit/submit",
  service: "sandbox",
  visibility: "internal",
  summary: "1Click mirror: mark a deposit detected.",
  auth: SANDBOX_AUTH,
  idempotent: false,
  body: OneClickSubmitDepositRequest,
  response: OneClickStatusResponse,
  status: 200,
  errors: [],
  stage: 1,
});

export const SimTx = out({
  finalized: z.boolean().describe("Final on the simulated chain."),
  transfers: z
    .array(
      out({
        token: AssetId.describe("Asset."),
        to: ChainAddress.describe("Recipient."),
        amount: BaseUnits.describe("Amount."),
      }).describe("A transfer."),
    )
    .describe("Transfers in the transaction."),
}).meta({ id: "SimTx", description: "A simulated chain transaction (sandbox verifiers)." });

export const sandboxGetTx = route({
  id: "sandboxGetTx",
  method: "GET",
  path: "/sim/chains/{chain}/tx/{hash}",
  service: "sandbox",
  visibility: "internal",
  summary: "Simulated chain: transaction transfers.",
  auth: SANDBOX_AUTH,
  idempotent: false,
  params: inp({ chain: ChainId, hash: TxHash }),
  response: SimTx,
  status: 200,
  errors: [],
  stage: 1,
});

export const sandboxSimulateDeposit = route({
  id: "sandboxSimulateDeposit",
  method: "POST",
  path: "/sim/deposits",
  service: "sandbox",
  visibility: "internal",
  summary: 'Simulate the payer\'s deposit (checkout "Simulate payment").',
  auth: SANDBOX_AUTH,
  idempotent: false,
  body: inp({
    deposit_address: ChainAddress.describe("Deposit address."),
    memo: z.string().optional().describe("Memo."),
    amount_in: BaseUnits.optional().describe("Deposit amount (default the quoted amountIn)."),
  }),
  response: null,
  status: 202,
  errors: ["state_conflict"],
  stage: 1,
});

export const sandboxAdvance = route({
  id: "sandboxAdvance",
  method: "POST",
  path: "/sim/advance",
  service: "sandbox",
  visibility: "internal",
  summary: "Move a simulated execution to a step.",
  auth: SANDBOX_AUTH,
  idempotent: false,
  body: inp({
    deposit_address: ChainAddress.describe("Deposit address."),
    memo: z.string().optional().describe("Memo."),
    to: closedEnum(["deposit", "processing", "success", "refund", "fail"], "Target step."),
  }),
  response: null,
  status: 202,
  errors: ["state_conflict"],
  stage: 1,
});

/** `simulate_intents` result (foundations §14). */
export const SimulateIntentsOutput = out({
  intents_executed: z
    .array(
      out({
        intent_hash: z.string().describe("Intent hash (base58)."),
        account_id: NearAccountId.describe("Signer."),
        nonce: z.string().describe("Nonce (base64)."),
      }).describe("An executed intent."),
    )
    .describe("Intents that would execute."),
  logs: z.array(z.string()).describe("Contract logs (`EVENT_JSON:…`)."),
  min_deadline: z.string().describe("Earliest payload deadline."),
  state: out({
    fee: z.number().describe("Verifier fee."),
    current_salt: z.string().describe("Current salt (hex)."),
  }).describe("Verifier state."),
}).meta({ id: "SimulateIntentsOutput", description: "Result of simulate_intents." });

const SignedBatch = inp({ signed: z.array(MultiPayload).min(1).max(64).describe("Signed payloads.") });

export const sandboxSimulateIntents = route({
  id: "sandboxSimulateIntents",
  method: "POST",
  path: "/sim/intents/simulate",
  service: "sandbox",
  visibility: "internal",
  summary: "Simulated Verifier `simulate_intents` (real signature checks).",
  auth: SANDBOX_AUTH,
  idempotent: false,
  body: SignedBatch,
  response: SimulateIntentsOutput,
  status: 200,
  errors: ["intent_invalid", "insufficient_balance"],
  stage: 1,
});

export const sandboxExecuteIntents = route({
  id: "sandboxExecuteIntents",
  method: "POST",
  path: "/sim/intents/execute",
  service: "sandbox",
  visibility: "internal",
  summary: "Simulated Verifier `execute_intents`; emits DIP-4 / NEP-245 events.",
  auth: SANDBOX_AUTH,
  idempotent: false,
  body: SignedBatch,
  response: out({
    tx_hash: TxHash.describe("Simulated transaction hash."),
    block_height: z.int().min(0).describe("Simulated block."),
    status: closedEnum(["success", "failure"], "Outcome."),
    failure: z.string().nullable().describe("Failure message."),
    intents_executed: SimulateIntentsOutput.shape.intents_executed,
  }).meta({ id: "SimExecuteResult", description: "Result of a simulated execute_intents." }),
  status: 200,
  errors: ["intent_invalid", "insufficient_balance"],
  stage: 1,
});

export const sandboxFundIntents = route({
  id: "sandboxFundIntents",
  method: "POST",
  path: "/sim/intents/fund",
  service: "sandbox",
  visibility: "internal",
  summary: "Credit a simulated Intents balance.",
  auth: SANDBOX_AUTH,
  idempotent: false,
  body: inp({
    account_id: NearAccountId.describe("Account."),
    token: AssetId.describe("Asset."),
    amount: BaseUnits.describe("Amount to add."),
  }),
  response: out({ balance: BaseUnits.describe("New balance.") }).meta({ id: "SimBalance", description: "Balance." }),
  status: 200,
  errors: [],
  stage: 1,
});

export const sandboxIntentsEvents = route({
  id: "sandboxIntentsEvents",
  method: "GET",
  path: "/sim/intents/events",
  service: "sandbox",
  visibility: "internal",
  summary: "Simulated indexer feed (rails sandbox adapter).",
  auth: SANDBOX_AUTH,
  idempotent: false,
  query: inp({
    cursor: z.coerce.number().int().min(0).default(0).describe("Return events with seq > cursor."),
    limit: z.coerce.number().int().min(1).max(500).default(100).describe("Max events."),
  }),
  response: out({
    events: z
      .array(
        out({
          seq: z.int().min(1).describe("Sequence."),
          tx_hash: TxHash.describe("Transaction."),
          block_height: z.int().min(0).describe("Block."),
          log: z.string().describe("`EVENT_JSON:` log line."),
        }).describe("An event."),
      )
      .describe("Events."),
    next_cursor: z.int().min(0).describe("Cursor for the next call."),
  }).meta({ id: "SimIntentsEvents", description: "Page of simulated Verifier events." }),
  status: 200,
  errors: [],
  stage: 1,
});

// stage 2 — payments
export const sandboxSimulateIntentsTransfer = route({
  id: "sandboxSimulateIntentsTransfer",
  method: "POST",
  path: "/sim/intents/transfers",
  service: "sandbox",
  visibility: "internal",
  summary: "Simulate an executed Verifier transfer without a signature (refund test helper).",
  description:
    "Test mode only by construction. Credits `from` with any shortfall first (like `/sim/intents/fund`), then moves `amount` to `to` and emits the DIP-4 `transfer` event with `memo` (and the NEP-245 `mt_transfer`) on the indexer feed, as a signed execute would. Used by payments `simulateRefundDeposit` for `intents_transfer` refund legs and INTENTS-deposit route legs.",
  auth: SANDBOX_AUTH,
  idempotent: false,
  body: inp({
    from: NearAccountId.describe("Sender Intents account (the merchant)."),
    to: NearAccountId.describe("Receiver Intents account (payer or deposit address)."),
    token: AssetId.describe("Asset."),
    amount: BaseUnits.describe("Amount."),
    memo: z.string().max(512).optional().describe("Memo (the leg binding)."),
  }),
  response: out({
    tx_hash: TxHash.describe("Simulated transaction hash."),
    block_height: z.int().min(0).describe("Simulated block."),
  }).meta({ id: "SimTransferResult", description: "A simulated transfer." }),
  status: 200,
  errors: [],
  stage: 2,
});
