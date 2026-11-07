/**
 * Payment links (lld/payments.md §6.1–§6.2, §17; checkout-and-js §1 `/l/:id`) — Stage 2.
 *
 * A link is a reusable, priced page: `https://pay.nearpay.money/l/<plink_…>`. Each payer who opens
 * it gets a fresh checkout session (`source: payment_link`). Pricing is immutable after creation
 * (INV-6); `active`, texts, limits and metadata can change. Links emit no events in v1.
 */
import { id } from "../common/ids.js";
import { createdFilterShape, listOf, listQueryShape } from "../common/pagination.js";
import { AssetId, ChainId, Livemode, Metadata, Timestamp, UnixTime, Url } from "../common/primitives.js";
import { route } from "../common/route.js";
import { inp, out, z } from "../common/schema.js";
import { SettlementDestinationType } from "./identity.js";
import { PricingAssetDisplay } from "./payer.js";
import { PricingAmount, PricingCurrency, refinePricing } from "./payments.js";

export const PaymentLink = out({
  id: id("plink"),
  object: z.literal("payment_link").describe("Always `payment_link`."),
  created: UnixTime,
  livemode: Livemode,
  active: z.boolean().describe("Whether new payers can open sessions."),
  // spec 0.2.1 — dashboard CR
  name: z
    .string()
    .nullable()
    .optional()
    .describe("Internal name in the dashboard (never shown to payers); null when unset. Spec 0.2.1."),
  url: Url.describe("Shareable payer URL (`<pay origin>/l/<id>`)."),
  amount: PricingAmount,
  currency: PricingCurrency,
  asset_id: AssetId.nullable().describe("Pricing asset when `currency` is `asset`."),
  description: z.string().describe("What the payer pays for (shown on the page)."),
  settlement_destination: id("sd")
    .nullable()
    .describe("Destination to settle to; null = account default at session time."),
  success_url: Url.nullable().describe("Redirect after payment; null = NearPay's confirmation page."),
  session_expires_in: z.int().min(300).max(86_400).describe("Lifetime of each session opened from the link, seconds."),
  max_uses: z.int().min(1).nullable().describe("Successful payments after which the link stops accepting new ones."),
  uses: z.int().min(0).describe("Successful payments so far."),
  collect_email: z.boolean().describe("The page asks the payer for a receipt email."),
  metadata: Metadata.describe("Copied onto every intent the link creates."),
}).meta({ id: "PaymentLink", description: "A reusable, priced payment page." });
export type PaymentLink = z.infer<typeof PaymentLink>;

const LinkParams = inp({ id: id("plink") });
const WRITE = ["secret_key", "restricted_key:payment_links.write", "session"] as const;
const READ = ["secret_key", "restricted_key:payment_links.read", "session"] as const;
const LINK_ROLES = ["owner", "admin", "developer", "finance"] as const;

export const PaymentLinkCreate = inp({
  amount: PricingAmount,
  currency: PricingCurrency,
  asset_id: AssetId.optional().describe("Pricing asset; required when `currency` is `asset`."),
  description: z.string().min(1).max(500).describe("What the payer pays for."),
  name: z.string().min(1).max(100).optional().describe("Internal name (never shown to payers). Spec 0.2.1."),
  settlement_destination: id("sd").optional().describe("Destination to settle to; default: the account default."),
  success_url: Url.optional().describe("Redirect after payment."),
  session_expires_in: z.int().min(300).max(86_400).optional().describe("Session lifetime, seconds (default 3600)."),
  max_uses: z.int().min(1).optional().describe("Stop after this many successful payments."),
  collect_email: z.boolean().optional().describe("Ask the payer for a receipt email (default false)."),
  metadata: Metadata.optional(),
})
  .superRefine(refinePricing)
  .meta({ id: "PaymentLinkCreate", description: "Parameters to create a payment link." });

export const createPaymentLink = route({
  id: "createPaymentLink",
  method: "POST",
  path: "/v1/payment_links",
  service: "payments",
  visibility: "public",
  summary: "Create a payment link.",
  description:
    "Validates the price like a checkout session (destination active, minimum, unverified cap, currency) at creation; each session opened later is validated again.",
  auth: WRITE,
  roles: LINK_ROLES,
  idempotent: true,
  body: PaymentLinkCreate,
  response: PaymentLink,
  status: 201,
  errors: [
    "destination_not_active",
    "amount_below_destination_minimum",
    "amount_above_unverified_cap",
    "currency_unsupported",
  ],
  stage: 2,
});

export const getPaymentLink = route({
  id: "getPaymentLink",
  method: "GET",
  path: "/v1/payment_links/{id}",
  service: "payments",
  visibility: "public",
  summary: "Retrieve a payment link.",
  auth: READ,
  idempotent: false,
  params: LinkParams,
  response: PaymentLink,
  status: 200,
  errors: [],
  stage: 2,
});

