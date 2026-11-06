/** Tolerant parsing of open enums for SDKs (api-conventions §5, spec 0.1.5). */
import { describe, expect, it } from "vitest";
import {
  AgentPayment,
  closedEnum,
  Event,
  exampleId,
  openEnum,
  out,
  parseTolerant,
  safeParseTolerant,
  z,
} from "../src/public-entry.js";

const agentPayment = {
  id: exampleId("ap"),
  object: "agent_payment",
  created: 1793873400,
  livemode: false,
  kind: "x402",
  status: "settled",
  payer: "payer.near",
  pay_to: "merchant.near",
  asset_id: "nep141:usdc.near",
  amount: "1000",
  fee_amount: "3",
  binding: `np1:${"A".repeat(44)}`,
  resource_url: "https://merchant.example/r",
  checkout_session: null,
  tx_hash: null,
  block_height: null,
  error_reason: null,
  settled_at: null,
};

const S = out({
  open: openEnum(["a", "b"], "Open."),
  closed: closedEnum(["x", "y"], "Closed."),
  list: z.array(openEnum(["a", "b"], "Open item.")).describe("Items."),
  maybe: openEnum(["a", "b"], "Open nullable.").nullable(),
  either: z.union([z.literal("none"), out({ st: openEnum(["a", "b"], "Nested open.") })]).describe("Union."),
});
const ok = { open: "a", closed: "x", list: ["a"], maybe: null, either: "none" };

describe("safeParseTolerant", () => {
  it("leaves the strict schemas unchanged", () => {
    expect(S.safeParse({ ...ok, open: "c" }).success).toBe(false);
    expect(AgentPayment.safeParse({ ...agentPayment, status: "reversed" }).success).toBe(false);
  });

  it("parses valid input like safeParse", () => {
    const r = safeParseTolerant(S, ok);
    expect(r).toEqual({ success: true, data: ok, unknown: [] });
  });

  it("keeps unknown strings of open enums at any depth and reports them", () => {
    const input = { ...ok, open: "c", list: ["a", "z"], maybe: "q", either: { st: "new" } };
    const before = structuredClone(input);
    const r = safeParseTolerant(S, input);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toEqual(input);
    expect(input).toEqual(before);
    expect(r.unknown).toEqual(
      expect.arrayContaining([
        { path: ["open"], value: "c" },
        { path: ["list", 1], value: "z" },
        { path: ["maybe"], value: "q" },
        { path: ["either", "st"], value: "new" },
      ]),
    );
    expect(r.unknown).toHaveLength(4);
  });

  it("still rejects closed enums, non-strings and other errors with the strict error", () => {
    for (const bad of [
      { ...ok, closed: "z" },
      { ...ok, open: 7 },
      { ...ok, open: "c", closed: "z" },
      { ...ok, either: { st: 1 } },
      { ...ok, list: "a" },
    ]) {
      const r = safeParseTolerant(S, bad);
      expect(r.success, JSON.stringify(bad)).toBe(false);
      if (!r.success) {
        expect(r.error.issues).toEqual(S.safeParse(bad).error?.issues);
        for (const i of r.error.issues) expect(i.message).not.toContain("nearpay:open-enum");
      }
    }
    expect(() => parseTolerant(S, { ...ok, closed: "z" })).toThrow(z.ZodError);
  });

  it("accepts a root-level open enum", () => {
    const E = openEnum(["a", "b"], "Root.");
    expect(parseTolerant(E, "zz")).toBe("zz");
    expect(safeParseTolerant(E, "zz")).toEqual({ success: true, data: "zz", unknown: [{ path: [], value: "zz" }] });
  });

  it("tolerates new statuses in real objects, events and expanded unions", () => {
    expect(parseTolerant(AgentPayment, { ...agentPayment, status: "reversed" }).status).toBe("reversed");
    const event = {
      id: exampleId("evt"),
      object: "event",
      type: "agent_payment.settled",
      api_version: "2026-11-01",
      created: 1793873400,
      livemode: false,
      data: { object: { ...agentPayment, kind: "subscription", status: "reversed", sequence: 3 } },
      request: { id: null, idempotency_key: null },
    };
    const r = safeParseTolerant(Event, event);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.unknown.map((u) => u.value).sort()).toEqual(["reversed", "subscription"]);
      expect(r.data.data.object).toMatchObject({ kind: "subscription", status: "reversed", sequence: 3 });
    }
    // An unknown event type is not an open-enum miss of a variant: use EventEnvelopeLoose for those.
    expect(safeParseTolerant(Event, { ...event, type: "invoice.paid" }).success).toBe(false);
  });
});
