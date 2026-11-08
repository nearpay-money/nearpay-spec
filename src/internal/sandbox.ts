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
import { ExplorerTransactionList, ExplorerTransactionsQuery } from "./explorer.js";
import {
  OneClickQuoteRequest,
  OneClickQuoteResponse,
  OneClickStatusResponse,
  OneClickSubmitDepositRequest,
  OneClickToken,
} from "./oneclick.js";
// stage 4 — autodebit
import { NearFinalExecutionOutcome, NearRpcRequest, NearRpcResponse } from "./vault.js";

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
        // spec 0.3.1 — rails fills Evidence.sender from it
        from: ChainAddress.nullable()
          .optional()
          .describe("Sender, when the simulated chain knows it (null/absent = unknown)."),
        to: ChainAddress.describe("Recipient."),
        amount: BaseUnits.describe("Amount."),
        // stage 4 — chains
        vout: z
          .int()
          .min(0)
          .nullable()
          .optional()
          .describe("Bitcoin: output index of this transfer; null/absent on other chains. Spec 0.4.0."),
        token_account: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Solana SPL: recipient token account (the ATA of `to` for the mint); null/absent for SOL and other chains. Spec 0.4.0.",
          ),
      }).describe("A transfer."),
    )
    .describe("Transfers in the transaction."),
  // stage 4 — chains
  block_ref: z
    .string()
    .nullable()
    .optional()
    .describe("Simulated slot (Solana) or block height (Bitcoin, EVM, NEAR); null/absent when unknown. Spec 0.4.0."),
  confirmations: z
    .int()
    .min(0)
    .nullable()
    .optional()
    .describe(
      "Bitcoin: confirmations now (0 = in the mempool; `finalized` is then false); null/absent on chains with a finality flag. Spec 0.4.0.",
    ),
  failed: z
    .boolean()
    .optional()
    .describe(
      "Solana: the transaction landed but failed (`meta.err` set; `transfers` empty). Absent = false. Spec 0.4.0.",
    ),
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
          // stage 4 — autodebit: receipt context of the vault stand-in's lines (rails §8.6 rules)
          receipt_id: z
            .string()
            .optional()
            .describe("Receipt that logged the line (always set for vault stand-in lines; Stage 4)."),
          log_index: z.int().min(0).optional().describe("Index of the line in that receipt's logs (Stage 4)."),
          executor_id: NearAccountId.optional().describe(
            "Executor of the receipt; absent = `intents.near` (the simulated Verifier). Vault stand-in lines carry the stand-in account (Stage 4).",
          ),
          block_hash: z.string().optional().describe("Block hash (Stage 4)."),
          block_timestamp: z.string().optional().describe("Block time in ns as a decimal string (Stage 4)."),
          receipt_status: closedEnum(["success", "failure"], "Receipt outcome (absent = success; Stage 4).").optional(),
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

// stage 2 — rails-fx
export const sandboxExplorerTransactions = route({
  id: "sandboxExplorerTransactions",
  method: "GET",
  path: "/api/v0/transactions",
  service: "sandbox",
  visibility: "internal",
  summary: "Explorer mirror: sandbox quotes as Explorer rows, newest first (rails Explorer feed in test mode).",
  description:
    "Same query and row schema as `GET explorer.near-intents.org/api/v0/transactions`; no rate limit. Rows are the sandbox's quotes with their current scenario status; `amountIn`/`amountOut` read `0` until the scenario settles, like the live Explorer.",
  auth: SANDBOX_AUTH,
  idempotent: false,
  query: ExplorerTransactionsQuery,
  response: ExplorerTransactionList,
  status: 200,
  errors: [],
  stage: 2,
});
// end stage 2 — rails-fx

// stage 4 — autodebit: sandbox vault stand-in (OQ-T-03, lld/sandbox.md §3.1, §4.2)
const SimVaultTokenAmount = BaseUnits.refine((v) => v !== "0", "must be > 0");

export const sandboxNearRpc = route({
  id: "sandboxNearRpc",
  method: "POST",
  path: "/sim/near-rpc",
  service: "sandbox",
  visibility: "internal",
  summary: "Vault stand-in: NEAR JSON-RPC subset (test-mode `NP_NEAR_RPC_URLS` of billing's keeper).",
  description:
    "Serves `NearRpcRequest` for the stand-in vault account (and NEP-141 `ft_balance_of` / `storage_balance_of` views of the test tokens) with mainnet shapes: `send_tx` / `broadcast_tx_commit` decode the borsh `SignedTransaction`, verify its ed25519 signature over sha256(transaction), require a nonce above the key's last one (keys register on first use, like the simulated Verifier) and execute `collect`, `cancel`, `withdraw`, `storage_deposit`, `storage_withdraw` or `storage_unregister` synchronously by the vault rules (contracts-vault §3.1–§3.8: check orders, `MIN_COLLECT_GAS`/`MIN_EXIT_GAS` from the action's gas, 1 yoctoNEAR, caps, periods, refunds). A vault error is `status.Failure` with `Smart contract panicked: ERR_…`; a success carries the exact `EVENT_JSON` lines (`formatVaultEventLog`) in the vault receipts' logs and `status.SuccessValue` = base64 of the return value. Every receipt with logs is also appended to `GET /sim/intents/events` (with `receipt_id`, `log_index`, `executor_id`). Always HTTP 200 with a JSON-RPC result or error, as NEAR RPC does.",
  auth: SANDBOX_AUTH,
  idempotent: false,
  body: NearRpcRequest,
  response: NearRpcResponse,
  status: 200,
  errors: [],
  stage: 4,
});

