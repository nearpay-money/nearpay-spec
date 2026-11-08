/**
 * stage 4 — autodebit: internal vault contracts (lld/rails.md §8.6, lld/billing.md §7–§7.1, §14,
 * lld/sandbox.md §3.1, §4.2; OQ-T-03).
 *
 * - `VaultEventRecord`: payload of `evt.rails.vault.event` (rails forwards a `nearpay_vault` event
 *   only from a successful, final receipt executed by the vault account).
 * - The NEAR JSON-RPC subset billing's keeper uses (external NEAR RPC in live mode, the sandbox
 *   vault stand-in in test mode — identical shapes, so one client serves both).
 * - Keeper outcome rules (billing §7.1) as data, and the stand-in's scenario table (sandbox §4.2).
 */
import {
  closedEnum,
  inp,
  NearAccountId,
  openEnum,
  out,
  SMART_CONTRACT_PANICKED_PREFIX,
  TxHash,
  type VaultErrorCode,
  VaultEvent,
  z,
} from "@nearpay/spec";

// =============================================================================================
// evt.rails.vault.event (rails §8.6)
// =============================================================================================

export const VaultEventRecord = out({
  vault_contract: NearAccountId.describe(
    "Executor of the receipt: the configured vault (`NP_VAULT_CONTRACT`; the sandbox stand-in in test mode).",
  ),
  tx_hash: TxHash.describe("Transaction the receipt belongs to (explorer link)."),
  receipt_id: z.string().min(1).max(64).describe("Receipt that logged the event (base58)."),
  log_index: z.int().min(0).describe("0-based index of the log line in the receipt's outcome logs."),
  block_height: z.int().min(0).describe("Final block that includes the receipt outcome."),
  block_hash: z.string().min(1).max(64).describe("Hash of that block."),
  block_timestamp: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,19})$/)
    .describe("Block time in nanoseconds (decimal string); billing's `created`/`collected_at`."),
  event: VaultEvent,
}).meta({
  id: "VaultEventRecord",
  description:
    "A valid vault event (contracts-vault §4.1): executor = the vault, outcome `SuccessValue`/`SuccessReceiptId`, block final, schema-valid. Dedupe key `receipt_id:log_index` (at-least-once, INV-4). Envelope: `account_id` null, `livemode` true for the mainnet vault and false for the stand-in, aggregate `vault_mandate` `<vault_contract>#<mandate_id>`.",
});
export type VaultEventRecord = z.infer<typeof VaultEventRecord>;

/** Dedupe key of a forwarded vault event. */
export function vaultEventDedupeKey(r: Pick<VaultEventRecord, "receipt_id" | "log_index">): string {
  return `${r.receipt_id}:${r.log_index}`;
}

/** Reasons rails drops a `nearpay_vault` log instead of forwarding it (`vault_event_rejected_total{reason}`). */
export const VAULT_EVENT_REJECT_REASONS = [
  "wrong_executor",
  "failed_receipt",
  "not_final",
  "bad_version",
  "bad_schema",
] as const;

// =============================================================================================
// NEAR JSON-RPC subset (keeper ↔ NEAR RPC | sandbox stand-in)
// =============================================================================================

const JsonRpcId = z.union([z.string().max(128), z.int()]).describe("JSON-RPC request id (echoed).");
const Finality = closedEnum(["final", "optimistic"], "Block finality.");
const Base58Hash = z.string().min(32).max(64).describe("Base58 hash.");

export const NearRpcBlockParams = inp({ finality: Finality }).describe("`block` params (latest block).");

export const NearRpcCallFunctionParams = inp({
  request_type: z.literal("call_function").describe("View call."),
  finality: Finality,
  account_id: NearAccountId.describe("Contract (the vault, or a token for `ft_balance_of`)."),
  method_name: z.string().min(1).max(256).describe("View method."),
  args_base64: z.string().max(8192).describe("Base64 of the JSON arguments."),
}).describe("`query` call_function params.");

export const NearRpcViewAccessKeyParams = inp({
  request_type: z.literal("view_access_key").describe("Access key lookup (nonce before signing)."),
  finality: Finality,
  account_id: NearAccountId.describe("Signer account."),
  public_key: z
    .string()
    .regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/)
    .describe("`ed25519:<base58>` key."),
}).describe("`query` view_access_key params.");

