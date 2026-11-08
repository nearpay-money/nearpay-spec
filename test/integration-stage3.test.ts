/** stage 3 — integration: cross-cutting checks between billing and agent-commerce (0.3.0). */
import { describe, expect, it } from "vitest";
import {
  CLI_KEY_SCOPES,
  Event,
  ID_PREFIXES,
  PUBLIC_ANONYMOUS_ROUTES,
  PUBLIC_ROUTES,
  streamEvents,
  WEBHOOK_TYPE_NAMES,
} from "../src/public-entry.js";

const billingTypes = WEBHOOK_TYPE_NAMES.filter(
  (t) => t.startsWith("invoice.") || t.startsWith("customer.subscription."),
);

describe("stage 3 integration (billing × agent-commerce)", () => {
  it("the events stream renders billing's invoice.* and customer.subscription.* events", () => {
    expect(billingTypes).toHaveLength(12);
    expect(streamEvents.stream?.events.event).toBe(Event);
    const streamed = new Set(Event.options.map((o) => (o.shape.type as unknown as { value: string }).value));
    for (const t of billingTypes) expect(streamed.has(t), t).toBe(true);
  });

  it("the CLI test key can drive every billing route that admits a restricted key", () => {
    const billing = PUBLIC_ROUTES.filter((r) =>
      /^\/v1\/(invoices|subscriptions|products|prices|tax_rates)\b/.test(r.path),
    );
    expect(billing.length).toBeGreaterThan(0);
    const cli = new Set<string>(CLI_KEY_SCOPES);
    for (const r of billing) {
      for (const a of r.auth) {
        if (a.startsWith("restricted_key:"))
          expect(cli.has(a.slice("restricted_key:".length)), `${r.id} ${a}`).toBe(true);
      }
    }
  });

  it("anonymous allow-list carries billing's hosted invoice routes and the CLI login routes", () => {
    const keys = PUBLIC_ANONYMOUS_ROUTES.map((r) => `${r.method} ${r.path}`);
    for (const k of [
      "GET /v1/invoices/{id}/public",
      "POST /v1/invoices/{id}/public/sessions",
      "GET /v1/invoices/{id}/public/pdf",
      "POST /v1/cli/logins",
      "POST /v1/cli/logins/poll",
    ]) {
      expect(keys, k).toContain(k);
    }
  });

  it("ID prefixes name distinct objects", () => {
    const objects = Object.values(ID_PREFIXES).map((p) => p.object);
    expect(new Set(objects).size).toBe(objects.length);
  });
});
