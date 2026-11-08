/**
 * stage 3 — billing: invoices (lld/billing.md §4–§7, §11; ADR-0008; checkout-and-js `/i/:id`).
 *
 * Lifecycle `draft → open → paid | void | uncollectible` (`uncollectible → paid` on a late payment,
 * INV-3). v1 collects every invoice with `collection_method: send_invoice` (ADR-0008): finalize
 * assigns the number, the due date and the hosted invoice URL; the customer pays on the hosted page
 * `<pay origin>/i/<in_…>#<invoice secret>` through a payments checkout session (`source: invoice`)
 * that billing creates on demand. Billing never marks an invoice paid without a succeeded payment
 * intent (INV-2): there is no "paid out of band".
 *
 * Amounts are integers in the invoice currency (fiat minor units; asset base units as strings), tax
 * per line rounded half-up (`computeInvoiceTotals` in `./billing-catalog.ts`). Invoice objects carry
 * no customer personal data (the customer is a `cus_` id owned by payments).
 */
import { HEADERS } from "../common/auth.js";
import { id } from "../common/ids.js";
import { createdFilterShape, listOf, listQueryShape } from "../common/pagination.js";
import { AssetId, ChainId, Livemode, Metadata, Timestamp, UnixTime, Url } from "../common/primitives.js";
import { route } from "../common/route.js";
import { inp, openEnum, out, z } from "../common/schema.js";
import { refineAmountForCurrency, TaxPercentage } from "./billing-catalog.js";
import { SettlementDestinationType } from "./identity.js";
import { PricingAssetDisplay } from "./payer.js";
import { PricingAmount, PricingCurrency } from "./payments.js";

// =============================================================================================
// Objects
// =============================================================================================

export const InvoiceStatus = openEnum(
  ["draft", "open", "paid", "void", "uncollectible"],
  "Invoice status (domain-model §4.5): `uncollectible` invoices can still be paid (INV-3).",
);

/** v1: `send_invoice` only (ADR-0008); `auto_debit` arrives with Stage 4 mandates. */
export const CollectionMethod = openEnum(
  ["send_invoice"],
  "How the invoice is collected: `send_invoice` = the customer pays the hosted invoice (v1).",
);

export const BillingReason = openEnum(
  ["manual", "subscription_create", "subscription_cycle"],
  "Why the invoice exists: created by the merchant, the first invoice of a subscription, or a renewal.",
);

/** Default reminder schedule, days relative to the due date (lld/billing.md §3 `dunning`). */
export const DEFAULT_REMINDER_DAYS = [-3, 0, 1, 3, 7] as const;

/** Reminder offsets in days relative to the due date: ≤ 10, strictly increasing, −30…+60. */
export const ReminderDays = z
  .array(z.int().min(-30).max(60).describe("Days relative to the due date (negative = before)."))
  .max(10)
  .refine((a) => a.every((d, i) => i === 0 || d > (a[i - 1] as number)), { message: "must be strictly increasing" })
  .describe(
    "When reminders go out, in days relative to the due date (negative = before), strictly increasing, at most 10; `[]` sends none.",
  );

export const InvoiceLineTaxAmount = out({
  tax_rate: id("txr"),
  display_name: z.string().describe("Tax-rate name at finalize (snapshot)."),
  percentage: TaxPercentage,
  inclusive: z.boolean().describe("The line amount contains this tax."),
  amount: PricingAmount.describe("Tax of this line for this rate, rounded half-up per line."),
  taxable_amount: PricingAmount.describe(
    "Amount the rate applies to: the line amount (exclusive) or the line amount less its inclusive taxes.",
  ),
}).meta({ id: "InvoiceTaxAmount", description: "One tax rate applied to an amount (snapshot; immutable once open)." });

