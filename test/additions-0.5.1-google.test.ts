/** Additive contract changes of spec 0.5.1: Continue with Google (ADR-0026, lld/identity.md §22). */
import { describe, expect, it } from "vitest";
import { SUBJECTS, UserSignInMethodEvent } from "../src/internal-entry.js";
import {
  AuthMethods,
  DashboardSession,
  ERRORS,
  exampleId,
  GOOGLE_CALLBACK_DASHBOARD_PATH,
  GOOGLE_FLOW_COOKIE,
  GOOGLE_FLOW_TTL_SECONDS,
  GOOGLE_SIGNIN_ERRORS,
  GoogleAuthorization,
  GoogleSignInError,
  getAuthMethods,
  googleCallback,
  LinkedIdentity,
  listLinkedIdentities,
  PASSKEY_SETUP_WINDOW_SECONDS,
  PUBLIC_ANONYMOUS_ROUTES,
  passkeyRegistrationOptions,
  passkeyRegistrationVerify,
  route,
  SPEC_VERSION,
  startGoogleLink,
  startGoogleSignIn,
  stepUpOptions,
  unlinkIdentity,
  z,
} from "../src/public-entry.js";

const parse = (s: unknown, v: unknown) => (s as z.ZodType).safeParse(v).success;

describe("spec 0.5.1: Google routes", () => {
  it("version (0.5.1 or later)", () =>
    expect(SPEC_VERSION.localeCompare("0.5.1", undefined, { numeric: true })).toBeGreaterThanOrEqual(0));

  it("anonymous: methods, start and Google's callback; nothing else of the Google set", () => {
    const anon = (m: string, p: string) => PUBLIC_ANONYMOUS_ROUTES.some((r) => r.method === m && r.path === p);
    expect(anon("GET", "/v1/auth/methods")).toBe(true);
    expect(anon("POST", "/v1/auth/google/start")).toBe(true);
    expect(anon("GET", "/v1/auth/google/callback")).toBe(true);
    expect(anon("POST", "/v1/auth/google/link")).toBe(false);
    expect(anon("GET", "/v1/auth/linked_identities")).toBe(false);
    expect(anon("DELETE", "/v1/auth/linked_identities/{provider}")).toBe(false);
  });

  it("link and unlink need a stepped-up session; listing needs a session", () => {
    for (const r of [startGoogleLink, unlinkIdentity]) expect(r).toMatchObject({ auth: ["session"], stepUp: true });
    expect(listLinkedIdentities.auth).toEqual(["session"]);
    expect(listLinkedIdentities.stepUp).toBeUndefined();
    expect(getAuthMethods.service).toBe("identity");
  });

  it("the callback is a GET redirect (303) with Location and Set-Cookie, never JSON", () => {
    expect(googleCallback).toMatchObject({ method: "GET", status: 303, response: null });
    const h = googleCallback.responseHeaders as z.ZodObject;
    expect(Object.keys(h.shape)).toEqual(["location", "set-cookie"]);
  });

  it("the callback ignores parameters Google adds (scope, authuser, prompt, hd, iss)", () => {
    const q = googleCallback.query as z.ZodType;
    const ok = q.safeParse({ code: "4/0Ab", state: "s".repeat(43), scope: "openid email", authuser: "0", hd: "x.com" });
    expect(ok.success).toBe(true);
    expect(q.safeParse({ error: "access_denied", state: "s" }).success).toBe(true);
    expect(q.safeParse({ code: "" }).success).toBe(false);
  });

  it("start accepts an intent and a same-origin next path only", () => {
    const b = startGoogleSignIn.body as z.ZodType;
    expect(b.safeParse({}).success).toBe(true);
    expect(b.safeParse({ intent: "signup", next: "/payments?status=succeeded" }).success).toBe(true);
    for (const next of ["//evil.example", "https://evil.example", "/\\evil", "payments", "/a b"])
      expect(b.safeParse({ next }).success, next).toBe(false);
    expect(b.safeParse({ intent: "link" }).success).toBe(false);
    expect(b.safeParse({ extra: 1 }).success).toBe(false);
  });

  it("unlink takes the provider as a closed path parameter", () => {
    const p = unlinkIdentity.params as z.ZodType;
    expect(p.safeParse({ provider: "google" }).success).toBe(true);
    expect(p.safeParse({ provider: "github" }).success).toBe(false);
  });

  it("a 303 route must be a bodyless GET with headers", () => {
    const base = {
      id: "x",
      method: "GET" as const,
      path: "/v1/x",
      service: "identity" as const,
      visibility: "public" as const,
      summary: "x",
      auth: ["anonymous" as const],
      idempotent: false,
      response: null,
      status: 303 as const,
      errors: [],
      stage: 4 as const,
    };
    expect(() => route(base)).toThrow(/303/);
    expect(() => route({ ...base, responseHeaders: z.object({ location: z.string() }) })).not.toThrow();
    expect(() =>
      route({ ...base, method: "POST", responseHeaders: z.object({ location: z.string() }), body: z.object({}) }),
    ).toThrow(/303/);
  });
});

