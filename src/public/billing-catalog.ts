/**
 * stage 3 — billing: catalogue objects (lld/billing.md §3, §5, §9, §11) — Products, Prices and
 * Tax rates, plus the executable tax and billing-period rules every reader shares.
 *
 * - Prices are immutable except `active`, `nickname` and `metadata` (INV-6: an invoice line always
 *   reproduces from its price).
 * - Tax rates are manual (FR-BIL-01): an exact decimal percentage (≤ 4 decimals, i.e. a rational
 *   `ppm / 1 000 000`), inclusive or exclusive. `percentage` and `inclusive` are immutable.
 * - Tax is computed **per line, in integer units of the invoice currency** (fiat minor units or
 *   asset base units), **rounded half-up** — `computeLineTax` / `computeInvoiceTotals` below are the
 *   normative implementation (vectors: `test-vectors/billing-tax.json`).
 */
import { id } from "../common/ids.js";
import { createdFilterShape, listOf, listQueryShape } from "../common/pagination.js";
import { AssetId, CountryCode, Livemode, Metadata, UnixTime } from "../common/primitives.js";
import { route } from "../common/route.js";
import { inp, openEnum, out, z } from "../common/schema.js";
import { PricingAmount, PricingCurrency } from "./payments.js";

// =============================================================================================
// Shared pieces
// =============================================================================================

const WRITE = ["secret_key", "restricted_key:products.write", "session"] as const;
const READ = ["secret_key", "restricted_key:products.read", "session"] as const;
/** Dashboard roles that may change the catalogue (products, prices, tax rates). */
export const CATALOG_ROLES = ["owner", "admin", "developer", "finance"] as const;

const BoolQuery = (what: string) =>
  z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional()
    .describe(what);

/** Recurring interval unit. */
export const BillingInterval = openEnum(["day", "week", "month", "year"], "Unit of a billing period.");

export const Recurring = out({
  interval: BillingInterval,
  interval_count: z.int().min(1).max(12).describe("Number of `interval` units per period, 1–12."),
}).meta({ id: "PriceRecurring", description: "How often a recurring price bills." });

/** Validates fiat (integer minor units) vs asset (base-unit string) amounts for `currency`. */
export function refineAmountForCurrency(
  v: { currency?: string | undefined; asset_id?: string | undefined },
  amount: number | string | undefined,
  path: string,
  ctx: z.RefinementCtx,
): void {
  if (v.currency === undefined) return;
  if (v.currency === "asset") {
    if (v.asset_id === undefined)
      ctx.addIssue({ code: "custom", path: ["asset_id"], message: "required when currency is asset" });
    if (amount !== undefined && typeof amount !== "string")
      ctx.addIssue({ code: "custom", path: [path], message: "must be a base-unit string when currency is asset" });
  } else {
    if (v.asset_id !== undefined)
      ctx.addIssue({ code: "custom", path: ["asset_id"], message: "only allowed when currency is asset" });
    if (amount !== undefined && typeof amount !== "number")
      ctx.addIssue({ code: "custom", path: [path], message: "must be an integer in minor units for fiat" });
  }
}

// =============================================================================================
// Products
// =============================================================================================

export const Product = out({
  id: id("prod"),
  object: z.literal("product").describe("Always `product`."),
  created: UnixTime,
  updated: UnixTime.describe("Last change."),
  livemode: Livemode,
  name: z.string().describe("Name shown on invoices and the hosted invoice page."),
  description: z.string().nullable().describe("Longer description (shown under the name on invoices)."),
  active: z.boolean().describe("Archived products (`false`) cannot get new prices used on new invoices."),
  metadata: Metadata,
}).meta({ id: "Product", description: "Something the merchant sells (FR-BIL-01)." });
export type Product = z.infer<typeof Product>;

const ProductParams = inp({ id: id("prod") });

export const createProduct = route({
  id: "createProduct",
  method: "POST",
  path: "/v1/products",
  service: "billing",
  visibility: "public",
  summary: "Create a product.",
  auth: WRITE,
  roles: CATALOG_ROLES,
  idempotent: true,
  body: inp({
    name: z.string().min(1).max(250).describe("Name."),
    description: z.string().max(1000).optional().describe("Description."),
    active: z.boolean().optional().describe("Default `true`."),
    metadata: Metadata.optional(),
  }).meta({ id: "ProductCreate", description: "Parameters to create a product." }),
  response: Product,
  status: 201,
  errors: [],
  stage: 3,
});

