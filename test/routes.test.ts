/** Route-table integrity (audit gates G4, G8; system audit route/scope matrices). */
import { describe, expect, it } from "vitest";
import { INTERNAL_ROUTES } from "../src/internal-entry.js";
import {
  type AnyRoute,
  buildPath,
  ERRORS,
  GENERIC_ERROR_CODES,
  PUBLIC_ANONYMOUS_ROUTES,
  PUBLIC_ROUTES,
  pathMatcher,
  route,
  SERVICE_CLIENT_SCOPES,
  toFastifyPath,
  z,
} from "../src/public-entry.js";

const ALL: AnyRoute[] = [...PUBLIC_ROUTES, ...INTERNAL_ROUTES];

describe("route tables", () => {
  it("have unique ids and unique method+path", () => {
    const ids = ALL.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = ALL.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("list only route-specific error codes (generic ones apply everywhere)", () => {
    for (const r of ALL) {
      for (const c of r.errors) expect(GENERIC_ERROR_CODES, `${r.id}: ${c}`).not.toContain(c);
      expect(new Set(r.errors).size, r.id).toBe(r.errors.length);
    }
  });

  it("put roles only on session routes and step-up only on session or ops routes", () => {
    for (const r of ALL) {
      if (r.roles) expect(r.auth, r.id).toContain("session");
      // stage 2 — identity-console: console routes take step-up too
      if (r.stepUp) expect(r.auth.includes("session") || r.auth.some((a) => a.startsWith("ops:")), r.id).toBe(true);
    }
  });

  it("require the client-secret header on client-secret routes", () => {
    for (const r of ALL.filter((x) => x.auth.includes("client_secret"))) {
      expect(r.headers instanceof z.ZodObject && "x-nearpay-client-secret" in r.headers.shape, r.id).toBe(true);
      expect(r.errors, r.id).toContain("client_secret_invalid");
    }
  });

  it("make every merchant-key POST idempotent (FR-PAY-08), except the x402 protocol endpoints", () => {
    for (const r of PUBLIC_ROUTES) {
      const keyAuth = r.auth.some((a) => a === "secret_key" || a.startsWith("restricted_key:"));
      if (r.method === "POST" && keyAuth && !r.path.startsWith("/x402/")) expect(r.idempotent, r.id).toBe(true);
    }
  });

  it("mark test-mode-only routes with livemode_forbidden", () => {
    for (const r of ALL.filter((x) => x.testModeOnly)) expect(r.errors, r.id).toContain("livemode_forbidden");
  });

  it("only use service scopes that some service client holds (foundations §9)", () => {
    const held = new Set(Object.values(SERVICE_CLIENT_SCOPES).flat());
    for (const r of INTERNAL_ROUTES) {
      for (const a of r.auth) if (a.startsWith("service:")) expect(held, `${r.id} ${a}`).toContain(a.slice(8));
    }
  });

  it("give every service scope at least one route that checks it", () => {
    const checked = new Set(
      INTERNAL_ROUTES.flatMap((r) => r.auth.filter((a) => a.startsWith("service:")).map((a) => a.slice(8))),
    );
    const unused = Object.values(SERVICE_CLIENT_SCOPES)
      .flat()
      .filter((s) => !checked.has(s));
    // billing.read: billing internal API arrives in Stage 3; payments.sessions.create likewise.
    expect(new Set(unused)).toEqual(new Set(["billing.read", "payments.sessions.create"]));
  });

  it("use HTTP statuses consistent with their error codes", () => {
    for (const r of ALL) for (const c of r.errors) expect(ERRORS[c], `${r.id} ${c}`).toBeDefined();
  });
});

describe("anonymous allow-list (identity §11, system audit S-03)", () => {
  // The LLD list, Stage 1 subset (payment links Stage 2, invoices Stage 3, vendor webhooks Stage 2/5).
  const expected: [string, RegExp][] = [
    ["POST", /^\/v1\/auth\/(signup|magic_links\/verify|passkeys\/.+|recovery)$/],
    ["GET|POST", /^\/v1\/checkout\/sessions\/\{id\}\/public(\/.*)?$/],
    ["POST", /^\/v1\/checkout\/sessions\/\{id\}\/agent_pay(\/.*)?$/],
    ["POST", /^\/v1\/attestations\/deposit_instructions$/],
    ["GET", /^\/v1\/attestations\/keys$/],
    ["GET", /^\/v1\/assets$/],
    ["GET", /^\/x402\/supported$/],
    ["GET", /^\/v1\/webhook_signing_keys$/],
  ];
  it("contains exactly the routes the LLD allows", () => {
    for (const r of PUBLIC_ANONYMOUS_ROUTES) {
      const ok = expected.some(([m, re]) => m.split("|").includes(r.method) && re.test(r.path));
      expect(ok, `${r.method} ${r.path} is anonymous but not in the LLD allow-list`).toBe(true);
    }
    for (const [m, re] of expected) {
      expect(
        PUBLIC_ANONYMOUS_ROUTES.some((r) => m.split("|").includes(r.method) && re.test(r.path)),
        String(re),
      ).toBe(true);
    }
  });
});

describe("route helpers", () => {
  it("build and match paths", () => {
    expect(buildPath({ path: "/v1/checkout/sessions/{id}/public" }, { id: "cs_x" })).toBe(
      "/v1/checkout/sessions/cs_x/public",
    );
    expect(() => buildPath({ path: "/v1/x/{id}" }, {})).toThrow(/missing path param/);
    expect(buildPath({ path: "/internal/assets/{asset_id}" }, { asset_id: "nep141:a.near" })).toBe(
      "/internal/assets/nep141%3Aa.near",
    );
    expect(toFastifyPath("/v1/a/{id}/b/{attempt}")).toBe("/v1/a/:id/b/:attempt");
    expect(pathMatcher("/v1/a/{id}").test("/v1/a/x")).toBe(true);
    expect(pathMatcher("/v1/a/{id}").test("/v1/a/x/y")).toBe(false);
  });

  it("reject inconsistent definitions", () => {
    const base = {
      method: "GET",
      service: "payments",
      visibility: "public",
      summary: "s",
      auth: ["secret_key"],
      idempotent: false,
      response: null,
      status: 200,
      errors: [],
      stage: 1,
    } as const;
    expect(() => route({ ...base, id: "a", path: "/v1/x/{id}" })).toThrow(/path params/);
    expect(() => route({ ...base, id: "b", path: "/v1/x", params: z.strictObject({ id: z.string() }) })).toThrow(
      /path params/,
    );
    expect(() => route({ ...base, id: "c", path: "/v1/x", auth: [] })).toThrow(/auth/);
    expect(() => route({ ...base, id: "d", path: "/internal/x" })).toThrow(/public paths/);
    expect(() => route({ ...base, id: "e", path: "/v1/x", status: 204, response: z.string() })).toThrow(/204/);
    expect(() => route({ ...base, id: "f", path: "/v1/x", body: z.strictObject({}) })).toThrow(/GET/);
    expect(() => route({ ...base, id: "g", path: "/v1/x", visibility: "internal", service: "rails" })).toThrow(
      /internal paths/,
    );
  });
});
