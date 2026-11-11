/**
 * stage 2 — payments: internal payments routes (lld/payments.md §6.3, §9, §17).
 *
 * - Refund receipt data for notify (`refund.receipt`, notify §4) and a full refund read.
 * - Daily reconciliation runs (domain-model §6, RB-05): payments compares its statement with rails
 *   evidence per account, mode, UTC day and asset. The console reads and drives runs through the
 *   `/ops/reconciliation_runs…` routes (`./ops.ts`); a run with diffs opens a `reconciliation_diff`
 *   compliance case (`createInternalCase`).
 */
import {
  AssetId,
  BaseUnits,
  CheckoutSession,
  Customer,
  id,
  inp,
  Metadata,
  openEnum,
  out,
  PricingAmount,
  PricingCurrency,
  Refund,
  refinePricing,
  route,
  SettlementValue,
  Timestamp,
  Url,
  z,
} from "@nearpay-money/spec";

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
  summary: "Full refund (services; the console reads `GET /ops/refunds/{id}`).",
  auth: ["service:payments.read"],
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
  // spec 0.2.1 — console CR
  decimals: z
    .int()
    .min(0)
    .max(255)
    .optional()
    .describe("Decimals of `asset_id` for display (from rails `getInternalAsset`; spec 0.2.1)."),
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
  // spec 0.2.1 — console CR
  account_display_name: z
    .string()
    .nullable()
    .optional()
    .describe("Account display name at read time (console lists); null when unknown (spec 0.2.1)."),
}).meta({
  id: "ReconciliationRun",
  description: "Daily reconciliation of one account, mode and UTC day: Σ statement = Σ verified evidence per asset.",
});
export type ReconciliationRun = z.infer<typeof ReconciliationRun>;

// The console reads and drives runs through the `/ops/reconciliation_runs…` routes in `./ops.ts`
// (visibility `ops`, served by payments).

// =============================================================================================
// stage 3 — billing: internal invoice sessions and customer reads (lld/payments.md §6.3, §20;
// lld/billing.md §11). Payments creates and owns the checkout session that pays an invoice; billing
// learns the outcome from `evt.payments.payment_intent.succeeded|payment_failed` and
// `evt.payments.checkout_session.expired` (objects carry `invoice`).
// =============================================================================================

export const InvoiceCheckoutSessionCreate = inp({
  account_id: id("acct"),
  livemode: z.boolean().describe("Mode of the invoice."),
  invoice: id("in").describe("Invoice the session pays; the intent gets `source: invoice` and this `invoice`."),
  amount: PricingAmount.describe("The invoice's `amount_remaining`."),
  currency: PricingCurrency,
  asset_id: AssetId.optional().describe("Pricing asset; required when `currency` is `asset`."),
  customer: id("cus").describe("The invoice's customer (receipt address and the intent's `customer`)."),
  description: z.string().min(1).max(500).describe("Shown to the payer, e.g. `Invoice ACME01T-00042`."),
  settlement_destination: id("sd").optional().describe("The invoice's destination; default: asset or account default."),
  success_url: Url.describe("Where the payer goes after paying (the hosted invoice page, without its secret)."),
  expires_at: Timestamp.describe(
    "When the session stops accepting new payments: at least 5 minutes and at most 30 days ahead (billing uses the earlier of now + 30 d and the invoice's last reminder).",
  ),
  locale: z.string().max(16).optional().describe("Checkout locale (BCP 47)."),
  metadata: Metadata.optional().describe(
    "Copied onto the intent (billing sends the invoice metadata plus `invoice_number`).",
  ),
})
  .superRefine(refinePricing)
  .meta({ id: "InvoiceCheckoutSessionCreate", description: "Parameters of an invoice checkout session." });

export const createInvoiceCheckoutSession = route({
  id: "createInvoiceCheckoutSession",
  method: "POST",
  path: "/internal/checkout_sessions",
  service: "payments",
  visibility: "internal",
  summary: "Open the hosted checkout session that pays an invoice (billing).",
  description:
    "Creates an intent (`source: invoice`, `invoice`, `customer`) and a hosted session with the usual guards (account live in live mode, destination active, minimum, unverified cap, currency) and returns it **with** `client_secret` and `url` (once; billing stores the secret encrypted to let the hosted invoice page continue the session). At most one `open` session per invoice: another one answers `409 state_conflict`. `Idempotency-Key` (billing: `in:<invoice>:s<n>`) makes retries safe. Late payments follow the account setting (INV-3); sessions created this way emit the normal checkout and intent events.",
  auth: ["service:payments.sessions.create"],
  idempotent: true,
  body: InvoiceCheckoutSessionCreate,
  response: CheckoutSession,
  status: 201,
  errors: [
    "state_conflict",
    "account_not_live",
    "destination_not_active",
    "amount_below_destination_minimum",
    "amount_above_unverified_cap",
    "currency_unsupported",
    "customer_deleted",
    // spec 0.3.1 — fiat-priced invoice without a usable FX rate
    "fx_rate_unavailable",
  ],
  stage: 3,
});

export const getInternalCheckoutSession = route({
  id: "getInternalCheckoutSession",
  method: "GET",
  path: "/internal/checkout_sessions/{id}",
  service: "payments",
  visibility: "internal",
  summary: "A checkout session in any status (never its secret or URL).",
  description:
    "Billing checks that an invoice's stored session is still `open` before returning it to the hosted page.",
  auth: ["service:payments.read"],
  idempotent: false,
  params: inp({ id: id("cs") }),
  response: CheckoutSession,
  status: 200,
  errors: [],
  stage: 3,
});

export const expireInvoiceCheckoutSession = route({
  id: "expireInvoiceCheckoutSession",
  method: "POST",
  path: "/internal/checkout_sessions/{id}/expire",
  service: "payments",
  visibility: "internal",
  summary: "Expire an invoice's checkout session (billing voids the invoice).",
  description:
    "Only sessions with `invoice` set. Like the public expire: an attempt in flight answers `attempt_in_flight` and nothing changes; an already `expired` session is returned as is. Emits `evt.payments.checkout_session.expired`.",
  auth: ["service:payments.sessions.create"],
  idempotent: true,
  params: inp({ id: id("cs") }),
  body: inp({
    reason: openEnum(["invoice_voided", "invoice_paid", "superseded"], "Why billing expires the session."),
  }),
  response: CheckoutSession,
  status: 200,
  errors: ["state_conflict", "attempt_in_flight"],
  stage: 3,
});

export const InternalCustomer = Customer.extend({
  account_id: id("acct"),
  deleted: z.boolean().describe("The customer was deleted (personal data erased: `email` and `name` are null)."),
}).meta({
  id: "InternalCustomer",
  description: "A customer with its account, incl. decrypted email (PII; never in events).",
});

export const getInternalCustomer = route({
  id: "getInternalCustomer",
  method: "GET",
  path: "/internal/customers/{id}",
  service: "payments",
  visibility: "internal",
  summary: "A customer incl. decrypted email (billing: invoicing, hosted page, notification context).",
  description:
    "Deleted customers are returned with `deleted: true` (billing refuses new invoices for them with `customer_deleted`).",
  auth: ["service:payments.read"],
  idempotent: false,
  params: inp({ id: id("cus") }),
  response: InternalCustomer,
  status: 200,
  errors: [],
  stage: 3,
});