export const NearTxWaitUntil = closedEnum(
  ["NONE", "INCLUDED", "EXECUTED_OPTIMISTIC", "INCLUDED_FINAL", "EXECUTED", "FINAL"],
  "`send_tx` wait level; the keeper waits for `FINAL` (the stand-in executes synchronously and answers every level with the final outcome).",
);

export const NearRpcSendTxParams = inp({
  signed_tx_base64: z.string().min(1).max(65_536).describe("Base64 of the borsh `SignedTransaction`."),
  wait_until: NearTxWaitUntil.optional(),
}).describe("`send_tx` params.");

export const NearRpcTxParams = inp({
  tx_hash: Base58Hash.describe("Transaction hash."),
  sender_account_id: NearAccountId.describe("Signer."),
  wait_until: NearTxWaitUntil.optional(),
}).describe("`tx` params (status of a sent transaction, e.g. after a transport error).");

export const NearRpcRequest = z
  .discriminatedUnion("method", [
    inp({
      jsonrpc: z.literal("2.0").describe("JSON-RPC version."),
      id: JsonRpcId,
      method: z.literal("block").describe("Latest block (hash for signing)."),
      params: NearRpcBlockParams,
    }),
    inp({
      jsonrpc: z.literal("2.0").describe("JSON-RPC version."),
      id: JsonRpcId,
      method: z.literal("query").describe("View call or access key."),
      params: z.union([NearRpcCallFunctionParams, NearRpcViewAccessKeyParams]).describe("Query params."),
    }),
    inp({
      jsonrpc: z.literal("2.0").describe("JSON-RPC version."),
      id: JsonRpcId,
      method: z.literal("send_tx").describe("Submit a signed transaction."),
      params: NearRpcSendTxParams,
    }),
    inp({
      jsonrpc: z.literal("2.0").describe("JSON-RPC version."),
      id: JsonRpcId,
      method: z.literal("broadcast_tx_commit").describe("Submit and wait (legacy form of `send_tx`)."),
      params: z.tuple([z.string().min(1).max(65_536)]).describe("`[signed_tx_base64]`."),
    }),
    inp({
      jsonrpc: z.literal("2.0").describe("JSON-RPC version."),
      id: JsonRpcId,
      method: z.literal("tx").describe("Transaction status."),
      params: NearRpcTxParams,
    }),
  ])
  .meta({
    id: "NearRpcRequest",
    description:
      "The NEAR JSON-RPC subset the keeper uses (`block`, `query` call_function / view_access_key, `send_tx`, `broadcast_tx_commit`, `tx`). The sandbox stand-in serves exactly this subset; other methods answer `METHOD_NOT_FOUND`.",
  });
export type NearRpcRequest = z.infer<typeof NearRpcRequest>;

/** Failure of a function call (the shape a vault panic takes in a transaction outcome). */
export const NearTxExecutionError = out({
  ActionError: out({
    index: z.int().min(0).nullable().describe("Index of the failed action."),
    kind: out({
      FunctionCallError: out({
        ExecutionError: z.string().describe("`Smart contract panicked: <message>` (vault: `ERR_…`)."),
      })
        .optional()
        .describe("Contract panic."),
    }).describe("Failure kind (other kinds pass through untyped)."),
  })
    .optional()
    .describe("An action failed."),
  InvalidTxError: z.unknown().optional().describe("The transaction itself was invalid."),
}).meta({ id: "NearTxExecutionError", description: "`TxExecutionError` (loose)." });

export const NearExecutionStatus = z
  .union([
    out({ SuccessValue: z.string().describe("Base64 of the return value (vault `collect`: `true`/`false`).") }),
    out({ SuccessReceiptId: z.string().describe("Receipt the outcome continues in.") }),
    out({ Failure: NearTxExecutionError }),
    z.literal("Unknown").describe("Not executed yet."),
  ])
  .describe("Execution status of a transaction or receipt.");

