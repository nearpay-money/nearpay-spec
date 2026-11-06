/** Additive contract changes of spec 0.1.5 (change requests CR-15-01…CR-15-13). */
import { describe, expect, it } from "vitest";
import { CheckoutSessionEvent } from "../src/internal-entry.js";
import {
  AgentPayment,
  CheckoutSession,
  challengeSettlementDestination,
  createSettlementDestination,
  createWebhookEndpoint,
  DashboardSession,
  exampleId,
  getDashboardSession,
  IntentsTransferExtra,
  listWebhookEndpointDeliveries,
  logout,
  PUBLIC_ROUTES,
  PublicCheckoutSession,
  SettlementDestination,
  SettleResponse,
  updateWebhookEndpoint,
  WebhookDelivery,
} from "../src/public-entry.js";

describe("spec 0.1.5 additions", () => {
  it("PublicCheckoutSession carries the payment intent id (required)", () => {
    expect(PublicCheckoutSession.shape.payment_intent.safeParse(exampleId("pi")).success).toBe(true);
    expect(PublicCheckoutSession.shape.payment_intent.safeParse(exampleId("cs")).success).toBe(false);
    expect(PublicCheckoutSession.shape.payment_intent.safeParse(undefined).success).toBe(false);
  });

  it("SettleResponse.replayed and requirement extra.deadline are optional", () => {
    const settle = { success: true, transaction: "", network: "near:mainnet" };
    expect(SettleResponse.safeParse(settle).success).toBe(true);
    expect(SettleResponse.safeParse({ ...settle, replayed: true }).success).toBe(true);
    expect(SettleResponse.safeParse({ ...settle, replayed: "yes" }).success).toBe(false);
    const deadline = IntentsTransferExtra.shape.deadline;
    expect(deadline.safeParse(undefined).success).toBe(true);
    expect(deadline.safeParse("2026-11-07T10:00:00.000Z").success).toBe(true);
    expect(deadline.safeParse(1793873400).success).toBe(false);
  });

  it("enabled_events requests accept any type string and `*`; responses stay string lists", () => {
    const cases = [
      [
        createWebhookEndpoint,
        (e: unknown) => createWebhookEndpoint.body?.safeParse({ url: "https://m.example/h", enabled_events: e }),
      ],
      [updateWebhookEndpoint, (e: unknown) => updateWebhookEndpoint.body?.safeParse({ enabled_events: e })],
    ] as const;
    for (const [r, parse] of cases) {
      expect(parse(["*"])?.success, r.id).toBe(true);
      expect(parse(["payment_intent.succeeded", "invoice.paid"])?.success, r.id).toBe(true);
      expect(parse([""])?.success, r.id).toBe(false);
      expect(parse([])?.success, r.id).toBe(false);
      expect(parse(["x".repeat(101)])?.success, r.id).toBe(false);
      expect(r.errors, r.id).toContain("event_type_unknown");
    }
  });

  it("sequence is optional on CheckoutSession and AgentPayment, including the bus objects", () => {
    for (const s of [CheckoutSession, CheckoutSessionEvent, AgentPayment]) {
      const seq = s.shape.sequence;
      expect(seq.safeParse(undefined).success).toBe(true);
      expect(seq.safeParse(0).success).toBe(true);
      expect(seq.safeParse(7).success).toBe(true);
      expect(seq.safeParse(-1).success).toBe(false);
      expect(seq.safeParse(1.5).success).toBe(false);
    }
  });

  it("GET /v1/auth/session returns the DashboardSession like the other session auth routes", () => {
    expect(getDashboardSession).toMatchObject({
      method: "GET",
      path: "/v1/auth/session",
      service: "identity",
      auth: logout.auth,
      stage: 1,
      response: DashboardSession,
    });
    expect(getDashboardSession.roles).toBeUndefined();
    expect(getDashboardSession.stepUp).toBeUndefined();
  });

  it("deliveries are a cursor list on the endpoint, with endpoint read auth", () => {
    expect(listWebhookEndpointDeliveries).toMatchObject({
      method: "GET",
      path: "/v1/webhook_endpoints/{id}/deliveries",
      service: "webhooks",
      stage: 1,
    });
    const getEndpoint = PUBLIC_ROUTES.find((r) => r.id === "getWebhookEndpoint");
    expect(listWebhookEndpointDeliveries.auth).toEqual(getEndpoint?.auth);
    expect(listWebhookEndpointDeliveries.roles).toEqual(getEndpoint?.roles);
    const d = {
      id: exampleId("whd"),
      object: "webhook_delivery",
      created: 1793873400,
      livemode: false,
      webhook_endpoint: exampleId("we"),
      event: exampleId("evt"),
      event_type: "payment_intent.succeeded",
      status: "failed",
      attempts: 2,
      last_status_code: null,
      last_error: "timeout after 10000 ms",
      next_attempt_at: 1793875200,
      succeeded_at: null,
    };
    expect(WebhookDelivery.safeParse(d).success).toBe(true);
    expect(
      listWebhookEndpointDeliveries.response.safeParse({
        object: "list",
        data: [d],
        has_more: false,
        url: "/v1/webhook_endpoints/we_x/deliveries",
      }).success,
    ).toBe(true);
  });

  it("re-issuing an attestation challenge has the money-route semantics of create", () => {
    expect(challengeSettlementDestination).toMatchObject({
      method: "POST",
      path: "/v1/settlement_destinations/{id}/challenge",
      service: "identity",
      auth: createSettlementDestination.auth,
      roles: createSettlementDestination.roles,
      stepUp: true,
      idempotent: true,
      response: SettlementDestination,
      stage: 1,
    });
    expect(challengeSettlementDestination.errors).toContain("state_conflict");
  });
});