export const InvoiceLineItem = out({
  id: id("il"),
  object: z.literal("line_item").describe("Always `line_item`."),
  type: openEnum(["invoiceitem", "subscription"], "A one-off line or a subscription item's line."),
  price: id("price").nullable().describe("Price the line was created from; null for a custom amount."),
  product: id("prod").nullable().describe("Product of `price`."),
  subscription_item: id("si").nullable().describe("Subscription item of a `subscription` line."),
  description: z.string().describe("Text on the invoice (product name or the given description)."),
  quantity: z.int().min(1).describe("Quantity."),
  unit_amount: PricingAmount.describe("Price per unit in the invoice currency."),
  amount: PricingAmount.describe("`unit_amount × quantity` (inclusive taxes stay inside)."),
  amount_excluding_tax: PricingAmount.describe("`amount` less this line's inclusive taxes."),
  tax_rates: z.array(id("txr")).describe("Tax rates applied to the line (all inclusive or all exclusive)."),
  tax_amounts: z.array(InvoiceLineTaxAmount).describe("Tax per rate for this line."),
  period: out({
    start: UnixTime.describe("Period start."),
    end: UnixTime.describe("Period end (exclusive)."),
  })
    .nullable()
    .describe("Service period of a `subscription` line; null for one-off lines."),
}).meta({ id: "InvoiceLineItem", description: "One line of an invoice." });

export const Invoice = out({
  id: id("in"),
  object: z.literal("invoice").describe("Always `invoice`."),
  created: UnixTime,
  livemode: Livemode,
  status: InvoiceStatus,
  number: z
    .string()
    .max(32)
    .nullable()
    .describe(
      "Invoice number `<prefix>-<5+ digits>`, unique per account and mode, assigned at finalize; null for drafts.",
    ),
  customer: id("cus", "Customer billed (owned by payments)."),
  subscription: id("sub").nullable().describe("Subscription that produced the invoice."),
  billing_reason: BillingReason,
  collection_method: CollectionMethod,
  currency: PricingCurrency,
  asset_id: AssetId.nullable().describe("Pricing asset when `currency` is `asset`."),
  description: z.string().nullable().describe("Memo shown on the invoice."),
  footer: z.string().nullable().describe("Footer shown on the invoice."),
  lines: z.array(InvoiceLineItem).describe("All lines (at most 100)."),
  default_tax_rates: z.array(id("txr")).describe("Tax rates applied to lines created without `tax_rates`."),
  subtotal: PricingAmount.describe("Σ line amounts as priced."),
  tax: PricingAmount.describe("Σ every tax amount (inclusive and exclusive)."),
  total: PricingAmount.describe("`subtotal` + exclusive taxes: what the customer pays."),
  total_excluding_tax: PricingAmount.describe("`total − tax`."),
  total_tax_amounts: z
    .array(InvoiceLineTaxAmount)
    .describe("Tax per rate across all lines (Σ of the per-line, already rounded amounts)."),
  amount_due: PricingAmount.describe("Amount the customer owes in total (= `total`; no credits in v1)."),
  amount_paid: PricingAmount.describe("Amount paid (`total` once paid, else 0)."),
  amount_remaining: PricingAmount.describe("`amount_due − amount_paid`."),
  days_until_due: z
    .int()
    .min(0)
    .max(365)
    .nullable()
    .describe("Days after finalize until due (when no fixed `due_date` was given)."),
  due_date: UnixTime.nullable().describe("When payment is due; set at finalize at the latest."),
  period_start: UnixTime.nullable().describe("Start of the billed subscription period."),
  period_end: UnixTime.nullable().describe("End of the billed subscription period (exclusive)."),
  settlement_destination: id("sd")
    .nullable()
    .describe("Destination the payment settles to; null = the account default when the payment session opens."),
  reminder_days: ReminderDays,
  reminders_sent: z.int().min(0).describe("Reminders sent so far."),
  next_reminder_at: UnixTime.nullable().describe("When the next reminder goes out; null when none is due."),
  hosted_invoice_url: Url.nullable().describe(
    "Customer page `<pay origin>/i/<id>#<invoice secret>` (the secret is in the fragment); set once finalized. Always null in events and webhooks (secrets never travel on the bus).",
  ),
  invoice_pdf: Url.nullable().describe(
    "API URL of the PDF (`GET /v1/invoices/{id}/pdf`, needs your credentials); null for drafts.",
  ),
  checkout_session: id("cs")
    .nullable()
    .describe("Open payments checkout session paying the invoice (created on demand by the hosted page)."),
  payment_intent: id("pi").nullable().describe("Payment intent that paid the invoice."),
  payment_intents: z
    .array(id("pi"))
    .describe(
      "Every payment intent opened for the invoice, newest first. A settlement that arrives after the invoice is already paid or void (INV-3) stays listed here; refund it like an overpayment.",
    ),
  status_transitions: out({
    finalized_at: UnixTime.nullable().describe("Finalized (draft → open)."),
    sent_at: UnixTime.nullable().describe("Last emailed to the customer."),
    paid_at: UnixTime.nullable().describe("Paid."),
    voided_at: UnixTime.nullable().describe("Voided."),
    marked_uncollectible_at: UnixTime.nullable().describe("Marked uncollectible."),
  }).describe("When status changes happened."),
  uncollectible_reason: openEnum(["merchant", "dunning_exhausted"], "Why the invoice became uncollectible.")
    .nullable()
    .describe("Set when `status` is or was `uncollectible`."),
  metadata: Metadata,
  sequence: z.int().min(0).describe("Increases with every change; discard webhook objects with a lower sequence."),
}).meta({ id: "Invoice", description: "A bill for a customer, paid on a hosted invoice page (FR-BIL-01)." });
export type Invoice = z.infer<typeof Invoice>;

