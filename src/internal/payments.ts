/**
 * stage 2 — payments: internal payments routes (lld/payments.md §6.3, §9, §17).
 *
 * - Refund receipt data for notify (`refund.receipt`, notify §4) and a full refund read.
 * - Daily reconciliation runs (domain-model §6, RB-05): payments compares its statement with rails
 *   evidence per account, mode, UTC day and asset. The ops console reads and drives runs through
 *   these `ops:` routes (console pages "Reconciliation runs"); a run with diffs is the ops case.
 */
import {
  AssetId,
  BaseUnits,
  id,
  inp,
  listOf,
  openEnum,
  out,
  PricingAmount,
  PricingCurrency,
  Refund,
  route,
  SettlementValue,
  Timestamp,
  z,
} from "@nearpay/spec";

// =============================================================================================
// Refunds
// =============================================================================================

const RefundParams = inp({ id: id("re") });

export const getInternalRefund = route({
  id: "getInternalRefund",
  method: "GET",
  path: "/internal/refunds/{id}",
  service: "payments",
  visibility: "internal",
  summary: "Full refund (console, services).",
  auth: ["service:payments.read", "ops:payments.read"],
  idempotent: false,
  params: RefundParams,
  response: Refund,
  status: 200,
  errors: [],
  stage: 2,
});

export const RefundReceiptContext = out({
  customer_email: z.email().nullable().describe("Receipt recipient (the intent's customer or session email), if any."),
  merchant_display_name: z.string().describe("Merchant name."),
  livemode: z.boolean().describe("Mode (test-mode mails say so)."),
  refund: id("re"),
  payment_intent: id("pi"),
  original_amount: PricingAmount.describe("Priced amount of the refunded payment."),
  original_currency: PricingCurrency,
  refunded: SettlementValue.describe("What the merchant sent (settlement asset)."),
  received: SettlementValue.nullable().describe("What reached the payer (recipient asset), from evidence."),
  recipient_display: z.string().describe("Shortened refund address and chain, e.g. `0xab…cd on Base`."),
  evidence_links: z.array(z.url()).describe("Explorer links of the payer-side settlement."),
  email_receipts: z.boolean().describe("Account setting: send receipts."),
}).meta({ id: "RefundReceiptContext", description: "Refund receipt data (PII; never in events)." });

export const getRefundReceiptContext = route({
  id: "getRefundReceiptContext",
  method: "GET",
  path: "/internal/refunds/{id}/receipt-context",
  service: "payments",
  visibility: "internal",
  summary: "Data for the refund receipt email (PII; never in events).",
  description:
    "notify calls it for `evt.payments.refund.succeeded` (template `refund.receipt`); no email (`customer_email: null`) or `email_receipts: false` → no mail.",
  auth: ["service:payments.receipts.read"],
  idempotent: false,
  params: RefundParams,
  response: RefundReceiptContext,
  status: 200,
  errors: [],
  stage: 2,
});

// =============================================================================================
// Reconciliation
// =============================================================================================

const Day = z.iso.date().describe("UTC day `YYYY-MM-DD`.");
const ModeQuery = z
  .enum(["true", "false"])
  .transform((v) => v === "true")
  .describe("Mode.");

export const ReconciliationStatus = openEnum(
  ["running", "ok", "diff", "error"],
  "`ok` = zero diffs; `diff` = at least one diff (RB-05); `error` = the run could not complete (e.g. rails unreachable).",
);

export const ReconciliationFlow = out({
  statement: BaseUnits.describe("Σ statement lines, base units."),
  evidence: BaseUnits.describe("Σ verified evidence (rails), base units."),
  statement_lines: z.int().min(0).describe("Statement lines counted."),
  executions: z.int().min(0).describe("Settled executions counted."),
}).meta({ id: "ReconciliationFlow", description: "Statement vs evidence for one direction." });

export const ReconciliationTotals = out({
  asset_id: AssetId.describe("Settlement asset."),
  inflow: ReconciliationFlow.describe("`payment` + `overpayment` lines vs settled payment executions."),
  outflow: ReconciliationFlow.describe("`refund` lines vs settled refund executions (amount sent by the merchant)."),
  fees: out({
    expected: BaseUnits.describe("Σ estimated fees of the statement lines."),
    observed: BaseUnits.nullable().describe("Σ fees observed by rails (Explorer `appFees`); null when unavailable."),
  }).describe("Fee reconciliation."),
}).meta({ id: "ReconciliationTotals", description: "Per-asset totals of a run." });

export const ReconciliationDiff = out({
  kind: openEnum(
    [
      "missing_statement_line",
      "missing_evidence",
      "amount_mismatch",
      "asset_mismatch",
      "fee_mismatch",
      "duplicate_line",
    ],
    "What differs.",
  ),
  asset_id: AssetId.describe("Settlement asset."),
  execution_id: id("ex").nullable().describe("Rails execution concerned."),
  balance_transaction: id("txn").nullable().describe("Statement line concerned."),
  payment_intent: id("pi").nullable().describe("Payment intent concerned."),
  refund: id("re").nullable().describe("Refund concerned."),
  statement_amount: BaseUnits.nullable().describe("Amount on the statement side."),
  evidence_amount: BaseUnits.nullable().describe("Amount on the evidence side."),
  detail: z.string().describe("Explanation for operators."),
}).meta({ id: "ReconciliationDiff", description: "One difference between the statement and the evidence." });

