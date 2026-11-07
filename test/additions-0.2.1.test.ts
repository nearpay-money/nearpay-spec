/** Additive contract changes of spec 0.2.1 (Stage 2 builders' change requests). */
import { describe, expect, it } from "vitest";
import {
  ComplianceCase,
  EndpointSecretRotatedEvent,
  Execution,
  getInternalOpsOperator,
  getKillSwitch,
  INTERNAL_ROUTES,
  KillSwitchState,
  OpsActionEvent,
  OpsAuditFinding,
  ReconciliationRun,
  ReconciliationTotals,
  RefundTransfer,
  SUBJECTS,
  UserRecoveredEvent,
} from "../src/internal-entry.js";
import {
  Account,
  AgentPayment,
  Attestation,
  Customer,
  DepositInstructions,
  EventDataObject,
  exampleId,
  Member,
  PayerAttempt,
  PaymentAttemptSummary,
  PaymentLink,
  PUBLIC_ROUTES,
  PublicCheckoutSession,
  PublicPaymentLink,
  SERVICE_CLIENT_SCOPES,
  SERVICE_SCOPES,
  SettlementDestination,
} from "../src/public-entry.js";

const ALL_ROUTES = [...PUBLIC_ROUTES, ...INTERNAL_ROUTES];
const byId = (id: string) => {
  const r = ALL_ROUTES.find((x) => x.id === id);
  if (!r) throw new Error(`route ${id} missing`);
  return r;
};
const T = "2026-11-08T10:00:00.000Z";
const shape = (s: unknown) => (s as { shape: Record<string, unknown> }).shape;

describe("spec 0.2.1: kill-switch state for services", () => {
  it("serves GET /internal/kill-switch to payments, rails and agentpay service tokens", () => {
    expect(getKillSwitch).toMatchObject({
      method: "GET",
      path: "/internal/kill-switch",
      service: "sentinel",
      visibility: "internal",
      response: KillSwitchState,
    });
    expect(getKillSwitch.auth).toEqual(["service:sentinel.read"]);
    expect(SERVICE_SCOPES).toContain("sentinel.read");
    for (const svc of ["payments", "rails", "agentpay"] as const) {
      expect(SERVICE_CLIENT_SCOPES[svc], svc).toContain("sentinel.read");
    }
    // the ops CLI route on the same path stays
    expect(byId("setKillSwitch")).toMatchObject({ method: "POST", path: "/internal/kill-switch" });
  });

  it("carries the switch version and keeps the 0.2.0 shape valid", () => {
    const base = { engaged: true, reason: "drill", actor: "sentinel", updated_at: T };
    expect(KillSwitchState.safeParse(base).success).toBe(true);
    expect(KillSwitchState.safeParse({ ...base, version: 7 }).success).toBe(true);
  });
});

