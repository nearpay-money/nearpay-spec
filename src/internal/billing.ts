/**
 * stage 3 — billing: internal billing API (lld/billing.md §5, §6, §11; lld/notify.md §4).
 *
 * Billing emails are event-driven, like every other notify mail: billing publishes
 * `evt.billing.invoice.sent|reminder|paid|voided` and `evt.billing.subscription.renewal_upcoming`;
 * notify renders the template from the notification context below (personal data and the hosted
 * invoice link, which embeds the invoice secret, never travel on the bus).
 */
import {
  AssetId,
  BaseUnits,
  InvoiceStatus,
  id,
  inp,
  MandateLinkStatus,
  MandateStatus,
  MandateUnlinkedReason,
  NearAccountId,
  NearTransactionRequest,
  out,
  PricingAmount,
  PricingAssetDisplay,
  PricingCurrency,
  Recurring,
  route,
  Timestamp,
  Url,
  z,
} from "@nearpay/spec";

const MerchantFields = {
  account_id: id("acct"),
  livemode: z.boolean().describe("Mode (test-mode mails say so)."),
  merchant_display_name: z.string().describe("Merchant name (account display name, or the ops-approved legal name)."),
  customer: id("cus"),
  customer_email: z.email().nullable().describe("Recipient: the customer's email from payments; null = no mail."),
  customer_name: z.string().nullable().describe("Customer name, if known."),
};

export const InvoiceNotificationContext = out({
  ...MerchantFields,
  invoice: id("in"),
  number: z.string().describe("Invoice number."),
  status: InvoiceStatus,
  currency: PricingCurrency,
  asset_id: AssetId.nullable().describe("Pricing asset when `currency` is `asset`."),
  pricing_asset: PricingAssetDisplay.nullable().describe("Display data of the pricing asset; null for fiat."),
  total: PricingAmount.describe("Invoice total."),
  // spec 0.3.1 — mail body totals and the destination check line
  subtotal: PricingAmount.optional().describe("Sum of the lines before tax (spec 0.3.1)."),
  tax: PricingAmount.optional().describe("Tax total (spec 0.3.1)."),
  line_count: z
    .int()
    .min(0)
    .optional()
    .describe("Number of invoice lines (`lines` holds at most the first 20; spec 0.3.1)."),
  destination_fingerprint: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Fingerprint of the settlement destination the invoice pays to, for the mail's verification line; null when none (spec 0.3.1).",
    ),
  amount_due: PricingAmount.describe("Amount due."),
  amount_remaining: PricingAmount.describe("Amount still to pay."),
  due_date: Timestamp.nullable().describe("Due date."),
  period_start: Timestamp.nullable().describe("Billed subscription period start."),
  period_end: Timestamp.nullable().describe("Billed subscription period end (exclusive)."),
  subscription: id("sub").nullable().describe("Subscription of the invoice."),
  lines: z
    .array(
      out({
        description: z.string().describe("Line text."),
        quantity: z.int().min(1).describe("Quantity."),
        amount: PricingAmount.describe("Line amount."),
      }).describe("A line (the first 20)."),
    )
    .max(20)
    .describe("Lines for the mail body (at most 20)."),
  hosted_invoice_url: Url.nullable().describe(
    "Hosted invoice page including the invoice secret in the fragment (PII-grade: never logged, never in events); null when void.",
  ),
  payment_intent: id("pi")
    .nullable()
    .describe("Intent that paid the invoice (`invoice.paid`: notify reads its receipt context for evidence links)."),
  reminder: out({
    number: z.int().min(1).describe("1-based reminder number."),
    offset_days: z.int().describe("Days relative to the due date (negative = before)."),
    last: z.boolean().describe("The last reminder of the schedule."),
  })
    .nullable()
    .describe("Set when the context is read for an `evt.billing.invoice.reminder` (`?reminder=<n>`)."),
}).meta({
  id: "InvoiceNotificationContext",
  description: "Data for the billing invoice emails (PII; never in events).",
});

export const getInvoiceNotificationContext = route({
  id: "getInvoiceNotificationContext",
  method: "GET",
  path: "/internal/invoices/{id}/notification-context",
  service: "billing",
  visibility: "internal",
  summary: "Data for the invoice emails (PII and the hosted link; never in events).",
  description:
    "notify calls it for `evt.billing.invoice.sent` (`invoice.issued`), `.reminder` (`invoice.reminder`, with `?reminder=`), `.paid` (`invoice.paid`) and `.voided` (`invoice.voided`). `customer_email: null` → no mail. notify sends nothing when the context's `livemode` differs from the event's, or when the status no longer fits the mail (e.g. a reminder for an invoice that is paid by now).",
  auth: ["service:billing.read"],
  idempotent: false,
  params: inp({ id: id("in") }),
  query: inp({
    reminder: z.coerce.number().int().min(1).max(10).optional().describe("Reminder number of the event being mailed."),
  }),
  response: InvoiceNotificationContext,
  status: 200,
  errors: [],
  stage: 3,
});

export const SubscriptionNotificationContext = out({
  ...MerchantFields,
  subscription: id("sub"),
  status: z.string().describe("Subscription status."),
  renews_at: Timestamp.describe("When the next renewal invoice is created (`current_period_end`)."),
  recurring: Recurring.describe("Billing period."),
  currency: PricingCurrency,
  asset_id: AssetId.nullable().describe("Pricing asset when `currency` is `asset`."),
  pricing_asset: PricingAssetDisplay.nullable().describe("Display data of the pricing asset; null for fiat."),
  next_amount: PricingAmount.describe("Total of the next renewal invoice with current items and tax rates."),
  items: z
    .array(
      out({
        description: z.string().describe("Product name."),
        quantity: z.int().min(1).describe("Quantity."),
      }).describe("An item."),
    )
    .describe("Items of the next renewal."),
  cancel_at_period_end: z.boolean().describe("The subscription ends instead of renewing (no mail is sent then)."),
}).meta({
  id: "SubscriptionNotificationContext",
  description: "Data for the renewal-upcoming email (PII; never in events).",
});