export const getProduct = route({
  id: "getProduct",
  method: "GET",
  path: "/v1/products/{id}",
  service: "billing",
  visibility: "public",
  summary: "Retrieve a product.",
  auth: READ,
  idempotent: false,
  params: ProductParams,
  response: Product,
  status: 200,
  errors: [],
  stage: 3,
});

export const listProducts = route({
  id: "listProducts",
  method: "GET",
  path: "/v1/products",
  service: "billing",
  visibility: "public",
  summary: "List products.",
  auth: READ,
  idempotent: false,
  query: inp({
    ...listQueryShape,
    ...createdFilterShape,
    active: BoolQuery("Only active (`true`) or archived (`false`) products."),
  }),
  response: listOf(Product, "ProductList", "A page of products."),
  status: 200,
  errors: [],
  stage: 3,
});

export const updateProduct = route({
  id: "updateProduct",
  method: "PATCH",
  path: "/v1/products/{id}",
  service: "billing",
  visibility: "public",
  summary: "Update or archive a product (`null` clears a field).",
  description:
    "Changes apply to invoices finalized afterwards; finalized invoices keep the name they were issued with.",
  auth: WRITE,
  roles: CATALOG_ROLES,
  idempotent: true,
  params: ProductParams,
  body: inp({
    name: z.string().min(1).max(250).optional().describe("Name."),
    description: z.string().max(1000).nullable().optional().describe("Description (`null` clears it)."),
    active: z.boolean().optional().describe("Archive (`false`) or restore (`true`)."),
    metadata: Metadata.optional(),
  }).meta({ id: "ProductUpdate", description: "Product fields to change." }),
  response: Product,
  status: 200,
  errors: [],
  stage: 3,
});

// =============================================================================================
// Prices
// =============================================================================================

export const PriceType = openEnum(["one_time", "recurring"], "One-time charge or a recurring (subscription) price.");

export const Price = out({
  id: id("price"),
  object: z.literal("price").describe("Always `price`."),
  created: UnixTime,
  livemode: Livemode,
  product: id("prod"),
  active: z.boolean().describe("Inactive prices cannot be used on new invoices or subscriptions."),
  type: PriceType,
  unit_amount: PricingAmount.describe("Price per unit. Fiat: integer minor units. Asset: base units as a string."),
  currency: PricingCurrency,
  asset_id: AssetId.nullable().describe("Pricing asset when `currency` is `asset`."),
  recurring: Recurring.nullable().describe("Billing period of a `recurring` price; null for `one_time`."),
  nickname: z.string().nullable().describe("Internal label (never shown to customers)."),
  metadata: Metadata,
}).meta({ id: "Price", description: "How much and how often a product costs (immutable pricing, INV-6)." });
export type Price = z.infer<typeof Price>;

const PriceParams = inp({ id: id("price") });

export const PriceCreate = inp({
  product: id("prod").describe("Product the price belongs to."),
  unit_amount: PricingAmount,
  currency: PricingCurrency,
  asset_id: AssetId.optional().describe("Pricing asset; required when `currency` is `asset`."),
  recurring: inp({
    interval: BillingInterval,
    interval_count: z.int().min(1).max(12).optional().describe("Units per period (default 1)."),
  })
    .optional()
    .describe("Makes the price `recurring`; omit for `one_time`."),
  nickname: z.string().min(1).max(100).optional().describe("Internal label."),
  active: z.boolean().optional().describe("Default `true`."),
  metadata: Metadata.optional(),
})
  .superRefine((v, ctx) => refineAmountForCurrency(v, v.unit_amount, "unit_amount", ctx))
  .meta({ id: "PriceCreate", description: "Parameters to create a price." });

export const createPrice = route({
  id: "createPrice",
  method: "POST",
  path: "/v1/prices",
  service: "billing",
  visibility: "public",
  summary: "Create a price for a product.",
  description:
    "Pricing (`unit_amount`, `currency`, `asset_id`, `recurring`) is immutable; create a new price and deactivate the old one to change it. `currency` must be one payments accepts for checkout sessions.",
  auth: WRITE,
  roles: CATALOG_ROLES,
  idempotent: true,
  body: PriceCreate,
  response: Price,
  status: 201,
  errors: ["currency_unsupported"],
  stage: 3,
});

export const getPrice = route({
  id: "getPrice",
  method: "GET",
  path: "/v1/prices/{id}",
  service: "billing",
  visibility: "public",
  summary: "Retrieve a price.",
  auth: READ,
  idempotent: false,
  params: PriceParams,
  response: Price,
  status: 200,
  errors: [],
  stage: 3,
});