describe("spec 0.2.1: rails", () => {
  it("lets payments abandon an orphaned refund leg", () => {
    const r = byId("abandonExecution");
    expect(r).toMatchObject({ method: "POST", path: "/internal/executions/{id}/abandon", service: "rails" });
    expect(r.auth).toEqual(["service:rails.executions.write"]);
    expect(SERVICE_CLIENT_SCOPES.payments).toContain("rails.executions.write");
    expect(r.errors).toEqual(["state_conflict"]);
    expect(r.body?.safeParse({ reason: "execution_mismatch" }).success).toBe(true);
    expect(r.body?.safeParse({}).success).toBe(false);
  });

  it("declares the FX codes on createRefundExecution", () => {
    expect(byId("createRefundExecution").errors).toEqual(
      expect.arrayContaining(["fx_rate_unavailable", "currency_unsupported"]),
    );
  });

  it("adds optional observed fee, deposited amount, abandonment and decimals to Execution", () => {
    const s = shape(Execution);
    for (const k of ["observed_fee", "deposited_amount", "abandoned_at", "abandon_reason"]) {
      expect(s[k], k).toBeDefined();
      expect((s[k] as { safeParse: (v: unknown) => { success: boolean } }).safeParse(undefined).success, k).toBe(true);
    }
    const fee = s.observed_fee as { safeParse: (v: unknown) => { success: boolean } };
    expect(fee.safeParse(null).success).toBe(true);
    expect(fee.safeParse({ amount: "1200", asset_id: "nep141:usdc.near" }).success).toBe(true);
    const origin = s.origin as { shape: Record<string, { safeParse: (v: unknown) => { success: boolean } }> };
    expect(origin.shape.decimals?.safeParse(6).success).toBe(true);
    expect(origin.shape.decimals?.safeParse(undefined).success).toBe(true);
    expect(shape(ReconciliationTotals).decimals).toBeDefined();
  });

  it("issues the refund-leg nonce", () => {
    const leg = {
      signer_id: "merchant.near",
      receiver_id: "payer.near",
      token: "nep141:usdc.near",
      amount: "100",
      memo: `np1:${"1".repeat(43)}`,
      deadline: T,
    };
    expect(RefundTransfer.safeParse(leg).success).toBe(true);
    expect(RefundTransfer.safeParse({ ...leg, nonce: `${"A".repeat(43)}=` }).success).toBe(true);
  });

  it("lets rails bypass the screening cache", () => {
    const body = byId("createScreening").body;
    const req = { subject_type: "address", subject: "0xabc", context: "refund", livemode: true };
    expect(body?.safeParse(req).success).toBe(true);
    expect(body?.safeParse({ ...req, fresh: true }).success).toBe(true);
  });
});

describe("spec 0.2.1: error lists", () => {
  it("declares codes services already return", () => {
    expect(byId("relaySignedIntent").errors).toContain("signed_intent_mismatch");
    for (const id of ["createInvitation", "updateMember", "removeMember", "approveSettlementDestination"]) {
      expect(byId(id).errors, id).toContain("recovery_lock");
    }
  });
});

describe("spec 0.2.1: events", () => {
  const action = {
    id: "0190f5a2-7b1c-7d3e-8f00-123456789abc",
    action: "kill_switch.engaged",
    target: { type: "kill_switch", id: "global" },
    account_id: null,
    approval: null,
    occurred_at: T,
  };

  it("accepts ops CLI actors on operator actions", () => {
    expect(OpsActionEvent.safeParse({ ...action, actor: { sub: exampleId("usr"), ops_role: "ops" } }).success).toBe(
      true,
    );
    expect(OpsActionEvent.safeParse({ ...action, actor: { sub: "cli@ops-host-1" } }).success).toBe(true);
    expect(OpsActionEvent.safeParse({ ...action, actor: { sub: "cli@ops-host-1:alice" } }).success).toBe(true);
    expect(OpsActionEvent.safeParse({ ...action, actor: { sub: "alice" } }).success).toBe(false);
  });

  it("adds recovery and secret-rotation subjects for notify", () => {
    expect(SUBJECTS["evt.identity.user.recovered"]).toMatchObject({
      object: UserRecoveredEvent,
      producer: "identity",
      consumers: ["notify"],
      aggregate: "user",
    });
    expect(SUBJECTS["evt.webhooks.endpoint.secret_rotated"]).toMatchObject({
      object: EndpointSecretRotatedEvent,
      producer: "webhooks",
      consumers: ["notify"],
    });
  });

  it("feeds account display names to compliance and sentinel", () => {
    expect(SUBJECTS["evt.identity.account.updated"].consumers).toEqual(
      expect.arrayContaining(["compliance", "sentinel", "payments", "webhooks"]),
    );
    expect(SUBJECTS["evt.identity.account.created"].consumers).toEqual(
      expect.arrayContaining(["compliance", "sentinel", "notify"]),
    );
    for (const o of [ComplianceCase, ReconciliationRun, OpsAuditFinding]) {
      expect(shape(o).account_display_name).toBeDefined();
    }
  });

  it("types refunds, accounts and reviews as event data objects", () => {
    expect(EventDataObject.safeParse({ object: "ping", webhook_endpoint: exampleId("we") }).success).toBe(true);
    expect(EventDataObject.safeParse({ object: "nothing" }).success).toBe(false);
  });
});

