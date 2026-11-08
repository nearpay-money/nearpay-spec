/**
 * stage 3 — billing: subscriptions with `collection_method: send_invoice` (lld/billing.md §4–§7,
 * §11; ADR-0008; FR-BIL-02/03).
 *
 * Each period is invoiced in advance: at `current_period_end` billing creates and finalizes the next
 * period's invoice (`billing_reason: subscription_cycle`, idempotent per subscription × period start)
 * and emails it (`invoice.sent`). Periods follow `periodBoundary()` from the billing-cycle anchor.
 * No proration in v1: item changes apply from the next renewal invoice (`proration_behavior` accepts
 * only `none`). Dunning: reminders per `dunning.reminder_days`; when the last one has gone out and the
 * invoice is still unpaid, the invoice becomes `uncollectible` (`dunning_exhausted`) and the
 * subscription `canceled` or `unpaid` per `dunning.on_exhausted`.
 */
import { id } from "../common/ids.js";
import { createdFilterShape, listOf, listQueryShape } from "../common/pagination.js";
import { AssetId, Livemode, Metadata, UnixTime } from "../common/primitives.js";
import { route } from "../common/route.js";
import { closedEnum, inp, openEnum, out, z } from "../common/schema.js";
import { Price, Recurring } from "./billing-catalog.js";
import { CollectionMethod, ReminderDays } from "./invoices.js";
import { PricingCurrency } from "./payments.js";

export const SubscriptionStatus = openEnum(
  ["incomplete", "trialing", "active", "past_due", "canceled", "unpaid"],
  "Subscription status (domain-model §4.5).",
);

export const DunningSettings = out({
  reminder_days: ReminderDays,
  on_exhausted: openEnum(
    ["cancel", "unpaid"],
    "After the last reminder of an unpaid invoice: `cancel` the subscription, or keep it as `unpaid` (no new invoices until paid or canceled).",
  ),
}).meta({ id: "DunningSettings", description: "Reminder schedule and what happens when it runs out (FR-BIL-03)." });

export const SubscriptionItem = out({
  id: id("si"),
  object: z.literal("subscription_item").describe("Always `subscription_item`."),
  price: Price.describe("The recurring price (snapshot of the price object)."),
  quantity: z.int().min(1).describe("Quantity."),
  tax_rates: z
    .array(id("txr"))
    .nullable()
    .describe("Tax rates of this item; null = the subscription's `default_tax_rates`."),
}).meta({ id: "SubscriptionItem", description: "One price billed every period." });

export const Subscription = out({
  id: id("sub"),
  object: z.literal("subscription").describe("Always `subscription`."),
  created: UnixTime,
  livemode: Livemode,
  customer: id("cus", "Customer billed (owned by payments)."),
  status: SubscriptionStatus,
  collection_method: CollectionMethod,
  items: z.array(SubscriptionItem).describe("Items billed from the next renewal invoice on."),
  currency: PricingCurrency,
  asset_id: AssetId.nullable().describe("Pricing asset when `currency` is `asset`."),
  recurring: Recurring.describe("Billing period shared by every item."),
  billing_cycle_anchor: UnixTime.describe("Period boundaries are computed from this instant (`periodBoundary`)."),
  current_period_start: UnixTime.describe("Start of the current period."),
  current_period_end: UnixTime.describe("End of the current period: the next renewal invoice is created then."),
  days_until_due: z.int().min(0).max(90).describe("Each invoice is due this many days after it is finalized."),
  default_tax_rates: z.array(id("txr")).describe("Tax rates for items without their own."),
  dunning: DunningSettings,
  trial_start: UnixTime.nullable().describe("Trial start."),
  trial_end: UnixTime.nullable().describe("Trial end: the first invoice is created then."),
  cancel_at_period_end: z.boolean().describe("Cancels at `current_period_end` instead of renewing."),
  canceled_at: UnixTime.nullable().describe("When cancellation was requested or happened."),
  ended_at: UnixTime.nullable().describe("When the subscription ended (`status: canceled`)."),
  cancellation_reason: openEnum(
    ["requested", "dunning_exhausted", "incomplete_expired"],
    "Why it was canceled: by the merchant, unpaid after the reminders, or the first invoice was never paid.",
  )
    .nullable()
    .describe("Set once canceled or scheduled to cancel."),
  latest_invoice: id("in").nullable().describe("Most recent invoice of the subscription."),
  settlement_destination: id("sd")
    .nullable()
    .describe("Destination for its invoices; null = the account default when each payment session opens."),
  description: z.string().nullable().describe("Shown on every invoice of the subscription."),
  metadata: Metadata.describe("Copied onto every invoice of the subscription."),
  sequence: z.int().min(0).describe("Increases with every change; discard webhook objects with a lower sequence."),
}).meta({ id: "Subscription", description: "A customer billed every period by emailed invoice (FR-BIL-02)." });
export type Subscription = z.infer<typeof Subscription>;