export const listPrices = route({
  id: "listPrices",
  method: "GET",
  path: "/v1/prices",
  service: "billing",
  visibility: "public",
  summary: "List prices.",
  auth: READ,
  idempotent: false,
  query: inp({
    ...listQueryShape,
    ...createdFilterShape,
    product: id("prod").optional().describe("Only prices of this product."),
    active: BoolQuery("Only active (`true`) or inactive (`false`) prices."),
    type: PriceType.optional().describe("Only prices of this type."),
    currency: PricingCurrency.optional().describe("Only prices in this currency (`asset` = asset-priced)."),
  }),
  response: listOf(Price, "PriceList", "A page of prices."),
  status: 200,
  errors: [],
  stage: 3,
});

export const updatePrice = route({
  id: "updatePrice",
  method: "PATCH",
  path: "/v1/prices/{id}",
  service: "billing",
  visibility: "public",
  summary: "Activate/deactivate a price or change its label and metadata (pricing is immutable).",
  auth: WRITE,
  roles: CATALOG_ROLES,
  idempotent: true,
  params: PriceParams,
  body: inp({
    active: z.boolean().optional().describe("Deactivate (`false`) or reactivate (`true`)."),
    nickname: z.string().min(1).max(100).nullable().optional().describe("Internal label (`null` clears it)."),
    metadata: Metadata.optional(),
  }).meta({ id: "PriceUpdate", description: "Price fields to change." }),
  response: Price,
  status: 200,
  errors: [],
  stage: 3,
});

// =============================================================================================
// Tax rates
// =============================================================================================

/** Exact decimal percentage, 0–100 with at most 4 decimals (`"19"`, `"8.875"`, `"7.6"`). */
export const TaxPercentage = z
  .string()
  .regex(/^(100(\.0{1,4})?|[1-9]?[0-9](\.[0-9]{1,4})?)$/, "must be a decimal 0–100 with at most 4 decimals")
  .meta({
    description:
      "Exact percentage as a decimal string, 0–100 with at most 4 decimals (the rate is the rational `ppm / 1 000 000`, ppm = percentage × 10 000). No floats.",
    examples: ["19", "8.875"],
  });

export const TaxRate = out({
  id: id("txr"),
  object: z.literal("tax_rate").describe("Always `tax_rate`."),
  created: UnixTime,
  livemode: Livemode,
  display_name: z.string().describe("Name on invoices, e.g. `VAT` or `Sales tax`."),
  description: z.string().nullable().describe("Internal description."),
  jurisdiction: z
    .string()
    .nullable()
    .describe("Where the rate applies, free text shown on invoices (e.g. `DE`, `US-NY`)."),
  country: CountryCode.nullable().describe("Country of the jurisdiction, if any."),
  percentage: TaxPercentage,
  rate_ppm: z
    .int()
    .min(0)
    .max(1_000_000)
    .describe("The same rate in parts per million (`percentage` × 10 000); exact, for integer arithmetic."),
  inclusive: z
    .boolean()
    .describe("`true`: the line amount already contains the tax. `false`: the tax is added on top."),
  active: z.boolean().describe("Inactive rates cannot be put on new invoices or subscriptions."),
  metadata: Metadata,
}).meta({ id: "TaxRate", description: "A manual tax rate (FR-BIL-01); percentage and inclusiveness are immutable." });
export type TaxRate = z.infer<typeof TaxRate>;

const TaxRateParams = inp({ id: id("txr") });

export const createTaxRate = route({
  id: "createTaxRate",
  method: "POST",
  path: "/v1/tax_rates",
  service: "billing",
  visibility: "public",
  summary: "Create a tax rate.",
  auth: WRITE,
  roles: CATALOG_ROLES,
  idempotent: true,
  body: inp({
    display_name: z.string().min(1).max(50).describe("Name on invoices."),
    percentage: TaxPercentage,
    inclusive: z.boolean().describe("Whether line amounts include this tax."),
    description: z.string().max(500).optional().describe("Internal description."),
    jurisdiction: z.string().min(1).max(50).optional().describe("Where the rate applies (shown on invoices)."),
    country: CountryCode.optional().describe("Country of the jurisdiction."),
    active: z.boolean().optional().describe("Default `true`."),
    metadata: Metadata.optional(),
  }).meta({ id: "TaxRateCreate", description: "Parameters to create a tax rate." }),
  response: TaxRate,
  status: 201,
  errors: [],
  stage: 3,
});