export const DeletedInvoice = out({
  id: id("in"),
  object: z.literal("invoice").describe("Always `invoice`."),
  livemode: Livemode,
  deleted: z.literal(true).describe("Always `true`."),
}).meta({ id: "DeletedInvoice", description: "A deleted draft invoice." });

// =============================================================================================
// Merchant routes
// =============================================================================================

const InvoiceParams = inp({ id: id("in") });
const WRITE = ["secret_key", "restricted_key:invoices.write", "session"] as const;
const READ = ["secret_key", "restricted_key:invoices.read", "session"] as const;
/** Dashboard roles that may create, change, send and void invoices. */
export const INVOICE_ROLES = ["owner", "admin", "finance"] as const;

const TaxRateIds = z
  .array(id("txr"))
  .max(5)
  .describe("Tax rates (at most 5; all inclusive or all exclusive). `[]` = no tax.");

const PriceLine = inp({
  price: id("price").describe("A `one_time` price in the invoice currency."),
  quantity: z.int().min(1).max(1_000_000).optional().describe("Quantity (default 1)."),
  description: z.string().min(1).max(500).optional().describe("Overrides the product name on the invoice."),
  tax_rates: TaxRateIds.optional().describe("Tax rates of this line; default: the invoice's `default_tax_rates`."),
}).describe("A line from a price.");

const AmountLine = inp({
  unit_amount: PricingAmount.describe("Price per unit in the invoice currency."),
  description: z.string().min(1).max(500).describe("Text on the invoice."),
  quantity: z.int().min(1).max(1_000_000).optional().describe("Quantity (default 1)."),
  tax_rates: TaxRateIds.optional().describe("Tax rates of this line; default: the invoice's `default_tax_rates`."),
}).describe("A line with a custom amount.");

export const InvoiceLineInput = z
  .union([PriceLine, AmountLine])
  .describe("A line: `{price, quantity?}` or `{unit_amount, description, quantity?}`.");

const dueShape = {
  days_until_due: z
    .int()
    .min(0)
    .max(365)
    .optional()
    .describe("Due this many days after finalize (default 30). Exclusive with `due_date`."),
  due_date: UnixTime.optional().describe(
    "Fixed due date (must be in the future at finalize). Exclusive with `days_until_due`.",
  ),
};