const SubParams = inp({ id: id("sub") });
const WRITE = ["secret_key", "restricted_key:subscriptions.write", "session"] as const;
const READ = ["secret_key", "restricted_key:subscriptions.read", "session"] as const;
/** Dashboard roles that may create, change and cancel subscriptions. */
export const SUBSCRIPTION_ROLES = ["owner", "admin", "finance"] as const;

const ItemInput = inp({
  price: id("price").describe("An active `recurring` price."),
  quantity: z.int().min(1).max(1_000_000).optional().describe("Quantity (default 1)."),
  tax_rates: z
    .array(id("txr"))
    .max(5)
    .optional()
    .describe("Tax rates of this item (all inclusive or all exclusive); default: `default_tax_rates`."),
}).describe("A subscription item.");

const Items = z
  .array(ItemInput)
  .min(1)
  .max(20)
  .describe("Items (1–20): active recurring prices with the same currency and the same `recurring` period.");

const DunningInput = inp({
  reminder_days: ReminderDays.optional().describe("Default `[-3, 0, 1, 3, 7]`."),
  on_exhausted: closedEnum(["cancel", "unpaid"], "Default `cancel`.").optional(),
}).describe("Dunning settings.");

const ProrationBehavior = z
  .literal("none")
  .optional()
  .describe("Only `none`: v1 has no proration; item changes apply from the next renewal invoice.");

const ITEM_ERRORS = [
  "price_inactive",
  "price_type_invalid",
  "currency_mismatch",
  "interval_mismatch",
  "tax_rate_inactive",
  "tax_rates_mixed",
] as const;

export const SubscriptionCreate = inp({
  customer: id("cus").describe("Customer to bill (not deleted)."),
  items: Items,
  collection_method: z.literal("send_invoice").optional().describe("`send_invoice` (the only method in v1; default)."),
  days_until_due: z.int().min(0).max(90).optional().describe("Invoice due after this many days (default 7)."),
  trial_period_days: z
    .int()
    .min(1)
    .max(730)
    .optional()
    .describe("Free trial: the first invoice is created when it ends (status `trialing` until then)."),
  default_tax_rates: z.array(id("txr")).max(5).optional().describe("Tax rates for items without their own."),
  dunning: DunningInput.optional(),
  description: z.string().max(500).optional().describe("Shown on every invoice."),
  settlement_destination: id("sd").optional().describe("Destination for its invoices; default: the account default."),
  metadata: Metadata.optional(),
}).meta({ id: "SubscriptionCreate", description: "Parameters to create a subscription." });

export const createSubscription = route({
  id: "createSubscription",
  method: "POST",
  path: "/v1/subscriptions",
  service: "billing",
  visibility: "public",
  summary: "Create a subscription.",
  description:
    "Without a trial the first invoice (`subscription_create`) is created, finalized and sent at once and the subscription is `incomplete` until it is paid (then `active`); if it is still unpaid when its reminders run out the subscription is canceled (`incomplete_expired`). With `trial_period_days` the subscription is `trialing` and the first invoice follows at `trial_end`. The anchor is the creation time (or `trial_end`).",
  auth: WRITE,
  roles: SUBSCRIPTION_ROLES,
  idempotent: true,
  body: SubscriptionCreate,
  response: Subscription,
  status: 201,
  errors: [
    "customer_deleted",
    "customer_email_missing",
    ...ITEM_ERRORS,
    "account_not_live",
    "destination_not_active",
    "amount_below_destination_minimum",
    "currency_unsupported",
  ],
  stage: 3,
});