export const getSubscriptionNotificationContext = route({
  id: "getSubscriptionNotificationContext",
  method: "GET",
  path: "/internal/subscriptions/{id}/notification-context",
  service: "billing",
  visibility: "internal",
  summary: "Data for the renewal-upcoming email (PII; never in events).",
  description: "notify calls it for `evt.billing.subscription.renewal_upcoming` (`subscription.renewal_upcoming`).",
  auth: ["service:billing.read"],
  idempotent: false,
  params: inp({ id: id("sub") }),
  response: SubscriptionNotificationContext,
  status: 200,
  errors: [],
  stage: 3,
});

// stage 4 — autodebit: mandate emails (lld/notify.md §4, lld/billing.md §14)
export const MandateNotificationContext = out({
  ...MerchantFields,
  mandate: id("md"),
  subscription: id("sub"),
  status: MandateStatus,
  link_status: MandateLinkStatus,
  unlinked_reason: MandateUnlinkedReason.nullable().describe("Why it is unlinked (the mail asks the payer to cancel)."),
  payer: NearAccountId.describe("Payer's NEAR account (the mail shows it shortened)."),
  vault_contract: NearAccountId.describe("Vault account."),
  onchain_id: z.int().min(0).describe("Vault mandate id (shown so the payer can cancel from any wallet)."),
  token_asset: PricingAssetDisplay.describe("Display data of the mandate's token (symbol, decimals)."),
  amount_per_period: BaseUnits.describe("Tokens per period."),
  recurring: Recurring.nullable().describe("Billing period of the subscription; null if it no longer exists."),
  balance: BaseUnits.describe("Remaining balance."),
  next_collect_at: Timestamp.nullable().describe("Next due time; null when none."),
  refunded: BaseUnits.nullable().describe("`mandate.canceled`: amount returned to the payer by the cancel."),
  cancel_transaction: NearTransactionRequest.nullable().describe(
    "The payer's `cancel` transaction (contract, method, args, 100 Tgas, 1 yoctoNEAR) while on-chain active; null otherwise.",
  ),
  withdraw_transaction: NearTransactionRequest.nullable().describe(
    "The payer's `withdraw` transaction when a balance remains after cancel/exhaustion; null otherwise.",
  ),
  invoice: id("in")
    .nullable()
    .describe("`mandate.insufficient_funds`: the invoice that fell back to `send_invoice` (it is emailed separately)."),
  manage_url: Url.nullable().describe(
    "Hosted invoice page of the subscription's latest invoice (with its secret) where the payer can top up, cancel or withdraw; null when none. PII-grade: never logged, never in events.",
  ),
}).meta({
  id: "MandateNotificationContext",
  description: "Data for the payer's mandate emails (PII; never in events).",
});

export const getMandateNotificationContext = route({
  id: "getMandateNotificationContext",
  method: "GET",
  path: "/internal/mandates/{id}/notification-context",
  service: "billing",
  visibility: "internal",
  summary: "Data for the mandate emails to the payer (PII and the hosted link; never in events).",
  description:
    "notify calls it for `evt.billing.mandate.activated` (`mandate.activated`), `.insufficient_funds` (`mandate.insufficient_funds`), `.canceled` (`mandate.canceled`), `.unlinked` (`mandate.unlinked`) and `.released` (`mandate.released`). `customer_email: null` → no mail; nothing is sent when the context's `livemode` differs from the event's.",
  auth: ["service:billing.read"],
  idempotent: false,
  params: inp({ id: id("md") }),
  response: MandateNotificationContext,
  status: 200,
  errors: [],
  stage: 4,
});
// end stage 4 — autodebit

/**
 * Billing email templates notify renders (lld/notify.md §4): template → trigger subject and the
 * context route it reads. Customers are the recipients of all of them.
 */
export const BILLING_EMAIL_TEMPLATES = {
  "invoice.issued": { subject: "evt.billing.invoice.sent", context: "getInvoiceNotificationContext" },
  "invoice.reminder": { subject: "evt.billing.invoice.reminder", context: "getInvoiceNotificationContext" },
  "invoice.paid": { subject: "evt.billing.invoice.paid", context: "getInvoiceNotificationContext" },
  "invoice.voided": { subject: "evt.billing.invoice.voided", context: "getInvoiceNotificationContext" },
  "subscription.renewal_upcoming": {
    subject: "evt.billing.subscription.renewal_upcoming",
    context: "getSubscriptionNotificationContext",
  },
  // stage 4 — autodebit
  "mandate.activated": { subject: "evt.billing.mandate.activated", context: "getMandateNotificationContext" },
  "mandate.insufficient_funds": {
    subject: "evt.billing.mandate.insufficient_funds",
    context: "getMandateNotificationContext",
  },
  "mandate.canceled": { subject: "evt.billing.mandate.canceled", context: "getMandateNotificationContext" },
  "mandate.unlinked": { subject: "evt.billing.mandate.unlinked", context: "getMandateNotificationContext" },
  "mandate.released": { subject: "evt.billing.mandate.released", context: "getMandateNotificationContext" },
} as const;
