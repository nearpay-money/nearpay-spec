/** Error catalogue integrity (api-conventions §6). */
import { describe, expect, it } from "vitest";
import { INTERNAL_ROUTES } from "../src/internal-entry.js";
import {
  ERROR_CODES,
  ERRORS,
  ErrorEnvelope,
  errorDocUrl,
  PUBLIC_ROUTES,
  renderErrorMessage,
} from "../src/public-entry.js";

const TYPE_BY_STATUS: Record<number, string[]> = {
  400: ["invalid_request_error"],
  401: ["authentication_error"],
  402: ["payment_error"],
  403: ["permission_error"],
  404: ["invalid_request_error"],
  409: ["idempotency_error", "state_conflict"],
  410: ["invalid_request_error"],
  422: ["invalid_request_error"],
  429: ["rate_limit_error"],
  500: ["api_error"],
  502: ["api_error"],
  503: ["api_error", "rail_unavailable"],
};

describe("error catalogue", () => {
  it("maps every status to the type api-conventions §6 prescribes", () => {
    for (const code of ERROR_CODES) {
      const d = ERRORS[code];
      expect(TYPE_BY_STATUS[d.status], `${code} ${d.status}`).toContain(d.type);
    }
  });

  it("marks exactly the retryable statuses as retryable", () => {
    for (const code of ERROR_CODES) {
      const d = ERRORS[code];
      const shouldRetry = d.status >= 500 || code === "rate_limited" || code === "idempotency_in_progress";
      expect(d.retryable, code).toBe(shouldRetry);
    }
  });

  it("has snake_case codes, a docs URL and an example that matches the template", () => {
    for (const code of ERROR_CODES) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(errorDocUrl(code)).toBe(`https://docs.nearpay.money/errors/${code}`);
      const d = ERRORS[code];
      const pattern = new RegExp(
        `^${d.message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[a-z_]+\\\}/g, ".+")}$`,
      );
      expect(d.example, code).toMatch(pattern);
    }
  });

  it("contains no dead codes: every non-generic code is returned by some route", () => {
    const used = new Set([...PUBLIC_ROUTES, ...INTERNAL_ROUTES].flatMap((r) => r.errors));
    const dead = ERROR_CODES.filter((c) => !("generic" in ERRORS[c]) && !used.has(c));
    expect(dead).toEqual([]);
  });

  it("renders messages and keeps unknown placeholders visible", () => {
    expect(renderErrorMessage("asset_unsupported", { asset_id: "nep141:x.near" })).toBe(
      "The asset nep141:x.near is not supported.",
    );
    expect(renderErrorMessage("asset_unsupported")).toBe("The asset {asset_id} is not supported.");
  });

  it("validates the envelope", () => {
    const ok = ErrorEnvelope.safeParse({
      error: {
        type: "invalid_request_error",
        code: "invalid_request",
        message: "m",
        doc_url: errorDocUrl("invalid_request"),
        request_id: "req_01jbz9k3m4n5p6q7r8s9t0v1w2",
      },
    });
    expect(ok.success).toBe(true);
    const bad = ErrorEnvelope.safeParse({
      error: { type: "invalid_request_error", code: "invalid_request", message: "m", doc_url: "x", request_id: "nope" },
    });
    expect(bad.success).toBe(false);
  });
});
