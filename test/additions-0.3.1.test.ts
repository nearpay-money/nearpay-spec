/** Additive contract changes of spec 0.3.1 (Stage 3.2 builders' change requests). */
import { describe, expect, it } from "vitest";
import { INTERNAL_ROUTES, InvoiceNotificationContext, SimTx } from "../src/internal-entry.js";
import { advanceSubscriptionClock, exampleId, PUBLIC_ROUTES, SubscriptionClockAdvance } from "../src/public-entry.js";

const ALL_ROUTES = [...PUBLIC_ROUTES, ...INTERNAL_ROUTES];
const byId = (id: string) => {
  const r = ALL_ROUTES.find((x) => x.id === id);
  if (!r) throw new Error(`route ${id} missing`);
  return r;
};
const shape = (s: unknown) => (s as { shape: Record<string, unknown> }).shape;

describe("spec 0.3.1: getEvidenceSummary owner filter", () => {
  it("accepts an optional owner", () => {
    const q = byId("getEvidenceSummary").query as unknown as { parse(v: unknown): Record<string, unknown> };
    const base = { account_id: exampleId("acct"), livemode: "false", day: "2026-11-08" };
    expect(q.parse(base).owner).toBeUndefined();
    expect(q.parse({ ...base, owner: "payments" }).owner).toBe("payments");
  });
});

describe("spec 0.3.1: sandbox SimTx transfer sender", () => {
  it("accepts transfers with, without and with a null sender", () => {
    const t = { token: "nep141:wrap.near", to: "alice.near", amount: "1" };
    for (const tr of [t, { ...t, from: null }, { ...t, from: "bob.near" }])
      expect(SimTx.safeParse({ finalized: true, transfers: [tr] }).success, JSON.stringify(tr)).toBe(true);
  });
});

describe("spec 0.3.1: error lists", () => {
  it.each([
    [
      "createPublicInvoiceSession",
      ["amount_below_destination_minimum", "amount_above_unverified_cap", "customer_deleted", "state_conflict"],
    ],
    ["createSubscription", ["invoice_empty"]],
    ["createInvoiceCheckoutSession", ["fx_rate_unavailable"]],
    ["createCheckoutSession", ["fx_rate_unavailable"]],
    ["x402NearIntentsRequirements", ["pricing_unavailable"]],
    ["x402Requirements", ["pricing_unavailable"]],
  ])("%s lists %j", (id, codes) => {
    for (const c of codes) expect(byId(id).errors).toContain(c);
  });
});

describe("spec 0.3.1: invoice notification context", () => {
  it("adds optional subtotal, tax, line_count and destination_fingerprint", () => {
    for (const k of ["subtotal", "tax", "line_count", "destination_fingerprint"])
      expect(shape(InvoiceNotificationContext), k).toHaveProperty(k);
    const s = shape(InvoiceNotificationContext) as Record<string, { safeParse(v: unknown): { success: boolean } }>;
    expect(s.line_count?.safeParse(undefined).success).toBe(true);
    expect(s.line_count?.safeParse(-1).success).toBe(false);
    expect(s.destination_fingerprint?.safeParse(null).success).toBe(true);
  });
});

describe("spec 0.3.1: billing clock test helper", () => {
  it("is a test-mode-only billing route for subscriptions.write", () => {
    expect(advanceSubscriptionClock).toMatchObject({
      method: "POST",
      path: "/v1/test_helpers/subscriptions/{id}/advance_clock",
      service: "billing",
      visibility: "public",
      idempotent: true,
      testModeOnly: true,
      response: SubscriptionClockAdvance,
      status: 200,
    });
    expect(advanceSubscriptionClock.auth).toEqual(["secret_key", "restricted_key:subscriptions.write", "session"]);
    expect(advanceSubscriptionClock.roles).toEqual(["owner", "admin", "developer"]);
    expect(advanceSubscriptionClock.errors).toEqual(["livemode_forbidden", "state_conflict"]);
    const body = advanceSubscriptionClock.body as unknown as { safeParse(v: unknown): { success: boolean } };
    expect(body.safeParse({ target: "renewal" }).success).toBe(true);
    expect(body.safeParse({ target: "next_year" }).success).toBe(false);
    expect(body.safeParse({}).success).toBe(false);
  });
});
