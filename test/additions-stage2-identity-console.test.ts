/** Stage 2 step 2.1 contracts — identity, compliance (self-declared KYB), console, webhooks, notify, sentinel. */
import { describe, expect, it } from "vitest";
import {
  approveOpsKillSwitchRelease,
  approveOpsSuspensionRequest,
  decideKyb,
  INTERNAL_ROUTES,
  KybDecisionEvent,
  OPS_ANONYMOUS_ROUTES,
  OPS_ROUTES,
  OpsApproval,
  removeOpsBlocklistEntry,
  SUBJECTS,
  sendMessage,
  setKillSwitch,
} from "../src/internal-entry.js";
import {
  approveSettlementDestination,
  createApiKey,
  ERRORS,
  exampleId,
  ID_PREFIXES,
  InternalTokenClaims,
  KybCase,
  OPS_ROLE_SCOPES,
  OPS_ROLES,
  OPS_SCOPES,
  PUBLIC_ROUTES,
  route,
  SUBJECT_TO_WEBHOOK_TYPE,
  startKyb,
  submitKyb,
  updateKybProfile,
  WEBHOOK_TYPES,
  WebhookEndpoint,
  type z,
} from "../src/public-entry.js";

const byId = (id: string) => [...PUBLIC_ROUTES, ...INTERNAL_ROUTES].find((r) => r.id === id);