export const listPaymentLinks = route({
  id: "listPaymentLinks",
  method: "GET",
  path: "/v1/payment_links",
  service: "payments",
  visibility: "public",
  summary: "List payment links.",
  auth: READ,
  idempotent: false,
  query: inp({
    ...listQueryShape,
    ...createdFilterShape,
    active: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional()
      .describe("Only active (`true`) or inactive (`false`) links."),
  }),
  response: listOf(PaymentLink, "PaymentLinkList", "A page of payment links."),
  status: 200,
  errors: [],
  stage: 2,
});

export const updatePaymentLink = route({
  id: "updatePaymentLink",
  method: "PATCH",
  path: "/v1/payment_links/{id}",
  service: "payments",
  visibility: "public",
  summary: "Activate/deactivate a payment link or change its texts and limits (pricing is immutable).",
  auth: WRITE,
  roles: LINK_ROLES,
  idempotent: true,
  params: LinkParams,
  body: inp({
    active: z.boolean().optional().describe("Accept (`true`) or stop accepting (`false`) new payers."),
    description: z.string().min(1).max(500).optional().describe("What the payer pays for."),
    name: z.string().min(1).max(100).nullable().optional().describe("Internal name (`null` clears it). Spec 0.2.1."),
    success_url: Url.nullable().optional().describe("Redirect after payment (`null` clears it)."),
    max_uses: z.int().min(1).nullable().optional().describe("Usage limit (`null` removes it)."),
    collect_email: z.boolean().optional().describe("Ask the payer for a receipt email."),
    metadata: Metadata.optional(),
  }),
  response: PaymentLink,
  status: 200,
  errors: [],
  stage: 2,
});

// ---------------------------------------------------------------------------------------------
// Payer-facing (anonymous; checkout `/l/:id`)
// ---------------------------------------------------------------------------------------------

export const PublicPaymentLink = out({
  id: id("plink"),
  object: z.literal("payment_link").describe("Always `payment_link`."),
  livemode: Livemode,
  active: z.boolean().describe("False when the link no longer accepts payments (inactive or used up)."),
  amount: PricingAmount,
  currency: PricingCurrency,
  asset_id: AssetId.nullable().describe("Pricing asset when `currency` is `asset`."),
  display: out({
    merchant_name_unverified: z
      .string()
      .describe("Merchant display name (not authenticated; the attested name comes from sentinel per attempt)."),
    description: z.string().describe("What the payer pays for."),
  }).describe("What the payer is paying for."),
  settlement: out({
    asset_id: AssetId.describe("Asset the merchant receives."),
    chain: ChainId.describe("Chain the merchant receives on."),
    type: SettlementDestinationType,
  })
    .nullable()
    .describe("How the merchant is paid (never the raw address); null when no destination is usable now."),
  collect_email: z.boolean().describe("Ask the payer for a receipt email before opening the session."),
  // spec 0.2.1 — checkout CR
  pricing_asset: PricingAssetDisplay.nullable()
    .optional()
    .describe("Display data of the pricing asset when `currency` is `asset`; null for fiat pricing. Spec 0.2.1."),
}).meta({ id: "PublicPaymentLink", description: "A payment link as the payer sees it (no PII, no address)." });

export const getPublicPaymentLink = route({
  id: "getPublicPaymentLink",
  method: "GET",
  path: "/v1/payment_links/{id}/public",
  service: "payments",
  visibility: "public",
  summary: "Load a payment link for the payer page.",
  auth: ["anonymous"],
  idempotent: false,
  params: LinkParams,
  response: PublicPaymentLink,
  status: 200,
  errors: [],
  stage: 2,
});

export const PaymentLinkSession = out({
  object: z.literal("payment_link_session").describe("Always `payment_link_session`."),
  checkout_session: id("cs"),
  client_secret: z
    .string()
    .regex(/^cs_[0-9a-z]{26}_secret_[0-9A-Za-z]{32}$/)
    .describe("Client secret of the new session; continue with the payer API (`/c/:id` flow)."),
  url: Url.describe("Hosted checkout URL including the client secret in the fragment."),
  expires_at: Timestamp.describe("When the session stops accepting new payments."),
}).meta({ id: "PaymentLinkSession", description: "A checkout session opened from a payment link." });

export const createPaymentLinkSession = route({
  id: "createPaymentLinkSession",
  method: "POST",
  path: "/v1/payment_links/{id}/public/sessions",
  service: "payments",
  visibility: "public",
  summary: "Open a checkout session for a payer of a payment link.",
  description:
    "Anonymous; rate limited per IP and per link. Creates an intent (`source: payment_link`, link metadata copied) and a hosted session; the checkout continues exactly like `/c/:id` (attempts are Turnstile-protected there).",
  auth: ["anonymous"],
  idempotent: false,
  params: LinkParams,
  body: inp({
    customer_email: z.email().max(254).optional().describe("Receipt email (when the link collects it)."),
    locale: z.string().max(16).optional().describe("Checkout locale (BCP 47)."),
  }),
  response: PaymentLinkSession,
  status: 201,
  errors: ["link_inactive", "account_not_live", "destination_not_active", "currency_unsupported"],
  stage: 2,
});