export const getSubscription = route({
  id: "getSubscription",
  method: "GET",
  path: "/v1/subscriptions/{id}",
  service: "billing",
  visibility: "public",
  summary: "Retrieve a subscription.",
  auth: READ,
  idempotent: false,
  params: SubParams,
  response: Subscription,
  status: 200,
  errors: [],
  stage: 3,
});

export const listSubscriptions = route({
  id: "listSubscriptions",
  method: "GET",
  path: "/v1/subscriptions",
  service: "billing",
  visibility: "public",
  summary: "List subscriptions.",
  auth: READ,
  idempotent: false,
  query: inp({
    ...listQueryShape,
    ...createdFilterShape,
    status: SubscriptionStatus.optional().describe("Only subscriptions in this status."),
    customer: id("cus").optional().describe("Only subscriptions of this customer."),
    price: id("price").optional().describe("Only subscriptions with an item on this price."),
  }),
  response: listOf(Subscription, "SubscriptionList", "A page of subscriptions."),
  status: 200,
  errors: [],
  stage: 3,
});

export const updateSubscription = route({
  id: "updateSubscription",
  method: "PATCH",
  path: "/v1/subscriptions/{id}",
  service: "billing",
  visibility: "public",
  summary: "Change a subscription from the next renewal on, or schedule/undo cancellation at period end.",
  description:
    "`items` replaces every item (same currency and period as before: the period cannot change). Changes never touch invoices already created and never prorate. `canceled` subscriptions answer `409 state_conflict`. Emits `customer.subscription.updated`.",
  auth: WRITE,
  roles: SUBSCRIPTION_ROLES,
  idempotent: true,
  params: SubParams,
  body: inp({
    items: Items.optional(),
    days_until_due: z.int().min(0).max(90).optional().describe("Due days for later invoices."),
    default_tax_rates: z.array(id("txr")).max(5).optional().describe("Default tax rates for later invoices."),
    dunning: DunningInput.optional(),
    cancel_at_period_end: z
      .boolean()
      .optional()
      .describe("Schedule (`true`) or undo (`false`) cancellation at period end."),
    description: z.string().max(500).nullable().optional().describe("Invoice text (`null` clears it)."),
    settlement_destination: id("sd").nullable().optional().describe("Destination (`null` = account default)."),
    proration_behavior: ProrationBehavior,
    metadata: Metadata.optional(),
  }).meta({ id: "SubscriptionUpdate", description: "Subscription fields to change." }),
  response: Subscription,
  status: 200,
  errors: ["state_conflict", ...ITEM_ERRORS],
  stage: 3,
});

export const cancelSubscription = route({
  id: "cancelSubscription",
  method: "POST",
  path: "/v1/subscriptions/{id}/cancel",
  service: "billing",
  visibility: "public",
  summary: "Cancel a subscription now or at the end of the current period.",
  description:
    "`at_period_end: true` sets `cancel_at_period_end` (`customer.subscription.updated`); the subscription ends at `current_period_end` without a renewal invoice. Otherwise it ends now (`canceled`, `customer.subscription.deleted`). No refund or credit is created (no proration); open invoices are left as they are — void them if they should not be paid.",
  auth: WRITE,
  roles: SUBSCRIPTION_ROLES,
  idempotent: true,
  params: SubParams,
  body: inp({
    at_period_end: z.boolean().optional().describe("Cancel at `current_period_end` (default `false` = now)."),
  }),
  response: Subscription,
  status: 200,
  errors: ["state_conflict"],
  stage: 3,
});
