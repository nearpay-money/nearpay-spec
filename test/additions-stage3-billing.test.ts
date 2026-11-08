/** Stage 3 billing contracts (step 3.1): catalogue, invoices, subscriptions, hosted invoice, invoice sessions. */
import { describe, expect, it } from "vitest";
import {
  BILLING_EMAIL_TEMPLATES,
  consumerFilters,
  createInvoiceCheckoutSession,
  INTERNAL_ROUTES,
  InvoiceEvent,
  STREAMS,
  SUBJECTS,
} from "../src/internal-entry.js";
import {
  CheckoutSession,
  computeInvoiceTotals,
  computeLineTax,
  createInvoice,
  createPrice,
  createPublicInvoiceSession,
  createSubscription,
  divRoundHalfUp,
  exampleId,
  getInvoicePdf,
  getPublicInvoice,
  HEADERS,
  ID_PREFIXES,
  Invoice,
  idPattern,
  PaymentIntent,
  PUBLIC_ANONYMOUS_ROUTES,
  PUBLIC_ROUTES,
  periodBoundary,
  route,
  SERVICE_CLIENT_SCOPES,
  SUBJECT_TO_WEBHOOK_TYPE,
  TaxPercentage,
  taxPercentageToPpm,
  updateInvoice,
  updateSubscription,
  WEBHOOK_TYPES,
  z,
} from "../src/public-entry.js";

type Parser = { safeParse(v: unknown): { success: boolean } } | undefined;
const ok = (schema: Parser, v: unknown): boolean => schema?.safeParse(v).success === true;
const r = (id: string, ppm: number, inclusive: boolean) => ({ id, rate_ppm: ppm, inclusive });

const BILLING_IDS =
  /^(create|get|list|update|delete|finalize|send|void|mark|cancel|advance)(Product|Price|TaxRate|Invoice|Subscription|PublicInvoice)/;

describe("stage 3 billing: routes", () => {
  // stage 4 — autodebit: Stage 4 mandate routes are covered by additions-stage4-autodebit.test.ts
  const billing = PUBLIC_ROUTES.filter((x) => x.service === "billing" && x.stage === 3);

  it("serves the catalogue, invoices, subscriptions and hosted-invoice routes from billing in Stage 3", () => {
    expect(billing.length).toBe(31); // 0.3.1: + advanceSubscriptionClock
    for (const x of billing) {
      expect(x.stage, x.id).toBe(3);
      expect(x.id, x.id).toMatch(BILLING_IDS);
    }
  });

  it("guards merchant writes with scopes and dashboard roles; reads allow any role", () => {
    for (const x of billing.filter((b) => !b.auth.includes("anonymous"))) {
      expect(x.auth, x.id).toContain("session");
      const scoped = x.auth.find((a) => a.startsWith("restricted_key:")) as string;
      expect(scoped, x.id).toMatch(/^restricted_key:(products|invoices|subscriptions)\.(read|write)$/);
      if (scoped.endsWith(".write")) {
        expect(x.roles?.length, x.id).toBeGreaterThan(0);
        expect(x.roles, x.id).not.toContain("viewer");
      } else expect(x.roles, x.id).toBeUndefined();
    }
  });

  it("puts the hosted invoice routes on the anonymous allow-list behind the invoice secret", () => {
    const pub = billing.filter((b) => b.auth.includes("anonymous"));
    expect(pub.map((p) => p.id).sort()).toEqual([
      "createPublicInvoiceSession",
      "getPublicInvoice",
      "getPublicInvoicePdf",
    ]);
    for (const p of pub) {
      expect(p.headers instanceof z.ZodObject && HEADERS.invoiceSecret.toLowerCase() in p.headers.shape, p.id).toBe(
        true,
      );
      expect(p.errors, p.id).toContain("invoice_secret_invalid");
      expect(
        PUBLIC_ANONYMOUS_ROUTES.some((a) => a.path === p.path && a.method === p.method),
        p.id,
      ).toBe(true);
    }
    const secret = `${exampleId("in")}_secret_${"a".repeat(32)}`;
    expect(ok(getPublicInvoice.headers, { "x-nearpay-invoice-secret": secret })).toBe(true);
    expect(ok(getPublicInvoice.headers, { "x-nearpay-invoice-secret": "cs_x_secret_y" })).toBe(false);
    expect(createPublicInvoiceSession.errors).toContain("invoice_not_payable");
  });

  it("serves PDFs as raw bytes", () => {
    expect(getInvoicePdf.response).toBeNull();
    expect(getInvoicePdf.binaryResponse?.contentType).toBe("application/pdf");
    expect(() =>
      route({
        id: "x",
        method: "GET",
        path: "/v1/x",
        service: "billing",
        visibility: "public",
        summary: "s",
        auth: ["secret_key"],
        idempotent: false,
        response: z.string(),
        binaryResponse: { contentType: "application/pdf", description: "d" },
        status: 200,
        errors: [],
        stage: 3,
      }),
    ).toThrow(/binary/);
  });

  it("adds tax-rate, invoice-line and subscription-item prefixes", () => {
    expect(ID_PREFIXES.txr.owner).toBe("billing");
    expect(ID_PREFIXES.il.owner).toBe("billing");
    expect(ID_PREFIXES.si.owner).toBe("billing");
    expect(idPattern("txr").test(exampleId("txr"))).toBe(true);
  });
});

