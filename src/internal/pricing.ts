/**
 * Price and FX rate objects of rails (lld/rails.md §8.2, ADR-0020 decision 5): fiat FX from the ECB
 * reference rates, token USD prices from 1Click (primary) and a keyless public crypto feed
 * (secondary), each behind a provider interface. Integer money (INV-5): a rate is an exact
 * rational `{num, den}` of integer strings; `decimal` is a rounded rendering for display only and
 * is never used in arithmetic. No floats anywhere.
 */
import { AssetId, Currency, openEnum, out, Timestamp, z } from "@nearpay-money/spec";

/** Non-negative integer as a decimal string (≤ 78 digits). */
const IntString = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .describe("Non-negative integer as a decimal string.");
/** Positive integer as a decimal string (≤ 78 digits). */
const PositiveIntString = z
  .string()
  .regex(/^[1-9][0-9]{0,77}$/)
  .describe("Positive integer as a decimal string.");

/** An exact rate `num / den` (reduced; `den` > 0). */
export const Ratio = out({
  num: IntString.describe("Numerator (integer string)."),
  den: PositiveIntString.describe("Denominator (positive integer string)."),
}).meta({ id: "Ratio", description: "An exact rational number `num / den` (integer strings, never a float)." });
export type Ratio = z.infer<typeof Ratio>;

/** Display rendering of a rate: plain decimal, at most 18 fraction digits (rounded half-even). */
export const RateDecimal = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,59})(\.[0-9]{1,18})?$/)
  .describe("The rate as a decimal string rounded half-even to ≤ 18 places; display only, never for arithmetic.");

export const RateSource = openEnum(
  ["oneclick", "coingecko", "ecb", "sandbox", "fixed"],
  "Where a rate comes from: `oneclick` (1Click `/v0/tokens`, primary token price), `coingecko` (keyless public feed, secondary token price), `ecb` (ECB euro reference rates, fiat FX), `sandbox` (test-mode token prices), `fixed` (test-mode FX table, and `usd`→`usd`).",
);

export const RateRole = openEnum(
  ["primary", "secondary", "reference"],
  "`primary`/`secondary`: the two token prices the dual-source check compares (rails §8.2); `reference`: a fiat FX reference rate.",
);

/**
 * One rate as read from a source: `value` units of `quote` (major units, e.g. dollars) for one major
 * unit of `base` (a currency, or one whole token = 10^decimals base units of an asset).
 */
export const PriceRate = out({
  base: z.union([Currency, AssetId]).describe("What is priced: a currency code or an asset id."),
  quote: Currency.describe("Currency the value is expressed in (`usd`)."),
  kind: openEnum(["fx", "price"], "`fx`: fiat exchange rate; `price`: token price."),
  role: RateRole,
  source: RateSource,
  value: Ratio.describe("Quote major units per one major unit of `base`."),
  decimal: RateDecimal,
  as_of: Timestamp.describe(
    "When the source says the value applies (ECB: publication time of the reference day; feeds: their update time).",
  ),
  fetched_at: Timestamp.describe("When rails read it."),
  valid_until: Timestamp.nullable().describe(
    "After this instant rails no longer uses the rate (staleness bound, rails §8.2); null = no bound (`fixed`).",
  ),
}).meta({ id: "PriceRate", description: "A price or FX rate with its source and timestamps (INV-5: exact rational)." });
export type PriceRate = z.infer<typeof PriceRate>;

/** A fiat pricing currency and its current rate to USD (`GET /internal/fx-rates`). */
export const FxRate = out({
  currency: Currency.describe("Pricing currency."),
  exponent: z.int().min(0).max(4).describe("ISO 4217 minor-unit exponent (`usd` 2, `jpy` 0, `kwd` 3)."),
  available: z
    .boolean()
    .describe("Sessions/intents priced in this currency can be created now (rate present and not stale)."),
  stale: z.boolean().describe("The last rate passed its `valid_until`; it is shown but never used (rails §8.2)."),
  reference_date: z.iso
    .date()
    .nullable()
    .describe("ECB reference day `YYYY-MM-DD` of the rate (null for `usd` and test-mode `fixed` rates)."),
  rate: PriceRate.nullable().describe("Rate `<currency>/usd`, or null when never fetched."),
}).meta({ id: "FxRate", description: "A pricing currency with its FX rate to USD, source and freshness." });
export type FxRate = z.infer<typeof FxRate>;