describe("spec 0.5.1: objects", () => {
  it("AuthMethods, GoogleAuthorization, LinkedIdentity", () => {
    expect(parse(AuthMethods, { object: "auth_methods", passkey: true, google: false })).toBe(true);
    expect(parse(AuthMethods, { object: "auth_methods", passkey: false, google: true })).toBe(false);
    expect(
      parse(GoogleAuthorization, {
        object: "google_authorization",
        authorization_url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
        expires_at: 1_800_000_000,
      }),
    ).toBe(true);
    expect(parse(LinkedIdentity, { object: "linked_identity", provider: "google", email: "a@b.co", created: 1 })).toBe(
      true,
    );
  });

  it("DashboardSession.sign_in is optional and describes the method", () => {
    const s = {
      object: "dashboard_session",
      user: { id: exampleId("usr"), email: "a@b.co" },
      account: { id: exampleId("acct"), display_name: "A" },
      role: "owner",
      csrf_token: "c".repeat(43),
      expires_at: 1_800_000_000,
    };
    expect(parse(DashboardSession, s)).toBe(true);
    const signIn = { method: "google", passkeys: 0, google_linked: true, passkey_setup_until: 1_800_000_000 };
    expect(parse(DashboardSession, { ...s, sign_in: signIn })).toBe(true);
    expect(parse(DashboardSession, { ...s, sign_in: { ...signIn, passkeys: -1 } })).toBe(false);
  });

  it("GoogleSignInError is open and lists the refusal for an unlinked existing email", () => {
    expect(GOOGLE_SIGNIN_ERRORS).toContain("email_exists");
    expect(GoogleSignInError.safeParse("state_invalid").success).toBe(true);
    expect(GOOGLE_FLOW_COOKIE).toMatch(/^__Host-/);
    expect(GOOGLE_FLOW_TTL_SECONDS).toBe(600);
    expect(PASSKEY_SETUP_WINDOW_SECONDS).toBe(600);
    expect(GOOGLE_CALLBACK_DASHBOARD_PATH).toBe("/api/auth/google/callback");
  });
});

describe("spec 0.5.1: errors", () => {
  it("new codes with their statuses", () => {
    expect(ERRORS.google_signin_disabled).toMatchObject({ status: 404, since: "0.5.1" });
    expect(ERRORS.google_already_linked).toMatchObject({ status: 409, type: "state_conflict", since: "0.5.1" });
    expect(ERRORS.passkey_required).toMatchObject({ status: 403, type: "permission_error", since: "0.5.1" });
    expect(ERRORS.reauthentication_required).toMatchObject({ status: 401, since: "0.5.1" });
  });

  it("existing routes list them", () => {
    expect(stepUpOptions.errors).toContain("passkey_required");
    expect(passkeyRegistrationOptions.errors).toContain("reauthentication_required");
    expect(passkeyRegistrationVerify.errors).toContain("reauthentication_required");
    expect(startGoogleSignIn.errors).toEqual(["google_signin_disabled"]);
    expect(startGoogleLink.errors).toEqual(["google_signin_disabled", "google_already_linked"]);
    expect(unlinkIdentity.errors).toEqual(["passkey_required"]);
  });
});

describe("spec 0.5.1: events", () => {
  it("google_linked / google_unlinked carry ids only", () => {
    for (const s of ["evt.identity.user.google_linked", "evt.identity.user.google_unlinked"] as const)
      expect(SUBJECTS[s]).toMatchObject({
        producer: "identity",
        consumers: ["notify"],
        aggregate: "user_sign_in_methods",
      });
    const ok = {
      user_id: exampleId("usr"),
      provider: "google",
      account_ids: [exampleId("acct")],
      occurred_at: "2026-11-11T10:00:00Z",
    };
    expect(UserSignInMethodEvent.safeParse(ok).success).toBe(true);
    expect(Object.keys(UserSignInMethodEvent.shape)).not.toContain("email");
  });
});