describe("console (ops) routes", () => {
  it("live under /ops/, admit only ops principals (or anonymous sign-in) and declare ops roles", () => {
    expect(OPS_ROUTES.length).toBeGreaterThan(30);
    for (const r of OPS_ROUTES) {
      expect(r.visibility, r.id).toBe("ops");
      expect(r.path.startsWith("/ops/"), r.id).toBe(true);
      expect(r.roles, r.id).toBeUndefined();
      const anon = r.auth.includes("anonymous");
      if (anon) {
        expect(r.auth, r.id).toEqual(["anonymous"]);
        expect(r.path.startsWith("/ops/auth/"), r.id).toBe(true);
      } else {
        expect(
          r.auth.every((a) => a.startsWith("ops:")),
          r.id,
        ).toBe(true);
        expect(r.opsRoles?.length, r.id).toBeGreaterThan(0);
        for (const role of r.opsRoles ?? []) {
          expect(OPS_ROLES, r.id).toContain(role);
          for (const a of r.auth) expect(OPS_ROLE_SCOPES[role], `${r.id} ${role}`).toContain(a.slice(4));
        }
      }
      // every console write is retry-safe after a step-up replay
      if (r.method === "POST" && !anon && !r.path.startsWith("/ops/auth/")) expect(r.idempotent, r.id).toBe(true);
    }
    // services mount them from INTERNAL_ROUTES; none leaks into the public table
    for (const r of OPS_ROUTES) expect(INTERNAL_ROUTES).toContain(r);
    expect(PUBLIC_ROUTES.some((r) => r.path.startsWith("/ops/"))).toBe(false);
  });

  it("uses only declared ops scopes, and every ops scope is checked somewhere", () => {
    const used = new Set(
      INTERNAL_ROUTES.flatMap((r) => r.auth.filter((a) => a.startsWith("ops:")).map((a) => a.slice(4))),
    );
    for (const s of used) expect(OPS_SCOPES as readonly string[]).toContain(s);
    for (const s of OPS_SCOPES) expect(used, s).toContain(s);
  });

  it("anonymous console routes are exactly enrolment and passkey sign-in", () => {
    expect(OPS_ANONYMOUS_ROUTES.map((r) => r.path).sort()).toEqual([
      "/ops/auth/enrolment/verify",
      "/ops/auth/passkeys/authentication/options",
      "/ops/auth/passkeys/authentication/verify",
      "/ops/auth/passkeys/registration/options",
      "/ops/auth/passkeys/registration/verify",
    ]);
  });

  it("two-person approvals are ops_admin-only, step-up, and declare approver_conflict", () => {
    for (const r of [approveOpsSuspensionRequest, approveOpsKillSwitchRelease]) {
      expect(r.opsRoles, r.id).toEqual(["ops_admin"]);
      expect(r.stepUp, r.id).toBe(true);
      expect(r.errors, r.id).toContain("approver_conflict");
    }
    expect(removeOpsBlocklistEntry.opsRoles).toEqual(["ops_admin"]);
    expect(setKillSwitch.errors).toContain("two_person_required");
    expect(setKillSwitch.opsRoles).toEqual(["ops", "ops_admin"]);
    expect(decideKyb.opsRoles).toEqual(["ops", "ops_admin"]);
    const approval = {
      id: exampleId("opa"),
      object: "ops_approval",
      action: "kill_switch.release",
      target: { type: "kill_switch", id: exampleId("ks") },
      reason: "provider incident resolved",
      status: "pending",
      requested_by: { id: exampleId("usr"), role: "ops" },
      requested_at: 1793873400,
      decided_by: null,
      decided_at: null,
      decision_note: null,
      expires_at: 1793877000,
    };
    expect(OpsApproval.safeParse(approval).success).toBe(true);
  });

  it("route() refuses inconsistent ops definitions", () => {
    const base = {
      method: "GET",
      service: "identity",
      visibility: "ops",
      summary: "s",
      idempotent: false,
      response: null,
      status: 200,
      errors: [],
      stage: 2,
    } as const;
    expect(() =>
      route({ ...base, id: "o1", path: "/internal/x", auth: ["ops:console.session"], opsRoles: ["ops"] }),
    ).toThrow(/ops paths/);
    expect(() => route({ ...base, id: "o2", path: "/ops/x", auth: ["session"] })).toThrow(/ops principals/);
    expect(() => route({ ...base, id: "o3", path: "/ops/x", auth: ["ops:console.session"] })).toThrow(/opsRoles/);
    expect(() => route({ ...base, id: "o4", path: "/ops/x", auth: ["anonymous"] })).toThrow(/\/ops\/auth\//);
    expect(() =>
      route({ ...base, id: "o5", visibility: "public", path: "/v1/x", auth: ["secret_key"], opsRoles: ["ops"] }),
    ).toThrow(/opsRoles need/);
  });

  it("the internal token carries the operator role", () => {
    const claims = {
      iss: "nearpay-identity",
      aud: "nearpay",
      sub: exampleId("usr"),
      ptype: "ops",
      scp: ["console.session"],
      ops_role: "ops_admin",
      iat: 1,
      exp: 61,
    };
    expect(InternalTokenClaims.safeParse(claims).success).toBe(true);
    expect(InternalTokenClaims.safeParse({ ...claims, ops_role: "owner" }).success).toBe(false);
  });
});

describe("identity stage 2", () => {
  it("restricted keys: `restricted` type with free-form scopes (service answers scope_unknown)", () => {
    const body = createApiKey.body;
    expect(body?.safeParse({ type: "restricted", livemode: false, name: "ro", scopes: ["refunds.read"] }).success).toBe(
      true,
    );
    expect(body?.safeParse({ type: "secret", livemode: false, name: "s" }).success).toBe(true);
    expect(body?.safeParse({ type: "restricted", livemode: false, name: "x", scopes: [] }).success).toBe(false);
    expect(createApiKey.errors).toContain("scope_unknown");
  });

  it("destination approval is a step-up owner/admin route with approver_conflict", () => {
    expect(approveSettlementDestination).toMatchObject({
      path: "/v1/settlement_destinations/{id}/approve",
      roles: ["owner", "admin"],
      stepUp: true,
      idempotent: true,
      stage: 2,
    });
    expect(approveSettlementDestination.errors).toContain("approver_conflict");
  });

  it("team routes require owner/admin and step-up for writes", () => {
    for (const id of ["updateMember", "removeMember", "createInvitation"]) {
      const r = byId(id);
      expect(r?.roles, id).toEqual(["owner", "admin"]);
      expect(r?.stepUp, id).toBe(true);
    }
    expect(byId("startRecovery")?.auth).toEqual(["anonymous"]);
  });

  it("adds the new id prefixes", () => {
    for (const p of ["inv", "aud", "opa", "bl"] as const) expect(ID_PREFIXES[p]).toBeDefined();
  });
});

describe("self-declared KYB", () => {
  it("keeps the Stage 1 routes and status values and adds profile routes", () => {
    expect(startKyb.stage).toBe(1);
    expect(decideKyb.path).toBe("/internal/kyb_cases/{id}/decision");
    expect(updateKybProfile.errors).toContain("state_conflict");
    expect(submitKyb.errors).toEqual(["kyb_profile_incomplete", "state_conflict"]);
    expect(submitKyb.body?.safeParse({ declaration: true }).success).toBe(true);
    expect(submitKyb.body?.safeParse({ declaration: false }).success).toBe(false);
    // a Stage 1 response (no profile) still parses
    expect(KybCase.safeParse({ object: "kyb_case", status: "not_started", vendor_flow_url: null }).success).toBe(true);
    expect(
      KybDecisionEvent.safeParse({ account_id: exampleId("acct"), status: "approved", reason: "ok" }).success,
    ).toBe(true);
  });

  it("emits submitted to identity and notify", () => {
    expect(SUBJECTS["evt.compliance.kyb.submitted"].consumers).toEqual(["identity", "notify"]);
  });
});

describe("webhooks, notify, sentinel stage 2", () => {
  it("adds account and review webhook types fed by their domain subjects", () => {
    for (const t of ["account.updated", "review.opened", "review.closed"] as const) {
      const subject = WEBHOOK_TYPES[t].subject;
      expect(SUBJECT_TO_WEBHOOK_TYPE[subject]).toBe(t);
      expect(SUBJECTS[subject as keyof typeof SUBJECTS].consumers).toContain("webhooks");
    }
  });

  it("rotation and resend are write routes; rotated endpoints expose the overlap", () => {
    for (const id of ["rotateWebhookEndpointSecret", "resendEvent"]) {
      expect(byId(id)?.auth, id).toEqual(byId("createWebhookEndpoint")?.auth);
      expect(byId(id)?.idempotent, id).toBe(true);
    }
    expect(WebhookEndpoint.shape.previous_secret_expires_at.safeParse(undefined).success).toBe(true);
  });

  it("notify accepts the invitation and enrolment templates", () => {
    const body = sendMessage.body as z.ZodType;
    const invite = {
      template: "team.invitation",
      to: "ana@example.com",
      variables: {
        link_url: "https://dashboard.nearpay.money/auth/invite#token=x",
        account_display_name: "Acme",
        role: "developer",
        expires_in_minutes: 10080,
      },
      dedupe_key: exampleId("inv"),
    };
    expect(body.safeParse(invite).success).toBe(true);
    expect(
      body.safeParse({
        template: "ops.enrolment",
        to: "op@nearpay.money",
        variables: { link_url: "https://ops.nearpay.money/auth/enrol#token=x", role: "ops", expires_in_minutes: 1440 },
        dedupe_key: "enrol-1",
      }).success,
    ).toBe(true);
    for (const s of ["evt.identity.member.added", "evt.identity.member.removed", "evt.identity.member.role_changed"])
      expect(SUBJECTS[s as keyof typeof SUBJECTS].consumers).toContain("notify");
  });

  it("new error codes exist with docs-ready examples", () => {
    for (const c of [
      "last_owner",
      "member_exists",
      "invitation_invalid",
      "approver_conflict",
      "two_person_required",
      "authenticator_not_allowed",
      "kyb_profile_incomplete",
    ] as const)
      expect(ERRORS[c].example.length, c).toBeGreaterThan(0);
  });
});