export const ReconciliationResolution = out({
  classification: openEnum(
    ["missed_event", "fee_drift", "provider_data", "real_loss", "other"],
    "RB-05 classification.",
  ),
  note: z.string().describe("What was found and done (e.g. backfill, `fee_adjustment` line)."),
  actor: z.string().describe("Ops principal that resolved it."),
  resolved_at: Timestamp.describe("When."),
}).meta({ id: "ReconciliationResolution", description: "How an operator closed a run with diffs." });

export const ReconciliationRun = out({
  id: id("rcn"),
  object: z.literal("reconciliation_run").describe("Always `reconciliation_run`."),
  account_id: id("acct"),
  livemode: z.boolean().describe("Mode."),
  day: Day,
  status: ReconciliationStatus,
  trigger: openEnum(["schedule", "ops"], "Daily job (02:00 UTC) or an operator re-run."),
  rerun_of: id("rcn").nullable().describe("Earlier run of the same day this one repeats."),
  started_at: Timestamp.describe("Started."),
  completed_at: Timestamp.nullable().describe("Finished (null while running)."),
  totals: z.array(ReconciliationTotals).describe("Per-asset totals."),
  diffs: z.array(ReconciliationDiff).describe("Differences (empty when `ok`)."),
  diff_count: z.int().min(0).describe("Number of diffs."),
  error: z.string().nullable().describe("Why the run errored."),
  resolution: ReconciliationResolution.nullable().describe("Operator resolution of a `diff`/`error` run."),
}).meta({
  id: "ReconciliationRun",
  description: "Daily reconciliation of one account, mode and UTC day: Σ statement = Σ verified evidence per asset.",
});
export type ReconciliationRun = z.infer<typeof ReconciliationRun>;

const RunParams = inp({ id: id("rcn") });

export const listReconciliationRuns = route({
  id: "listReconciliationRuns",
  method: "GET",
  path: "/internal/reconciliation_runs",
  service: "payments",
  visibility: "internal",
  summary: "List reconciliation runs, newest first (ops console).",
  auth: ["ops:payments.read"],
  idempotent: false,
  query: inp({
    account_id: id("acct").optional().describe("Only runs of this account."),
    livemode: ModeQuery.optional(),
    status: ReconciliationStatus.optional().describe("Only runs in this status."),
    day: Day.optional().describe("Only runs of this day."),
    "day[gte]": Day.optional().describe("Only runs of this day or later."),
    "day[lte]": Day.optional().describe("Only runs of this day or earlier."),
    unresolved: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional()
      .describe("`true`: only `diff`/`error` runs without a resolution."),
    limit: z.coerce.number().int().min(1).max(100).default(20).describe("Page size."),
    starting_after: id("rcn").optional().describe("Cursor."),
  }),
  response: listOf(ReconciliationRun, "ReconciliationRunList", "A page of reconciliation runs."),
  status: 200,
  errors: [],
  stage: 2,
});

export const getReconciliationRun = route({
  id: "getReconciliationRun",
  method: "GET",
  path: "/internal/reconciliation_runs/{id}",
  service: "payments",
  visibility: "internal",
  summary: "A reconciliation run with its diffs.",
  auth: ["ops:payments.read"],
  idempotent: false,
  params: RunParams,
  response: ReconciliationRun,
  status: 200,
  errors: [],
  stage: 2,
});

export const createReconciliationRun = route({
  id: "createReconciliationRun",
  method: "POST",
  path: "/internal/reconciliation_runs",
  service: "payments",
  visibility: "internal",
  summary: "Run (or re-run) the reconciliation of a completed UTC day.",
  description:
    "Asynchronous: returns the new run in `running`. A re-run never edits an earlier run (INV-9); it records `rerun_of`. One run per account, mode and day may be running at a time.",
  auth: ["ops:payments.reconcile"],
  idempotent: true,
  body: inp({ account_id: id("acct"), livemode: z.boolean().describe("Mode."), day: Day }),
  response: ReconciliationRun,
  status: 202,
  errors: ["reconciliation_day_open", "state_conflict"],
  stage: 2,
});

export const resolveReconciliationRun = route({
  id: "resolveReconciliationRun",
  method: "POST",
  path: "/internal/reconciliation_runs/{id}/resolution",
  service: "payments",
  visibility: "internal",
  summary: "Record how a `diff`/`error` run was explained (RB-05).",
  auth: ["ops:payments.reconcile"],
  idempotent: true,
  params: RunParams,
  body: inp({
    classification: ReconciliationResolution.shape.classification,
    note: z.string().min(1).max(2000).describe("What was found and done."),
  }),
  response: ReconciliationRun,
  status: 200,
  errors: ["state_conflict"],
  stage: 2,
});