describe("stage 3 billing: request rules", () => {
  it("validates fiat vs asset prices", () => {
    const base = { product: exampleId("prod") };
    expect(ok(createPrice.body, { ...base, unit_amount: 4999, currency: "usd" })).toBe(true);
    expect(ok(createPrice.body, { ...base, unit_amount: "4999", currency: "usd" })).toBe(false);
    expect(ok(createPrice.body, { ...base, unit_amount: 1, currency: "asset", asset_id: "nep141:usdc.near" })).toBe(
      false,
    );
    expect(
      ok(createPrice.body, {
        ...base,
        unit_amount: "1000000",
        currency: "usd",
        recurring: { interval: "month", interval_count: 13 },
      }),
    ).toBe(false);
  });

  it("accepts price lines and custom-amount lines, rejects mixed due settings", () => {
    const customer = exampleId("cus");
    expect(
      ok(createInvoice.body, {
        customer,
        currency: "usd",
        lines: [
          { price: exampleId("price"), quantity: 2 },
          { unit_amount: 1500, description: "Setup", tax_rates: [exampleId("txr")] },
        ],
      }),
    ).toBe(true);
    expect(
      ok(createInvoice.body, { customer, currency: "usd", lines: [{ unit_amount: "15", description: "x" }] }),
    ).toBe(false);
    expect(ok(createInvoice.body, { customer, days_until_due: 7, due_date: 1793900000 })).toBe(false);
    expect(ok(createInvoice.body, { customer, collection_method: "auto_debit" })).toBe(false);
    expect(ok(createInvoice.body, { customer, reminder_days: [3, 1] })).toBe(false);
    expect(ok(createInvoice.body, { customer, reminder_days: [] })).toBe(true);
    expect(ok(updateInvoice.body, { lines: [{ unit_amount: 100, description: "x" }] })).toBe(true);
  });

  it("rejects proration (v1 applies changes from the next renewal)", () => {
    expect(ok(updateSubscription.body, { proration_behavior: "none" })).toBe(true);
    expect(ok(updateSubscription.body, { proration_behavior: "create_prorations" })).toBe(false);
    expect(ok(createSubscription.body, { customer: exampleId("cus"), items: [] })).toBe(false);
  });
});

describe("stage 3 billing: tax arithmetic (exact rationals, half-up per line)", () => {
  it("parses percentages exactly", () => {
    expect(taxPercentageToPpm("19")).toBe(190_000);
    expect(taxPercentageToPpm("8.875")).toBe(88_750);
    expect(taxPercentageToPpm("0.0001")).toBe(1);
    expect(taxPercentageToPpm("100")).toBe(1_000_000);
    for (const bad of ["100.1", "8.87501", "-1", "1e1", "08.5", "abc"])
      expect(TaxPercentage.safeParse(bad).success, bad).toBe(false);
    expect(() => taxPercentageToPpm("101")).toThrow();
  });

  it("rounds half up", () => {
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divRoundHalfUp(4n, 3n)).toBe(1n);
    expect(divRoundHalfUp(5n, 3n)).toBe(2n);
    expect(divRoundHalfUp(0n, 7n)).toBe(0n);
  });

  it("computes exclusive and inclusive taxes per line", () => {
    expect(computeLineTax(1000n, [r("a", 88_750, false)])[0]?.amount).toBe(89n);
    expect(computeLineTax(100n, [r("a", 15_000, false)])[0]?.amount).toBe(2n); // 1.5 → 2
    const inc = computeLineTax(2997n, [r("v", 190_000, true)])[0];
    expect(inc?.amount).toBe(479n); // 478.5 → 479
    expect(inc?.taxable_amount).toBe(2518n);
    expect(() => computeLineTax(100n, [r("a", 1, true), r("b", 1, false)])).toThrow(/tax_rates_mixed/);
  });

  it("sums rounded line taxes into invoice totals", () => {
    const t = computeInvoiceTotals([
      { amount: 999n, tax_rates: [r("v", 190_000, true)] },
      { amount: 7n, tax_rates: [r("n", 88_750, false)] },
      { amount: 7n, tax_rates: [r("n", 88_750, false)] },
      { amount: 500n, tax_rates: [] },
    ]);
    expect(t.subtotal).toBe(1513n);
    expect(t.tax).toBe(162n);
    expect(t.total).toBe(1515n);
    expect(t.total_excluding_tax).toBe(1353n);
    expect(t.total_tax_amounts.map((x) => [x.tax_rate, x.amount, x.taxable_amount])).toEqual([
      ["v", 160n, 839n],
      ["n", 2n, 14n],
    ]);
  });
});