export const sandboxVaultFtTransferCall = route({
  id: "sandboxVaultFtTransferCall",
  method: "POST",
  path: "/sim/vault/ft_transfer_call",
  service: "sandbox",
  visibility: "internal",
  summary: "Vault stand-in: the payer's `ft_transfer_call` to the vault (create or top up a mandate).",
  description:
    "Stands in for the payer's wallet (no signature): mints the payer's shortfall of the test token first (like `/sim/intents/transfers`), then runs the token's `ft_transfer_call(receiver_id = vault, amount, msg)` with `payer` as signer and sender: the token receipt (NEP-141 `ft_transfer` log), the vault's `ft_on_transfer` (contracts-vault §3.1 check order; a rejection logs `ERR_…[: detail]` and returns the full amount) and the token's resolve (refund log). `payer` = `intents.near` or the vault is refused with `ERR_UNSUPPORTED_SENDER`, as on chain. Test mode only by construction.",
  auth: SANDBOX_AUTH,
  idempotent: false,
  body: inp({
    payer: NearAccountId.describe(
      "Payer (signer and NEP-141 sender); default for NearPay helpers `sandbox-payer.near`.",
    ),
    token: NearAccountId.describe(
      "Test token contract (one of the stand-in's allowed tokens, or any other to test `ERR_TOKEN_NOT_ALLOWED`).",
    ),
    amount: SimVaultTokenAmount.describe("Amount (base units)."),
    msg: z.string().max(4096).describe("The `msg` exactly as the payer would send it."),
  }),
  response: NearFinalExecutionOutcome,
  status: 200,
  errors: [],
  stage: 4,
});

export const sandboxVaultCall = route({
  id: "sandboxVaultCall",
  method: "POST",
  path: "/sim/vault/call",
  service: "sandbox",
  visibility: "internal",
  summary: "Vault stand-in: an unsigned change call as a named account (payer cancel/withdraw, storage).",
  description:
    "Same execution as a signed `send_tx` for the stand-in vault, without the signature (test helper for simulated payers and merchants). Gas and deposit are taken as given, so `ERR_GAS` and the 1-yocto guard are testable.",
  auth: SANDBOX_AUTH,
  idempotent: false,
  body: inp({
    signer: NearAccountId.describe("Account the call is made as (predecessor and signer)."),
    method: closedEnum(
      ["collect", "cancel", "withdraw", "storage_deposit", "storage_withdraw", "storage_unregister"],
      "Vault method.",
    ),
    args: z.record(z.string(), z.unknown()).describe('JSON arguments (e.g. `{"mandate_id": 7}`).'),
    gas: z
      .string()
      .regex(/^[1-9][0-9]{0,17}$/)
      .optional()
      .describe("Attached gas (default 100 Tgas; `collect` default 250 Tgas)."),
    deposit: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,38})$/)
      .optional()
      .describe("Attached yoctoNEAR (default `1` for cancel/withdraw/storage_withdraw/storage_unregister, else `0`)."),
  }),
  response: NearFinalExecutionOutcome,
  status: 200,
  errors: [],
  stage: 4,
});

export const SimVaultClock = out({
  mandate_id: z.int().min(0).describe("Vault mandate id."),
  clock_offset_secs: z.int().min(0).describe("Total seconds this mandate's clock is ahead of real time."),
  now_ns: z.string().describe("The mandate's clock now (ns)."),
  next_collect_at: z.string().nullable().describe("`next_collect_at` view after the advance (ns)."),
}).meta({ id: "SimVaultClock", description: "A stand-in mandate clock after an advance." });

export const sandboxVaultAdvance = route({
  id: "sandboxVaultAdvance",
  method: "POST",
  path: "/sim/vault/advance",
  service: "sandbox",
  visibility: "internal",
  summary: "Vault stand-in: move one mandate's clock forward (make the next period due).",
  description:
    "Each stand-in mandate has its own forward-only clock offset (like billing's per-subscription test clock), used for its due checks and `next_collect_at`; other mandates and block timestamps are unaffected. `secs` omitted = exactly up to the mandate's `next_collect_at` (no-op when already due). The 86 400 s minimum period is never lowered. billing's `advanceSubscriptionClock` calls it with the same delta for a subscription's linked mandate. Unknown or closed mandate → `404`.",
  auth: SANDBOX_AUTH,
  idempotent: false,
  body: inp({
    mandate_id: z.int().min(0).describe("Vault mandate id."),
    secs: z.int().min(1).max(379_468_800).optional().describe("Seconds to move forward."),
  }),
  response: SimVaultClock,
  status: 200,
  errors: [],
  stage: 4,
});
// end stage 4 — autodebit
