/** Stage 2 step 2.1 — rails, pricing/FX, Explorer, agentpay reads and CRs 15-04/06/07/10/15 (rails-fx). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ExplorerTransaction,
  estimateSettlement,
  FxRate,
  getEvidenceSummary,
  getPayerCheckoutSession,
  INTERNAL_ROUTES,
  InternalAsset,
  InternalPaymentOption,
  listEvidence,
  listExecutionObservations,
  listFxRates,
  OneClickQuoteResponse,
  OneClickStatusQuoteResponse,
  OneClickStatusResponse,
  PriceRate,
  PriceSnapshot,
  Ratio,
  sandboxExplorerTransactions,
  sandboxStatus,
} from "../src/internal-entry.js";
import {
  Attestation,
  DestinationSnapshot,
  ERRORS,
  exampleId,
  PaymentOption,
  TokenContract,
  WebhookTypeSchema,
} from "../src/public-entry.js";

const live = JSON.parse(readFileSync(new URL("./fixtures/oneclick-status-pending-live.json", import.meta.url), "utf8"));

const rate = {
  base: "eur",
  quote: "usd",
  kind: "fx",
  role: "reference",
  source: "ecb",
  value: { num: "10823", den: "10000" },
  decimal: "1.0823",
  as_of: "2026-11-06T15:00:00.000Z",
  fetched_at: "2026-11-06T15:05:00.000Z",
  valid_until: "2026-11-09T17:00:00.000Z",
};

describe("1Click live body (open-questions: mainnet findings)", () => {
  it("parses the recorded live GET /v0/status body as served (nulls, nested quote without correlationId)", () => {
    const r = OneClickStatusResponse.safeParse(live);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    expect(sandboxStatus.response.safeParse(live).success).toBe(true);
  });

  it("keeps correlationId required on the quote endpoint and optional only in the status nesting", () => {
    const q = live.quoteResponse;
    expect(OneClickQuoteResponse.safeParse(q).success).toBe(false);
    expect(OneClickQuoteResponse.safeParse({ ...q, correlationId: "c" }).success).toBe(true);
    expect(OneClickStatusQuoteResponse.safeParse(q).success).toBe(true);
    expect(OneClickStatusQuoteResponse.safeParse({ ...q, correlationId: null }).success).toBe(true);
  });
});

describe("exact rates (INV-5)", () => {
  it("Ratio accepts integer strings only, with a positive denominator", () => {
    expect(Ratio.safeParse({ num: "10823", den: "10000" }).success).toBe(true);
    expect(Ratio.safeParse({ num: "0", den: "1" }).success).toBe(true);
    for (const bad of [
      { num: 1.0823, den: "1" },
      { num: "1.0823", den: "1" },
      { num: "-1", den: "1" },
      { num: "1", den: "0" },
      { num: "01", den: "1" },
    ])
      expect(Ratio.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("PriceRate carries source and timestamps; the decimal is bounded display text", () => {
    expect(PriceRate.safeParse(rate).success).toBe(true);
    expect(PriceRate.safeParse({ ...rate, decimal: 1.0823 }).success).toBe(false);
    expect(PriceRate.safeParse({ ...rate, decimal: "1.0000000000000000001" }).success).toBe(false);
    expect(PriceRate.safeParse({ ...rate, as_of: undefined }).success).toBe(false);
    const fx = { currency: "eur", exponent: 2, available: true, stale: false, reference_date: "2026-11-06", rate };
    expect(FxRate.safeParse(fx).success).toBe(true);
  });

  it("PriceSnapshot stays valid without the 0.2.0 fields and accepts them", () => {
    const old = { primary_usd: "1", secondary_usd: null, fx: null, par: true, as_of: rate.as_of };
    expect(PriceSnapshot.safeParse(old).success).toBe(true);
    expect(PriceSnapshot.safeParse({ ...old, currency: "eur", par_currency: "usd", rates: [rate] }).success).toBe(true);
  });

  it("InternalAsset gains optional peg, par and price fields", () => {
    const a = {
      asset_id: "nep141:wrap.near",
      chain: "near:mainnet",
      blockchain: "near",
      symbol: "wNEAR",
      decimals: 24,
      family: "NEAR",
      is_usd_stable: false,
      price_usd: "2.5",
      price_ok: true,
      as_of: rate.as_of,
    };
    expect(InternalAsset.safeParse(a).success).toBe(true);
    expect(
      InternalAsset.safeParse({
        ...a,
        peg_currency: null,
        par_ok: false,
        prices: [{ ...rate, base: "nep141:wrap.near", kind: "price", role: "secondary", source: "coingecko" }],
        token: { standard: "nep141", address: "wrap.near" },
      }).success,
    ).toBe(true);
  });
});

describe("stage 2 rails routes", () => {
  it("are stage 2, owned by rails and read-only where they read", () => {
    for (const r of [listFxRates, estimateSettlement, listExecutionObservations, getEvidenceSummary]) {
      expect(r.stage, r.id).toBe(2);
      expect(r.service, r.id).toBe("rails");
      expect(INTERNAL_ROUTES).toContain(r);
    }
    expect(getEvidenceSummary.auth).toEqual(["service:rails.read", "ops:rails.read"]);
  });

  it("settlement estimate takes integer strings and the pricing currency", () => {
    const q = estimateSettlement.query;
    expect(q?.safeParse({ amount: "1999", currency: "eur" }).success).toBe(true);
    expect(q?.safeParse({ amount: "19.99", currency: "eur" }).success).toBe(false);
    expect(
      q?.safeParse({ amount: "1000000", currency: "asset", asset_id: "nep141:wrap.near", livemode: "false" }).data
        ?.livemode,
    ).toBe(false);
    expect(estimateSettlement.errors).toContain("fx_rate_unavailable");
  });

  it("fx-rates filters by a currency list; the evidence summary requires a mode (INV-8)", () => {
    expect(listFxRates.query?.safeParse({ currencies: "usd,eur" }).success).toBe(true);
    expect(listFxRates.query?.safeParse({ currencies: "USD" }).success).toBe(false);
    expect(getEvidenceSummary.query?.safeParse({ account_id: exampleId("acct"), day: "2026-11-06" }).success).toBe(
      false,
    );
    expect(
      getEvidenceSummary.query?.safeParse({ account_id: exampleId("acct"), livemode: "false", day: "2026-11-06" })
        .success,
    ).toBe(true);
  });

  it("evidence list keeps its 0.1.5 query valid and adds states/kind", () => {
    const base = { account_id: exampleId("acct"), livemode: "true", day: "2026-11-06" };
    expect(listEvidence.query?.safeParse(base).success).toBe(true);
    expect(listEvidence.query?.safeParse({ ...base, states: "succeeded,refunded", kind: "refund" }).success).toBe(true);
    expect(listEvidence.query?.safeParse({ ...base, states: "held" }).success).toBe(false);
  });

  it("fx_rate_unavailable is a retryable rail error introduced in 0.2.0", () => {
    expect(ERRORS.fx_rate_unavailable).toMatchObject({ status: 503, type: "rail_unavailable", since: "0.2.0" });
  });
});

describe("Explorer wire schema and sandbox mirror", () => {
  it("parses a documented row with nulls and an unknown status", () => {
    const row = {
      originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      depositAddress: "0x77B262Cb4dB1Ca5021F773388F244F05b66bE8F2",
      depositMemo: null,
      depositAddressAndMemo: "0x77B262Cb4dB1Ca5021F773388F244F05b66bE8F2",
      recipient: "merchant.near",
      status: "SOMETHING_NEW",
      createdAt: "2026-11-07T11:59:34.263Z",
      createdAtTimestamp: 1793966374,
      intentHashes: null,
      referral: "nearpay",
      amountIn: "0",
      amountInFormatted: "0",
      amountInUsd: "0",
      amountOut: "0",
      amountOutFormatted: "0",
      amountOutUsd: "0",
      appFees: [{ recipient: "treasury.nearpay.near", fee: 10 }],
      nearTxHashes: [],
      originChainTxHashes: [],
      destinationChainTxHashes: [],
      refundTo: "0x4De0e65AB08C2a1D21a2651E9462a42AB11B7559",
      senders: [],
      refundFeeFormatted: null,
      depositType: "ORIGIN_CHAIN",
      recipientType: "INTENTS",
      refundType: "ORIGIN_CHAIN",
    };
    expect(ExplorerTransaction.safeParse(row).success).toBe(true);
    expect(sandboxExplorerTransactions.response.safeParse([row]).success).toBe(true);
    expect(
      sandboxExplorerTransactions.query?.safeParse({
        numberOfTransactions: "1000",
        referral: "nearpay",
        statuses: "PROCESSING,INCOMPLETE_DEPOSIT",
      }).success,
    ).toBe(true);
    expect(sandboxExplorerTransactions.query?.safeParse({ numberOfTransactions: "1001" }).success).toBe(false);
  });
});

describe("change requests", () => {
  it("CR-15-06: token contract on payment options (public and rails), optional", () => {
    expect(TokenContract.safeParse({ standard: "native", address: null }).success).toBe(true);
    expect(
      TokenContract.safeParse({ standard: "erc20", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }).success,
    ).toBe(true);
    expect(PaymentOption.shape.token.safeParse(undefined).success).toBe(true);
    expect(PaymentOption.shape.token.safeParse(null).success).toBe(true);
    expect(
      InternalPaymentOption.shape.token.safeParse({ standard: "nep141", address: "usdt.tether-token.near" }).success,
    ).toBe(true);
  });

  it("CR-15-07: attested asset display data is optional", () => {
    expect(Attestation.shape.asset.safeParse(undefined).success).toBe(true);
    expect(
      Attestation.shape.asset.safeParse({ asset_id: "nep141:wrap.near", symbol: "wNEAR", decimals: 24 }).success,
    ).toBe(true);
  });

  it("CR-15-04: destination snapshot fingerprint is optional", () => {
    expect(DestinationSnapshot.shape.fingerprint.safeParse(undefined).success).toBe(true);
    expect(DestinationSnapshot.shape.fingerprint.safeParse("7KQ2-M9XA-31").success).toBe(true);
    expect(DestinationSnapshot.shape.fingerprint.safeParse("nope").success).toBe(false);
  });

  it("CR-15-10: `ping` is already a webhook type (since 0.1.0)", () => {
    expect(WebhookTypeSchema.safeParse("ping").success).toBe(true);
  });

  it("CR-15-15: payments serves agentpay the payer view of a session behind its service token", () => {
    expect(getPayerCheckoutSession.auth).toEqual(["service:payments.read"]);
    expect(getPayerCheckoutSession.errors).toEqual(["client_secret_invalid"]);
    expect(getPayerCheckoutSession.headers).toBeDefined();
  });
});