describe("stage 3 billing: periods", () => {
  const jan31 = Date.UTC(2026, 0, 31, 12) / 1000;
  const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  it("clamps month ends from the anchor without drift", () => {
    expect([0, 1, 2, 3].map((n) => iso(periodBoundary(jan31, "month", 1, n)))).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
    expect(iso(periodBoundary(Date.UTC(2028, 1, 29) / 1000, "year", 1, 1))).toBe("2029-02-28");
    expect(periodBoundary(jan31, "week", 2, 1) - jan31).toBe(14 * 86_400);
    expect(() => periodBoundary(jan31, "day", 0, 1)).toThrow();
  });
});

describe("stage 3 billing: events, webhooks, invoice sessions", () => {
  // stage 4 — autodebit: mandate subjects are Stage 4
  const billingSubjects = Object.keys(SUBJECTS).filter(
    (s) => s.startsWith("evt.billing.") && SUBJECTS[s as keyof typeof SUBJECTS].stage === 3,
  );

  it("publishes invoice and subscription events on EVT_BILLING", () => {
    expect(billingSubjects.length).toBe(13);
    for (const s of billingSubjects) expect(SUBJECTS[s as keyof typeof SUBJECTS].stage, s).toBe(3);
    expect(
      consumerFilters("notify")
        [STREAMS.billing.name]?.filter((x) => !x.startsWith("evt.billing.mandate.")) // stage 4 — autodebit
        .sort(),
    ).toEqual(
      [
        "evt.billing.invoice.paid",
        "evt.billing.invoice.reminder",
        "evt.billing.invoice.sent",
        "evt.billing.invoice.voided",
        "evt.billing.subscription.renewal_upcoming",
      ].sort(),
    );
    expect(consumerFilters("billing")[STREAMS.payments.name]?.sort()).toEqual([
      "evt.payments.checkout_session.expired",
      "evt.payments.payment_intent.expired", // Stage 1 catalogue entry
      "evt.payments.payment_intent.payment_failed",
      "evt.payments.payment_intent.succeeded",
    ]);
  });

  it("maps public types per api-conventions §9 (invoice.*, customer.subscription.*)", () => {
    expect(SUBJECT_TO_WEBHOOK_TYPE["evt.billing.subscription.deleted"]).toBe("customer.subscription.deleted");
    expect(SUBJECT_TO_WEBHOOK_TYPE["evt.billing.invoice.sent"]).toBe("invoice.sent");
    expect(SUBJECT_TO_WEBHOOK_TYPE["evt.billing.invoice.reminder"]).toBeUndefined();
    expect(Object.keys(WEBHOOK_TYPES).filter((t) => t.startsWith("invoice.")).length).toBe(8);
  });

  it("never carries the hosted invoice URL on the bus", () => {
    const shape = (InvoiceEvent as unknown as z.ZodObject<{ hosted_invoice_url: z.ZodType }>).shape;
    expect(shape.hosted_invoice_url.safeParse("https://pay.nearpay.money/i/in_x#in_x_secret_y").success).toBe(false);
    expect(shape.hosted_invoice_url.safeParse(null).success).toBe(true);
    expect("customer_email" in Invoice.shape).toBe(false);
  });

  it("links intents and sessions to invoices (optional for older servers)", () => {
    expect(PaymentIntent.shape.invoice.safeParse(undefined).success).toBe(true);
    expect(PaymentIntent.shape.invoice.safeParse(exampleId("in")).success).toBe(true);
    expect(CheckoutSession.shape.invoice.safeParse(null).success).toBe(true);
  });

  it("lets billing open, read and expire invoice sessions with its own scopes", () => {
    const held = SERVICE_CLIENT_SCOPES.billing;
    for (const id of [
      "createInvoiceCheckoutSession",
      "getInternalCheckoutSession",
      "expireInvoiceCheckoutSession",
      "getInternalCustomer",
      "getSettlementContext",
      "getInternalAsset",
    ]) {
      const rt = INTERNAL_ROUTES.find((x) => x.id === id);
      expect(rt, id).toBeDefined();
      expect(
        rt?.auth.some((a) => a.startsWith("service:") && (held as readonly string[]).includes(a.slice(8))),
        id,
      ).toBe(true);
    }
    expect(createInvoiceCheckoutSession.idempotent).toBe(true);
    const body = {
      account_id: exampleId("acct"),
      livemode: false,
      invoice: exampleId("in"),
      amount: 5000,
      currency: "usd",
      customer: exampleId("cus"),
      description: "Invoice ACME01T-00001",
      success_url: "https://pay.nearpay.money/i/in_x",
      expires_at: "2026-12-01T00:00:00.000Z",
    };
    expect(ok(createInvoiceCheckoutSession.body, body)).toBe(true);
    expect(ok(createInvoiceCheckoutSession.body, { ...body, amount: "5000" })).toBe(false);
  });

  it("names a context route for every billing email template", () => {
    for (const [tpl, def] of Object.entries(BILLING_EMAIL_TEMPLATES)) {
      expect(SUBJECTS[def.subject].consumers, tpl).toContain("notify");
      expect(
        INTERNAL_ROUTES.some((x) => x.id === def.context && x.auth.includes("service:billing.read")),
        tpl,
      ).toBe(true);
    }
  });
});
