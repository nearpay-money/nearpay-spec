/** Event catalogue integrity (audit gate G5, foundations §8, L-F-02 no PII). */
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  consumerFilters,
  DomainEvent,
  durableName,
  EventEnvelope,
  envelopeOf,
  STREAMS,
  SUBJECT_NAMES,
  SUBJECT_RE,
  SUBJECTS,
  streamOf,
} from "../src/internal-entry.js";
import { SERVICES, SUBJECT_TO_WEBHOOK_TYPE, WEBHOOK_TYPES } from "../src/public-entry.js";
import { propertyNames, toJsonSchema } from "./helpers.js";

describe("event catalogue", () => {
  it("uses evt.<domain>.<aggregate>.<event> subjects produced by their own domain", () => {
    for (const s of SUBJECT_NAMES) {
      expect(s).toMatch(SUBJECT_RE);
      expect(s.split(".")[1], s).toBe(SUBJECTS[s].producer);
      expect(streamOf(s).subjects[0], s).toBe(`evt.${SUBJECTS[s].producer}.>`);
    }
  });

  it("gives every produced subject at least one consumer (G5)", () => {
    for (const s of SUBJECT_NAMES) expect(SUBJECTS[s].consumers.length, s).toBeGreaterThan(0);
  });

  it("maps every public webhook type to a produced subject", () => {
    for (const [type, def] of Object.entries(WEBHOOK_TYPES)) {
      if (def.subject === null) continue;
      expect(SUBJECT_NAMES, type).toContain(def.subject);
      expect(SUBJECTS[def.subject as keyof typeof SUBJECTS].consumers, type).toContain("webhooks");
      expect(SUBJECT_TO_WEBHOOK_TYPE[def.subject]).toBe(type);
    }
  });

  it("only lets webhooks consume subjects it maps publicly", () => {
    for (const s of SUBJECT_NAMES) {
      if (SUBJECTS[s].consumers.includes("webhooks")) expect(SUBJECT_TO_WEBHOOK_TYPE[s], s).toBeDefined();
    }
  });

  it("carries no personal data on the bus (L-F-02)", () => {
    const forbidden = [
      "email",
      "customer_email",
      "full_name",
      "first_name",
      "last_name",
      "given_name",
      "family_name",
      "ip",
      "ip_address",
      "phone",
      "user_agent",
    ];
    for (const s of SUBJECT_NAMES) {
      const names = propertyNames(toJsonSchema(envelopeOf(s), "output"));
      for (const f of forbidden) expect(names.has(f), `${s} has ${f}`).toBe(false);
    }
  });

  it("never carries checkout secrets", () => {
    for (const s of ["evt.payments.checkout_session.completed", "evt.payments.checkout_session.expired"] as const) {
      const obj = SUBJECTS[s].object as unknown as z.ZodObject<{ client_secret: z.ZodType; url: z.ZodType }>;
      const secret = "cs_01jbz9k3m4n5p6q7r8s9t0v1w2_secret_abcdefghijklmnopqrstuvwxyzABCDEF";
      expect(obj.shape.client_secret.safeParse(secret).success).toBe(false);
      expect(obj.shape.url.safeParse(`https://pay.nearpay.money/c/x#${secret}`).success).toBe(false);
      expect(obj.shape.client_secret.safeParse(null).success).toBe(true);
    }
  });

  it("derives consumer filters and durable names", () => {
    expect(consumerFilters("payments")[STREAMS.rails.name]).toEqual([
      "evt.rails.execution.updated",
      "evt.rails.execution.settled",
      "evt.rails.execution.refunded",
      "evt.rails.execution.failed",
      "evt.rails.execution.held",
    ]);
    expect(durableName("payments", STREAMS.rails.name)).toBe("payments--EVT_RAILS");
    for (const svc of SERVICES)
      for (const [st, subjects] of Object.entries(consumerFilters(svc))) {
        for (const sub of subjects) expect(streamOf(sub).name).toBe(st);
      }
  });

  it("configures streams per foundations §8", () => {
    for (const st of Object.values(STREAMS)) {
      expect(st.storage).toBe("file");
      expect(st.maxAgeSeconds).toBe(604800);
      expect(st.duplicateWindowSeconds).toBe(120);
    }
  });

  it("parses a typed envelope and rejects a mismatched payload", () => {
    const env = {
      id: "01972a6f-3c80-7b2e-9f4d-2c1e8a6b5d40",
      subject: "evt.compliance.kyb.approved",
      occurred_at: "2026-11-05T10:00:00.000Z",
      account_id: "01972a6f-3c80-7000-8000-000000000001",
      livemode: true,
      aggregate: { type: "kyb_case", id: "acct_01jwn6yf40e008000000000001", version: 2 },
      data: { object: { account_id: "acct_01jwn6yf40e008000000000001", status: "approved", reason: "ok" } },
    };
    expect(DomainEvent.safeParse(env).success).toBe(true);
    expect(EventEnvelope.safeParse(env).success).toBe(true);
    expect(DomainEvent.safeParse({ ...env, data: { object: { status: "approved" } } }).success).toBe(false);
    expect(EventEnvelope.safeParse({ ...env, subject: "payments.done" }).success).toBe(false);
  });
});