export const getTaxRate = route({
  id: "getTaxRate",
  method: "GET",
  path: "/v1/tax_rates/{id}",
  service: "billing",
  visibility: "public",
  summary: "Retrieve a tax rate.",
  auth: READ,
  idempotent: false,
  params: TaxRateParams,
  response: TaxRate,
  status: 200,
  errors: [],
  stage: 3,
});

export const listTaxRates = route({
  id: "listTaxRates",
  method: "GET",
  path: "/v1/tax_rates",
  service: "billing",
  visibility: "public",
  summary: "List tax rates.",
  auth: READ,
  idempotent: false,
  query: inp({
    ...listQueryShape,
    ...createdFilterShape,
    active: BoolQuery("Only active (`true`) or inactive (`false`) rates."),
    inclusive: BoolQuery("Only inclusive (`true`) or exclusive (`false`) rates."),
  }),
  response: listOf(TaxRate, "TaxRateList", "A page of tax rates."),
  status: 200,
  errors: [],
  stage: 3,
});

export const updateTaxRate = route({
  id: "updateTaxRate",
  method: "PATCH",
  path: "/v1/tax_rates/{id}",
  service: "billing",
  visibility: "public",
  summary: "Update a tax rate's labels or deactivate it (`percentage` and `inclusive` are immutable).",
  auth: WRITE,
  roles: CATALOG_ROLES,
  idempotent: true,
  params: TaxRateParams,
  body: inp({
    display_name: z.string().min(1).max(50).optional().describe("Name on invoices."),
    description: z.string().max(500).nullable().optional().describe("Internal description (`null` clears it)."),
    jurisdiction: z.string().min(1).max(50).nullable().optional().describe("Jurisdiction (`null` clears it)."),
    country: CountryCode.nullable().optional().describe("Country (`null` clears it)."),
    active: z.boolean().optional().describe("Deactivate (`false`) or reactivate (`true`)."),
    metadata: Metadata.optional(),
  }).meta({ id: "TaxRateUpdate", description: "Tax-rate fields to change." }),
  response: TaxRate,
  status: 200,
  errors: [],
  stage: 3,
});

// =============================================================================================
// Normative tax arithmetic (lld/billing.md §9, §11) — bigint only, no floats (INV-5)
// =============================================================================================

/** Denominator of `rate_ppm`. */
export const TAX_PPM_DENOMINATOR = 1_000_000n;

/** `"8.875"` → 88 750 ppm (exact). Throws on anything `TaxPercentage` rejects. */
export function taxPercentageToPpm(percentage: string): number {
  if (!TaxPercentage.safeParse(percentage).success) throw new Error(`invalid tax percentage ${percentage}`);
  const [int, frac = ""] = percentage.split(".");
  return Number(int) * 10_000 + Number(frac.padEnd(4, "0"));
}

/** Round-half-up integer division for non-negative `n` and positive `d`: ⌊n/d + 1/2⌋. */
export function divRoundHalfUp(n: bigint, d: bigint): bigint {
  if (n < 0n || d <= 0n) throw new Error("divRoundHalfUp: n must be ≥ 0 and d > 0");
  return (2n * n + d) / (2n * d);
}

/** A tax rate as the arithmetic needs it. */
export interface TaxRateInput {
  readonly id: string;
  readonly rate_ppm: number;
  readonly inclusive: boolean;
}

export interface LineTax {
  readonly tax_rate: string;
  readonly inclusive: boolean;
  readonly amount: bigint;
  /** Amount the rate applies to: the line amount (exclusive) or the line amount less its inclusive taxes. */
  readonly taxable_amount: bigint;
}

/**
 * Taxes of one line whose amount is `amount` (= unit amount × quantity, integer units of the
 * invoice currency). Rules (normative):
 * - all rates on one line are inclusive or all are exclusive (`tax_rates_mixed` otherwise);
 * - exclusive rate i: `tax_i = round_half_up(amount × ppm_i / 10⁶)`;
 * - inclusive rates (P = Σ ppm): `tax_i = round_half_up(amount × ppm_i / (10⁶ + P))` — each rate is
 *   rounded on its own, so the sum may differ by one unit from a combined computation;
 * - `taxable_amount` = `amount` (exclusive) or `amount − Σ inclusive tax_i` (inclusive).
 */