describe("spec 0.2.1: identity, notify and compliance", () => {
  it("adds the console-operator read and the recipients user filter", () => {
    expect(getInternalOpsOperator).toMatchObject({ method: "GET", path: "/internal/ops_operators/{id}" });
    expect(getInternalOpsOperator.auth).toEqual(["service:identity.operators.read"]);
    expect(SERVICE_CLIENT_SCOPES.compliance).toContain("identity.operators.read");
    const q = byId("getNotificationRecipients").query;
    expect(q?.safeParse({ kind: "security" }).success).toBe(true);
    expect(q?.safeParse({ kind: "security", user: exampleId("usr") }).success).toBe(true);
  });

  it("adds a subject filter to the case queue", () => {
    const q = byId("listOpsCases").query;
    expect(q?.safeParse({ subject: exampleId("ex") }).success).toBe(true);
  });

  it("adds optional account, destination and member fields", () => {
    expect(shape(Account).website).toBeDefined();
    const sd = shape(SettlementDestination);
    expect(sd.created_by).toBeDefined();
    const reason = sd.disabled_reason as { safeParse: (v: unknown) => { success: boolean } };
    expect(reason.safeParse("expired").success).toBe(true);
    expect(shape(Member).security).toBeDefined();
    const body = byId("updateAccount").body;
    expect(
      body?.safeParse({ website: "https://shop.example", settings: { branding: { theme: "dark", corner_radius: 8 } } })
        .success,
    ).toBe(true);
    expect(body?.safeParse({ settings: { branding: { corner_radius: 99 } } }).success).toBe(false);
  });
});

describe("spec 0.2.1: payments and payer data", () => {
  it("adds optional payer-side display data", () => {
    expect(shape(DepositInstructions).fee_amount).toBeDefined();
    expect(shape(PayerAttempt).amount_received).toBeDefined();
    expect(shape(PublicCheckoutSession).pricing_asset).toBeDefined();
    expect(shape(PublicPaymentLink).pricing_asset).toBeDefined();
    expect(shape(PaymentAttemptSummary).refund_to).toBeDefined();
    expect(shape(PaymentAttemptSummary).origin_amount).toBeDefined();
    expect(shape(Customer).total_paid).toBeDefined();
    expect(shape(Customer).last_payment_at).toBeDefined();
    expect(shape(PaymentLink).name).toBeDefined();
    expect(shape(AgentPayment).refund).toBeDefined();
    const asset = (shape(Attestation).asset as { unwrap: () => unknown }).unwrap();
    expect(shape(asset).token).toBeDefined();
  });

  it("accepts a payment link name on create and update", () => {
    const create = byId("createPaymentLink").body;
    expect(create?.safeParse({ amount: 1000, currency: "usd", description: "Tee", name: "Summer tee" }).success).toBe(
      true,
    );
    expect(byId("updatePaymentLink").body?.safeParse({ name: null }).success).toBe(true);
  });

  it("keeps every new field optional on responses", () => {
    // each object still parses without its 0.2.1 fields (older servers stay valid)
    const ks = { engaged: false, reason: "", actor: "sentinel", updated_at: T };
    expect(KillSwitchState.safeParse(ks).success).toBe(true);
    for (const [o, keys] of [
      [Customer, ["total_paid", "last_payment_at"]],
      [PaymentLink, ["name"]],
      [AgentPayment, ["refund"]],
      [Account, ["website"]],
      [SettlementDestination, ["created_by"]],
      [Member, ["security"]],
    ] as const) {
      for (const k of keys) {
        const f = shape(o)[k] as { safeParse: (v: unknown) => { success: boolean } };
        expect(f.safeParse(undefined).success, k).toBe(true);
      }
    }
  });
});