function refineInvoice(
  v: {
    currency?: string | undefined;
    asset_id?: string | null | undefined;
    days_until_due?: number | undefined;
    due_date?: number | null | undefined;
    lines?: readonly (z.infer<typeof PriceLine> | z.infer<typeof AmountLine>)[] | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const pricing = { currency: v.currency, asset_id: v.asset_id ?? undefined };
  refineAmountForCurrency(pricing, undefined, "currency", ctx);
  if (v.days_until_due !== undefined && v.due_date !== undefined && v.due_date !== null)
    ctx.addIssue({ code: "custom", path: ["due_date"], message: "give days_until_due or due_date, not both" });
  for (const [i, l] of (v.lines ?? []).entries()) {
    if (!("unit_amount" in l) || v.currency === undefined) continue;
    const want = v.currency === "asset" ? "string" : "number";
    if (typeof l.unit_amount !== want)
      ctx.addIssue({
        code: "custom",
        path: ["lines", i, "unit_amount"],
        message:
          want === "string"
            ? "must be a base-unit string when currency is asset"
            : "must be an integer in minor units for fiat",
      });
  }
}

export const InvoiceCreate = inp({
  customer: id("cus").describe("Customer to bill (not deleted)."),
  collection_method: z
    .literal("send_invoice")
    .optional()
    .describe("`send_invoice` (the only method in v1, ADR-0008; default)."),
  currency: PricingCurrency.optional().describe(
    "Invoice currency; default: the currency of the first price line. Required when every line has a custom amount.",
  ),
  asset_id: AssetId.optional().describe("Pricing asset; required when `currency` is `asset`."),
  lines: z.array(InvoiceLineInput).max(100).optional().describe("Lines (at most 100); a draft may start empty."),
  default_tax_rates: TaxRateIds.optional().describe("Tax rates for lines without their own `tax_rates`."),
  description: z.string().max(1000).optional().describe("Memo shown on the invoice."),
  footer: z.string().max(1000).optional().describe("Footer shown on the invoice."),
  ...dueShape,
  reminder_days: ReminderDays.optional().describe(
    "Reminder schedule relative to the due date (default `[-3, 0, 1, 3, 7]`); `[]` sends none.",
  ),
  settlement_destination: id("sd").optional().describe("Destination to settle to; default: the account default."),
  metadata: Metadata.optional(),
})
  .superRefine(refineInvoice)
  .meta({ id: "InvoiceCreate", description: "Parameters to create a draft invoice." });

const INVOICE_INPUT_ERRORS = [
  "customer_deleted",
  "currency_mismatch",
  "currency_unsupported",
  "price_inactive",
  "price_type_invalid",
  "tax_rate_inactive",
  "tax_rates_mixed",
] as const;

export const createInvoice = route({
  id: "createInvoice",
  method: "POST",
  path: "/v1/invoices",
  service: "billing",
  visibility: "public",
  summary: "Create a draft invoice.",
  description:
    "Creates a `draft` (`invoice.created`). Price lines need active `one_time` prices in the invoice currency; tax rates must be active. Nothing is sent until the invoice is finalized and sent.",
  auth: WRITE,
  roles: INVOICE_ROLES,
  idempotent: true,
  body: InvoiceCreate,
  response: Invoice,
  status: 201,
  errors: [...INVOICE_INPUT_ERRORS],
  stage: 3,
});

export const getInvoice = route({
  id: "getInvoice",
  method: "GET",
  path: "/v1/invoices/{id}",
  service: "billing",
  visibility: "public",
  summary: "Retrieve an invoice.",
  auth: READ,
  idempotent: false,
  params: InvoiceParams,
  response: Invoice,
  status: 200,
  errors: [],
  stage: 3,
});

export const listInvoices = route({
  id: "listInvoices",
  method: "GET",
  path: "/v1/invoices",
  service: "billing",
  visibility: "public",
  summary: "List invoices.",
  auth: READ,
  idempotent: false,
  query: inp({
    ...listQueryShape,
    ...createdFilterShape,
    status: InvoiceStatus.optional().describe("Only invoices in this status."),
    customer: id("cus").optional().describe("Only invoices of this customer."),
    subscription: id("sub").optional().describe("Only invoices of this subscription."),
    collection_method: CollectionMethod.optional().describe("Only invoices collected this way."),
    "due_date[gte]": z.coerce.number().pipe(UnixTime).optional().describe("Only invoices due at or after this time."),
    "due_date[lte]": z.coerce.number().pipe(UnixTime).optional().describe("Only invoices due at or before this time."),
  }),
  response: listOf(Invoice, "InvoiceList", "A page of invoices."),
  status: 200,
  errors: [],
  stage: 3,
});

export const updateInvoice = route({
  id: "updateInvoice",
  method: "PATCH",
  path: "/v1/invoices/{id}",
  service: "billing",
  visibility: "public",
  summary: "Change a draft invoice (any field) or an issued invoice's metadata.",
  description:
    "Every field except `metadata` needs a `draft` (`409 state_conflict` otherwise). `lines` replaces all lines. Finalized invoices are immutable documents.",
  auth: WRITE,
  roles: INVOICE_ROLES,
  idempotent: true,
  params: InvoiceParams,
  body: inp({
    customer: id("cus").optional().describe("Customer to bill."),
    currency: PricingCurrency.optional().describe("Invoice currency (lines must match)."),
    asset_id: AssetId.nullable().optional().describe("Pricing asset when `currency` is `asset`."),
    lines: z.array(InvoiceLineInput).max(100).optional().describe("Replaces every line."),
    default_tax_rates: TaxRateIds.optional().describe("Default tax rates (re-applied to lines without their own)."),
    description: z.string().max(1000).nullable().optional().describe("Memo (`null` clears it)."),
    footer: z.string().max(1000).nullable().optional().describe("Footer (`null` clears it)."),
    days_until_due: dueShape.days_until_due,
    due_date: UnixTime.nullable().optional().describe("Fixed due date (`null` clears it)."),
    reminder_days: ReminderDays.optional(),
    settlement_destination: id("sd").nullable().optional().describe("Destination (`null` = account default)."),
    metadata: Metadata.optional(),
  })
    .superRefine(refineInvoice)
    .meta({ id: "InvoiceUpdate", description: "Invoice fields to change." }),
  response: Invoice,
  status: 200,
  errors: ["state_conflict", ...INVOICE_INPUT_ERRORS],
  stage: 3,
});

export const deleteInvoice = route({
  id: "deleteInvoice",
  method: "DELETE",
  path: "/v1/invoices/{id}",
  service: "billing",
  visibility: "public",
  summary: "Delete a draft invoice (issued invoices are voided instead).",
  auth: WRITE,
  roles: INVOICE_ROLES,
  idempotent: false,
  params: InvoiceParams,
  response: DeletedInvoice,
  status: 200,
  errors: ["state_conflict"],
  stage: 3,
});

export const finalizeInvoice = route({
  id: "finalizeInvoice",
  method: "POST",
  path: "/v1/invoices/{id}/finalize",
  service: "billing",
  visibility: "public",
  summary: "Finalize a draft: number, due date, hosted URL and PDF (`draft → open`).",
  description:
    "Guards (lld/billing.md §4): at least one line and `total > 0` (`invoice_empty`), the customer exists and is not deleted, the account can take payments in this mode and currency, and the total meets the destination minimum (checked against payments). Assigns `number`, `due_date` (now + `days_until_due` unless fixed), the invoice secret and `hosted_invoice_url`, renders the PDF, snapshots product names and tax rates, schedules reminders, and emits `invoice.finalized`. It does not email the customer — call `send` (subscription invoices are sent automatically). The payments checkout session is opened later, when the customer opens the hosted page.",
  auth: WRITE,
  roles: INVOICE_ROLES,
  idempotent: true,
  params: InvoiceParams,
  body: inp({}),
  response: Invoice,
  status: 200,
  errors: [
    "state_conflict",
    "invoice_empty",
    "customer_deleted",
    "account_not_live",
    "destination_not_active",
    "amount_below_destination_minimum",
    "currency_unsupported",
    "price_inactive",
    "tax_rate_inactive",
  ],
  stage: 3,
});

export const sendInvoice = route({
  id: "sendInvoice",
  method: "POST",
  path: "/v1/invoices/{id}/send",
  service: "billing",
  visibility: "public",
  summary: "Email the hosted invoice to the customer (repeatable).",
  description:
    "`open` or `uncollectible` invoices only. Emits `invoice.sent`; notify mails `invoice.issued` to the customer's email from payments (no email → `customer_email_missing`). Sets `status_transitions.sent_at`. Repeated sends are allowed (at most one mail per invoice per 10 minutes; a faster repeat answers `rate_limited`).",
  auth: WRITE,
  roles: INVOICE_ROLES,
  idempotent: true,
  params: InvoiceParams,
  body: inp({}),
  response: Invoice,
  status: 200,
  errors: ["state_conflict", "customer_email_missing", "customer_deleted"],
  stage: 3,
});

export const voidInvoice = route({
  id: "voidInvoice",
  method: "POST",
  path: "/v1/invoices/{id}/void",
  service: "billing",
  visibility: "public",
  summary: "Void an open invoice (`open → void`).",
  description:
    "Expires the invoice's open checkout session through payments first; while any session of the invoice could still settle (an attempt in flight, or a session still `expiring`) the void is refused with `attempt_in_flight` — retry later. Emits `invoice.voided`. A void invoice is final; a settlement that still arrives is listed in `payment_intents` and must be refunded by the merchant.",
  auth: WRITE,
  roles: INVOICE_ROLES,
  idempotent: true,
  params: InvoiceParams,
  body: inp({}),
  response: Invoice,
  status: 200,
  errors: ["state_conflict", "attempt_in_flight"],
  stage: 3,
});

export const markInvoiceUncollectible = route({
  id: "markInvoiceUncollectible",
  method: "POST",
  path: "/v1/invoices/{id}/mark_uncollectible",
  service: "billing",
  visibility: "public",
  summary: "Write off an open invoice (`open → uncollectible`); it can still be paid later.",
  description:
    "Stops reminders and emits `invoice.marked_uncollectible` (`uncollectible_reason: merchant`). The hosted page stays payable; a later payment moves the invoice to `paid` (INV-3).",
  auth: WRITE,
  roles: INVOICE_ROLES,
  idempotent: true,
  params: InvoiceParams,
  body: inp({}),
  response: Invoice,
  status: 200,
  errors: ["state_conflict"],
  stage: 3,
});

/** Response headers of the PDF downloads. */
const PdfHeaders = out({
  "content-disposition": z.string().describe('`attachment; filename="<number>.pdf"`.'),
  "cache-control": z.string().describe("`private, no-store`."),
});

export const getInvoicePdf = route({
  id: "getInvoicePdf",
  method: "GET",
  path: "/v1/invoices/{id}/pdf",
  service: "billing",
  visibility: "public",
  summary: "Download the invoice PDF.",
  description:
    "Rendered at finalize and re-rendered on every later status change (status stamp `PAID`, `VOID` or `UNCOLLECTIBLE`; the content is otherwise identical). Drafts have no PDF (`409 state_conflict`).",
  auth: READ,
  idempotent: false,
  params: InvoiceParams,
  response: null,
  binaryResponse: { contentType: "application/pdf", description: "The invoice as a PDF document." },
  responseHeaders: PdfHeaders,
  status: 200,
  errors: ["state_conflict"],
  stage: 3,
});

// =============================================================================================
// Hosted invoice payer routes (anonymous at the gateway; billing checks the invoice secret)
// =============================================================================================

/** Invoice secret: `in_<26>_secret_<32 base62>`, carried in the hosted URL fragment. */
export const InvoiceSecret = z
  .string()
  .regex(/^in_[0-7][0-9a-z]{25}_secret_[0-9A-Za-z]{32}$/)
  .describe("Invoice secret from the hosted URL fragment (`/i/<id>#<secret>`); long-lived, independent of sessions.");

export const InvoiceSecretHeaders = inp({
  "x-nearpay-invoice-secret": InvoiceSecret,
}).describe(`\`${HEADERS.invoiceSecret}\` header.`);

export const PublicInvoiceTaxAmount = out({
  display_name: z.string().describe("Tax name."),
  jurisdiction: z.string().nullable().describe("Jurisdiction label."),
  percentage: TaxPercentage,
  inclusive: z.boolean().describe("Included in the amounts."),
  amount: PricingAmount.describe("Tax amount."),
}).meta({ id: "PublicInvoiceTaxAmount", description: "A tax amount as the customer sees it." });

export const PublicInvoice = out({
  id: id("in"),
  object: z.literal("invoice").describe("Always `invoice`."),
  livemode: Livemode,
  status: InvoiceStatus,
  number: z.string().describe("Invoice number."),
  payable: z
    .boolean()
    .describe("The customer can pay now (`open` or `uncollectible`, and the account accepts payments)."),
  currency: PricingCurrency,
  asset_id: AssetId.nullable().describe("Pricing asset when `currency` is `asset`."),
  pricing_asset: PricingAssetDisplay.nullable().describe("Display data of the pricing asset; null for fiat."),
  display: out({
    merchant_name_unverified: z
      .string()
      .describe("Merchant display name (not authenticated; the attested name comes from sentinel per attempt)."),
    description: z.string().nullable().describe("Memo."),
    footer: z.string().nullable().describe("Footer."),
  }).describe("Texts of the invoice."),
  bill_to: out({
    name: z.string().nullable().describe("Customer name at finalize."),
    email: z.email().nullable().describe("Customer email at finalize."),
  }).describe("Who is billed (only the holder of the invoice secret sees it)."),
  lines: z
    .array(
      out({
        description: z.string().describe("Line text."),
        quantity: z.int().min(1).describe("Quantity."),
        unit_amount: PricingAmount.describe("Price per unit."),
        amount: PricingAmount.describe("Line amount."),
        period: out({ start: Timestamp.describe("Start."), end: Timestamp.describe("End (exclusive).") })
          .nullable()
          .describe("Service period of a subscription line."),
        tax_amounts: z.array(PublicInvoiceTaxAmount).describe("Taxes of the line."),
      }).describe("An invoice line."),
    )
    .describe("Lines."),
  subtotal: PricingAmount.describe("Σ line amounts."),
  tax: PricingAmount.describe("Σ taxes."),
  total: PricingAmount.describe("Total."),
  total_excluding_tax: PricingAmount.describe("Total without tax."),
  total_tax_amounts: z.array(PublicInvoiceTaxAmount).describe("Taxes per rate."),
  amount_due: PricingAmount.describe("Amount due."),
  amount_paid: PricingAmount.describe("Amount paid."),
  amount_remaining: PricingAmount.describe("Amount still to pay."),
  issued_at: Timestamp.describe("Finalized."),
  due_date: Timestamp.nullable().describe("Due date."),
  paid_at: Timestamp.nullable().describe("Paid."),
  voided_at: Timestamp.nullable().describe("Voided."),
  period_start: Timestamp.nullable().describe("Billed subscription period start."),
  period_end: Timestamp.nullable().describe("Billed subscription period end (exclusive)."),
  settlement: out({
    asset_id: AssetId.describe("Asset the merchant receives."),
    chain: ChainId.describe("Chain the merchant receives on."),
    type: SettlementDestinationType,
  })
    .nullable()
    .describe("How the merchant is paid (never the raw address); null when no destination is usable now."),
  checkout_session: id("cs")
    .nullable()
    .describe("Open checkout session of the invoice, if any (continue it with `createPublicInvoiceSession`)."),
}).meta({ id: "PublicInvoice", description: "A finalized invoice as the hosted invoice page shows it." });

export const getPublicInvoice = route({
  id: "getPublicInvoice",
  method: "GET",
  path: "/v1/invoices/{id}/public",
  service: "billing",
  visibility: "public",
  summary: "Load an invoice for the hosted invoice page (`/i/:id`).",
  description:
    "Anonymous at the gateway; billing checks `X-NearPay-Invoice-Secret` (constant-time against the stored hash). Read-only: it never creates a session. Drafts and unknown ids answer `404 resource_missing`; a wrong secret answers `invoice_secret_invalid`.",
  auth: ["anonymous"],
  idempotent: false,
  params: InvoiceParams,
  headers: InvoiceSecretHeaders,
  response: PublicInvoice,
  status: 200,
  errors: ["invoice_secret_invalid"],
  stage: 3,
});

export const InvoicePaymentSession = out({
  object: z.literal("invoice_payment_session").describe("Always `invoice_payment_session`."),
  checkout_session: id("cs"),
  client_secret: z
    .string()
    .regex(/^cs_[0-9a-z]{26}_secret_[0-9A-Za-z]{32}$/)
    .describe("Client secret of the session; the page continues with the payer API (`/c/:id` flow) in place."),
  expires_at: Timestamp.describe("When the session stops accepting new payments."),
  reused: z.boolean().describe("`true` when an already open session of the invoice was returned."),
}).meta({ id: "InvoicePaymentSession", description: "The checkout session that pays an invoice." });

export const createPublicInvoiceSession = route({
  id: "createPublicInvoiceSession",
  method: "POST",
  path: "/v1/invoices/{id}/public/sessions",
  service: "billing",
  visibility: "public",
  summary: "Create or continue the checkout session that pays an invoice.",
  description:
    "Anonymous; billing checks the invoice secret and rate-limits per client network and per invoice. Returns the invoice's open session (`reused: true`) or creates one through payments `createInvoiceCheckoutSession` (`source: invoice`, amount = `amount_remaining`, the invoice's customer and destination). At most one session per invoice is open at a time. `paid`/`void` invoices answer `invoice_not_payable`.",
  auth: ["anonymous"],
  idempotent: false,
  params: InvoiceParams,
  headers: InvoiceSecretHeaders,
  body: inp({
    locale: z.string().max(16).optional().describe("Checkout locale (BCP 47)."),
  }),
  response: InvoicePaymentSession,
  status: 201,
  errors: [
    "invoice_secret_invalid",
    "invoice_not_payable",
    "account_not_live",
    "destination_not_active",
    "currency_unsupported",
  ],
  stage: 3,
});

export const getPublicInvoicePdf = route({
  id: "getPublicInvoicePdf",
  method: "GET",
  path: "/v1/invoices/{id}/public/pdf",
  service: "billing",
  visibility: "public",
  summary: "Download the invoice PDF from the hosted invoice page.",
  description:
    "Same document as `getInvoicePdf`; the page fetches it with the invoice-secret header and saves the blob.",
  auth: ["anonymous"],
  idempotent: false,
  params: InvoiceParams,
  headers: InvoiceSecretHeaders,
  response: null,
  binaryResponse: { contentType: "application/pdf", description: "The invoice as a PDF document." },
  responseHeaders: PdfHeaders,
  status: 200,
  errors: ["invoice_secret_invalid"],
  stage: 3,
});