export const NearExecutionOutcomeWithId = out({
  id: z.string().describe("Receipt (or transaction) id."),
  block_hash: z.string().describe("Block that included the outcome."),
  outcome: out({
    logs: z.array(z.string()).describe("Log lines (`EVENT_JSON:…`, rejection codes)."),
    receipt_ids: z.array(z.string()).describe("Receipts it created."),
    gas_burnt: z.int().min(0).describe("Gas burnt."),
    tokens_burnt: z.string().describe("yoctoNEAR burnt."),
    executor_id: NearAccountId.describe("Account that executed it (rails checks = the vault)."),
    status: NearExecutionStatus,
  }).describe("Outcome."),
}).meta({ id: "NearExecutionOutcomeWithId", description: "A transaction or receipt outcome." });

export const NearFinalExecutionOutcome = out({
  final_execution_status: NearTxWaitUntil.optional(),
  status: NearExecutionStatus.describe("Overall status: `Failure` when any receipt of the call chain panicked first."),
  transaction: out({
    signer_id: NearAccountId.describe("Signer."),
    public_key: z.string().describe("Signer key."),
    nonce: z.int().min(0).describe("Nonce."),
    receiver_id: NearAccountId.describe("Receiver."),
    hash: z.string().describe("Transaction hash."),
  }).describe("The transaction (actions omitted from the contract; the stand-in echoes them)."),
  transaction_outcome: NearExecutionOutcomeWithId,
  receipts_outcome: z.array(NearExecutionOutcomeWithId).describe("Every receipt outcome, in execution order."),
}).meta({ id: "NearFinalExecutionOutcome", description: "`send_tx` / `broadcast_tx_commit` / `tx` result (loose)." });
export type NearFinalExecutionOutcome = z.infer<typeof NearFinalExecutionOutcome>;

export const NearCallFunctionResult = out({
  result: z.array(z.int().min(0).max(255)).describe("UTF-8 bytes of the JSON return value."),
  logs: z.array(z.string()).describe("Logs (views log nothing)."),
  block_height: z.int().min(0).describe("Block."),
  block_hash: z.string().describe("Block hash."),
}).meta({ id: "NearCallFunctionResult", description: "`query` call_function result." });

export const NearAccessKeyResult = out({
  nonce: z.int().min(0).describe("Last used nonce."),
  permission: z
    .union([
      z.literal("FullAccess").describe("Full access."),
      out({
        FunctionCall: out({
          allowance: z.string().nullable().describe("Remaining allowance (yoctoNEAR); null = unlimited."),
          receiver_id: NearAccountId.describe("Only this contract."),
          method_names: z.array(z.string()).describe("Only these methods (empty = any)."),
        }).describe("Function-call permission."),
      }),
    ])
    .describe("Key permission."),
  block_height: z.int().min(0).describe("Block."),
  block_hash: z.string().describe("Block hash (signers use it as the transaction's recent block hash)."),
}).meta({ id: "NearAccessKeyResult", description: "`query` view_access_key result." });

export const NearBlockResult = out({
  header: out({
    height: z.int().min(0).describe("Height."),
    hash: z.string().describe("Block hash."),
    timestamp_nanosec: z.string().describe("Block time (ns, decimal string)."),
  }).describe("Block header (loose)."),
}).meta({ id: "NearBlockResult", description: "`block` result (loose)." });

export const NearRpcError = out({
  name: z.string().describe("`HANDLER_ERROR`, `REQUEST_VALIDATION_ERROR` or `INTERNAL_ERROR`."),
  cause: out({
    name: z
      .string()
      .describe(
        "E.g. `INVALID_TRANSACTION`, `UNKNOWN_ACCESS_KEY`, `UNKNOWN_ACCOUNT`, `NO_CONTRACT_CODE`, `CONTRACT_EXECUTION_ERROR`, `METHOD_NOT_FOUND`, `TIMEOUT_ERROR`.",
      ),
    info: z.record(z.string(), z.unknown()).optional().describe("Details."),
  }).describe("Cause."),
  code: z.int().describe("JSON-RPC code (-32000 handler errors, -32601 unknown method, -32700 parse error)."),
  message: z.string().describe("Message."),
  data: z.unknown().optional().describe("Legacy detail."),
}).meta({ id: "NearRpcError", description: "NEAR JSON-RPC structured error." });