export function computeLineTax(amount: bigint, rates: readonly TaxRateInput[]): LineTax[] {
  if (amount < 0n) throw new Error("line amount must be ≥ 0");
  if (rates.length === 0) return [];
  const inclusive = rates[0]?.inclusive === true;
  if (rates.some((r) => r.inclusive !== inclusive)) throw new Error("tax_rates_mixed");
  if (!inclusive) {
    return rates.map((r) => ({
      tax_rate: r.id,
      inclusive: false,
      amount: divRoundHalfUp(amount * BigInt(r.rate_ppm), TAX_PPM_DENOMINATOR),
      taxable_amount: amount,
    }));
  }
  const p = rates.reduce((s, r) => s + BigInt(r.rate_ppm), 0n);
  const taxes = rates.map((r) => divRoundHalfUp(amount * BigInt(r.rate_ppm), TAX_PPM_DENOMINATOR + p));
  const net = amount - taxes.reduce((s, t) => s + t, 0n);
  return rates.map((r, i) => ({ tax_rate: r.id, inclusive: true, amount: taxes[i] as bigint, taxable_amount: net }));
}

export interface InvoiceTotals {
  /** Σ line amounts as priced (inclusive taxes stay inside). */
  readonly subtotal: bigint;
  /** Σ every tax amount (inclusive and exclusive). */
  readonly tax: bigint;
  /** subtotal + Σ exclusive tax — what the customer pays (`amount_due`). */
  readonly total: bigint;
  /** total − tax. */
  readonly total_excluding_tax: bigint;
  /** Per tax rate, in order of first appearance: Σ amount and Σ taxable amount. */
  readonly total_tax_amounts: readonly LineTax[];
  readonly lines: readonly { readonly amount: bigint; readonly taxes: readonly LineTax[] }[];
}

/** Totals of an invoice from its lines (`amount` = unit amount × quantity). Rounding happens per line only. */
export function computeInvoiceTotals(
  lines: readonly { readonly amount: bigint; readonly tax_rates: readonly TaxRateInput[] }[],
): InvoiceTotals {
  let subtotal = 0n;
  let tax = 0n;
  let exclusive = 0n;
  const per = new Map<string, { inclusive: boolean; amount: bigint; taxable_amount: bigint }>();
  const out: { amount: bigint; taxes: LineTax[] }[] = [];
  for (const l of lines) {
    const taxes = computeLineTax(l.amount, l.tax_rates);
    subtotal += l.amount;
    for (const t of taxes) {
      tax += t.amount;
      if (!t.inclusive) exclusive += t.amount;
      const acc = per.get(t.tax_rate) ?? { inclusive: t.inclusive, amount: 0n, taxable_amount: 0n };
      acc.amount += t.amount;
      acc.taxable_amount += t.taxable_amount;
      per.set(t.tax_rate, acc);
    }
    out.push({ amount: l.amount, taxes });
  }
  const total = subtotal + exclusive;
  return {
    subtotal,
    tax,
    total,
    total_excluding_tax: total - tax,
    total_tax_amounts: [...per.entries()].map(([tax_rate, v]) => ({ tax_rate, ...v })),
    lines: out,
  };
}

// =============================================================================================
// Normative billing periods (lld/billing.md §11)
// =============================================================================================

/**
 * Boundary `n` of the periods that start at `anchor` (unix seconds, UTC): `day`/`week` add
 * `n × count × 86 400 (× 7)` seconds; `month`/`year` add calendar months (`year` = 12 months) to the
 * anchor's UTC date, clamping the day to the target month's last day and keeping the time of day.
 * Boundaries are always computed from the anchor, never chained, so 31 Jan → 28/29 Feb → 31 Mar.
 */
export function periodBoundary(
  anchor: number,
  interval: "day" | "week" | "month" | "year",
  count: number,
  n: number,
): number {
  if (!Number.isInteger(anchor) || !Number.isInteger(count) || !Number.isInteger(n) || count < 1 || n < 0) {
    throw new Error("periodBoundary: integer anchor, count ≥ 1, n ≥ 0");
  }
  if (interval === "day") return anchor + n * count * 86_400;
  if (interval === "week") return anchor + n * count * 604_800;
  const months = n * count * (interval === "year" ? 12 : 1);
  const a = new Date(anchor * 1000);
  const y = a.getUTCFullYear();
  const m = a.getUTCMonth() + months;
  const ty = y + Math.floor(m / 12);
  const tm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const day = Math.min(a.getUTCDate(), last);
  return Date.UTC(ty, tm, day, a.getUTCHours(), a.getUTCMinutes(), a.getUTCSeconds(), a.getUTCMilliseconds()) / 1000;
}
