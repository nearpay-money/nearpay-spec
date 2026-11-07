/** Stage 2 step 2.1 contracts integration (0.2.0): cross-topic follow-ups and whole-contract checks. */
import { describe, expect, it } from "vitest";
import {
  AggregateType,
  createInternalCase,
  ExecutionRefund,
  INTERNAL_ROUTES,
  OPS_ROUTES,
  OpsActionEvent,
  SUBJECTS,
} from "../src/internal-entry.js";
import {
  ERRORS,
  exampleId,
  ID_PREFIXES,
  OPS_SCOPES,
  PUBLIC_ROUTES,
  SERVICE_CLIENT_SCOPES,
  TokenContract,
} from "../src/public-entry.js";

const ALL_ROUTES = [...PUBLIC_ROUTES, ...INTERNAL_ROUTES];
const byId = (id: string) => ALL_ROUTES.find((r) => r.id === id);

describe("contracts integration: console routes", () => {
  it("serves reconciliation runs and refund reads on the /ops table (payments)", () => {
    const expected: [string, string, string, string, boolean][] = [
      ["listOpsReconciliationRuns", "GET", "/ops/reconciliation_runs", "ops:payments.read", false],
      ["getOpsReconciliationRun", "GET", "/ops/reconciliation_runs/{id}", "ops:payments.read", false],
      ["createOpsReconciliationRun", "POST", "/ops/reconciliation_runs", "ops:payments.reconcile", false],
      [
        "resolveOpsReconciliationRun",
        "POST",
        "/ops/reconciliation_runs/{id}/resolution",
        "ops:payments.reconcile",
        true,
      ],
      ["getOpsRefund", "GET", "/ops/refunds/{id}", "ops:payments.read", false],
    ];
    for (const [id, method, path, auth, stepUp] of expected) {
      const r = byId(id);
      expect(r, id).toBeDefined();
      expect(OPS_ROUTES, id).toContain(r);
      expect(r).toMatchObject({ method, path, service: "payments", visibility: "ops", stage: 2 });
      expect(r?.auth).toEqual([auth]);
      expect(r?.opsRoles).toEqual(["ops", "ops_admin"]);
      expect(Boolean(r?.stepUp), id).toBe(stepUp);
    }
    expect(OPS_SCOPES).toContain("payments.read");
    expect(OPS_SCOPES).toContain("payments.reconcile");
    // no reconciliation route is left on /internal (never routed to the console)
    expect(ALL_ROUTES.some((r) => r.path.startsWith("/internal/reconciliation_runs"))).toBe(false);
    expect(byId("getInternalRefund")?.auth).toEqual(["service:payments.read"]);
  });

  it("gives the executions explorer observations, reverify and mode isolation (rails)", () => {
    const list = byId("listOpsExecutions");
    expect(list?.query?.safeParse({ livemode: "true", state: "held" }).success).toBe(true);
    expect(list?.query?.safeParse({ state: "held" }).success).toBe(false); // INV-8: mode required
    expect(byId("listOpsExecutionObservations")).toMatchObject({
      method: "GET",
      path: "/ops/executions/{id}/observations",
      service: "rails",
      auth: ["ops:rails.read"],
    });
    const reverify = byId("reverifyOpsExecution");
    expect(reverify).toMatchObject({
      method: "POST",
      path: "/ops/executions/{id}/reverify",
      service: "rails",
      auth: ["ops:rails.verify"],
      opsRoles: ["ops", "ops_admin"],
      stepUp: true,
      idempotent: true,
    });
    expect(reverify?.errors).toContain("state_conflict");
    expect(OPS_SCOPES).toContain("rails.verify");
  });

  it("puts every /ops path on the ops table and nothing else there", () => {
    for (const r of ALL_ROUTES) {
      expect(r.path.startsWith("/ops/"), r.id).toBe(r.visibility === "ops");
      if (r.visibility === "ops") expect(OPS_ROUTES, r.id).toContain(r);
    }
  });
});

describe("contracts integration: payments → compliance cases", () => {
  it("lets payments open a reconciliation_diff case", () => {
    expect(createInternalCase).toMatchObject({
      method: "POST",
      path: "/internal/cases",
      service: "compliance",
      visibility: "internal",
      auth: ["service:compliance.cases.write"],
      idempotent: true,
      status: 201,
      stage: 2,
    });
    expect(SERVICE_CLIENT_SCOPES.payments).toContain("compliance.cases.write");
    const body = {
      kind: "reconciliation_diff",
      account_id: exampleId("acct"),
      livemode: true,
      subject: { type: "reconciliation_run", id: exampleId("rcn") },
      note: "1 diff: missing_evidence ×1",
    };
    expect(createInternalCase.body?.safeParse(body).success).toBe(true);
    expect(createInternalCase.body?.safeParse({ ...body, kind: "screening_hit" }).success).toBe(false);
  });
});

describe("contracts integration: unified audit trail", () => {
  it("publishes operator actions from compliance and sentinel to identity, ids only", () => {
    for (const subject of ["evt.compliance.ops_action.recorded", "evt.sentinel.ops_action.recorded"] as const) {
      expect(SUBJECTS[subject]).toMatchObject({ object: OpsActionEvent, consumers: ["identity"], stage: 2 });
    }
    const ok = OpsActionEvent.safeParse({
      id: "0192f0c4-7a3e-7b8c-9d0e-1f2a3b4c5d6e",
      actor: { sub: exampleId("usr"), ops_role: "ops_admin" },
      action: "kill_switch.release_approved",
      target: { type: "kill_switch", id: "global" },
      account_id: null,
      approval: exampleId("opa"),
      occurred_at: "2026-11-07T10:00:00.000Z",
    });
    expect(ok.success).toBe(true);
    const keys = Object.keys(OpsActionEvent.shape);
    for (const k of ["email", "note", "address", "details"]) expect(keys).not.toContain(k);
  });

  it("documents every aggregate kind used on the bus", () => {
    for (const [subject, def] of Object.entries(SUBJECTS)) {
      expect(AggregateType.options, subject).toContain(def.aggregate);
      expect(def.consumers.length, subject).toBeGreaterThan(0);
    }
  });
});

describe("contracts integration: whole-contract consistency", () => {
  it("stamps every Stage 2 error code with 0.2.0", () => {
    const stage2 = [
      "last_owner",
      "member_exists",
      "invitation_invalid",
      "approver_conflict",
      "two_person_required",
      "authenticator_not_allowed",
      "kyb_profile_incomplete",
      "intent_not_succeeded",
      "attempt_not_settled",
      "amount_exceeds_refundable",
      "leg_expired",
      "signed_intent_mismatch",
      "review_requires_evidence",
      "link_inactive",
      "customer_deleted",
      "reconciliation_day_open",
      "fx_rate_unavailable",
    ] as const;
    for (const c of stage2) expect(ERRORS[c].since, c).toBe("0.2.0");
    for (const [c, d] of Object.entries(ERRORS)) expect(d.since, c).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("keeps id prefixes and object names unique", () => {
    const objects = Object.values(ID_PREFIXES).map((p) => p.object);
    expect(new Set(objects).size).toBe(objects.length);
    expect(ID_PREFIXES.rcn.object).toBe("reconciliation_run");
  });

  it("keeps operation ids and method+path pairs unique, and every route authenticated", () => {
    const ids = ALL_ROUTES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = ALL_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of ALL_ROUTES) expect(r.auth.length, r.id).toBeGreaterThan(0);
  });

  it("describes refund-leg tokens with the shared TokenContract", () => {
    expect(ExecutionRefund.shape.token.unwrap()).toBe(TokenContract);
  });
});