export const NearRpcResponse = z
  .union([
    out({
      jsonrpc: z.literal("2.0").describe("JSON-RPC version."),
      id: JsonRpcId,
      result: z
        .union([NearFinalExecutionOutcome, NearCallFunctionResult, NearAccessKeyResult, NearBlockResult])
        .describe("Method result."),
    }),
    out({ jsonrpc: z.literal("2.0").describe("JSON-RPC version."), id: JsonRpcId, error: NearRpcError }),
  ])
  .meta({ id: "NearRpcResponse", description: "JSON-RPC response of the subset (always HTTP 200, like NEAR RPC)." });

/** Builds the `Failure` status of a vault panic, as NEAR RPC renders it. */
export function nearPanicStatus(message: string, actionIndex = 0) {
  return {
    Failure: {
      ActionError: {
        index: actionIndex,
        kind: { FunctionCallError: { ExecutionError: `${SMART_CONTRACT_PANICKED_PREFIX}${message}` } },
      },
    },
  };
}

// =============================================================================================
// Keeper outcome rules (billing §7.1) as data
// =============================================================================================

/** What the keeper does when a `collect` transaction fails with a vault error. */
export const VAULT_KEEPER_ON_TX_FAILURE = {
  ERR_INSUFFICIENT_BALANCE: "fallback_send_invoice",
  ERR_NOT_DUE: "retry_at_next_collect_at",
  ERR_IN_FLIGHT: "await_forwarded_outcome",
  ERR_GAS: "alert_and_fix_gas",
  ERR_NOT_ACTIVE: "reconcile_no_retry",
  ERR_MAX_PERIODS: "reconcile_no_retry",
  ERR_NOT_FOUND: "reconcile_no_retry",
} as const satisfies Partial<Record<VaultErrorCode, string>>;

/** Keeper tuning fixed by billing §7.1. */
export const VAULT_KEEPER_RULES = {
  /** Consecutive `collect_failed` outcomes before the invoice falls back to `send_invoice`. */
  max_collect_failures: 5,
  /** …or this long since the first failure of the streak (seconds). */
  collect_failure_window_secs: 86_400,
  /** Re-check after `ERR_IN_FLIGHT` (seconds). */
  in_flight_recheck_secs: 30,
  /** Other errors: retries before a case is opened. */
  other_error_retries: 5,
  /** Minimum spacing of collect attempts per mandate (seconds). */
  min_attempt_spacing_secs: 60,
} as const;

/** The keeper's outcome kind once a `collect` transaction is final (billing §7.1). */
export const VaultCollectOutcome = openEnum(
  ["collected", "collected_short", "collected_no_fee", "collect_failed", "tx_failure"],
  "Keeper outcome of one collect: full collection, short merchant share, fee leg failed, merchant leg failed, or the transaction failed with a vault error.",
);

// =============================================================================================
// Sandbox vault stand-in (OQ-T-03, sandbox §3.1, §4.2)
// =============================================================================================

/** Defaults of the stand-in's configuration (sandbox §6). */
export const SANDBOX_VAULT_DEFAULTS = {
  vault_contract: "vault.sandbox.near",
  fee_receiver: "treasury.sandbox.near",
  intents_account: "intents.near",
  max_fee_bps: 500,
} as const;

/** Outcome scenarios of the stand-in, by the last two digits of `amount_per_period`. */
export const VAULT_SANDBOX_SCENARIOS = {
  "91": "merchant_leg_fails",
  "92": "fee_leg_fails",
  "93": "first_refund_fails",
  "94": "partial_delivery",
} as const;
export type VaultSandboxScenario = (typeof VAULT_SANDBOX_SCENARIOS)[keyof typeof VAULT_SANDBOX_SCENARIOS] | "success";

/** Scenario of a mandate in the stand-in (`success` for `00` and every unlisted suffix). */
export function vaultSandboxScenarioOf(amountPerPeriod: string): VaultSandboxScenario {
  const suffix = amountPerPeriod.padStart(2, "0").slice(-2) as keyof typeof VAULT_SANDBOX_SCENARIOS;
  return VAULT_SANDBOX_SCENARIOS[suffix] ?? "success";
}

/** Merchant share the stand-in delivers in scenario `94` (0 → nothing delivered, i.e. `collect_failed`). */
export function vaultSandboxPartialShare(merchantShare: bigint): bigint {
  return merchantShare / 2n;
}
