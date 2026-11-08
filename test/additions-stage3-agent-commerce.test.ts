/** stage 3 — agent-commerce: events stream, x402 `near-intents`, CLI login, trigger test helper. */
import { readFileSync } from "node:fs";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";
import canonicalize from "canonicalize";
import { describe, expect, it } from "vitest";
import { Execution, SUBJECTS } from "../src/internal-entry.js";
import {
  AgentPayment,
  approveCliLogin,
  CLI_KEY_SCOPES,
  createCliLogin,
  isNearIntentsRequirements,
  KEY_SCOPES,
  NearIntentsPaymentPayload,
  NearIntentsPaymentRequirements,
  NearIntentsSettleResponse,
  NearIntentsVerifyRequest,
  NearIntentsVerifyResponse,
  PaymentRequirements,
  PUBLIC_ROUTES,
  parseOperationToken,
  payCheckoutSessionTestHelper,
  quotedRequirements,
  SERVICE_CLIENT_SCOPES,
  safeParseTolerant,
  streamEvents,
  VerifyRequest,
  X402NearIntentsBindingInput,
  X402OperationTokenInput,
  X402PaymentRequiredAny,
  x402NearIntentsRequirements,
  x402NearIntentsSettle,
  x402NearIntentsVerify,
} from "../src/public-entry.js";

const v = JSON.parse(readFileSync(new URL("../test-vectors/x402-near-intents.json", import.meta.url), "utf8"));
const enc = new TextEncoder();
const jcs = (x: unknown) => canonicalize(x) as string;

describe("x402 near-intents vectors", () => {
  it("binding = np1 + base58(sha256(JCS(input)))", () => {
    const input = X402NearIntentsBindingInput.parse(v.binding.input);
    expect(jcs(input)).toBe(v.binding.jcs);
    expect(`np1:${bs58.encode(sha256(enc.encode(v.binding.jcs)))}`).toBe(v.binding.binding);
  });
  it("operation token MAC recomputes from the key and the JCS input", () => {
    const t = v.operation_token;
    const input = X402OperationTokenInput.parse(t.input);
    expect(jcs(input)).toBe(t.jcs);
    const mac = Buffer.from(hmac(sha256, Buffer.from(t.key_hex, "hex"), enc.encode(t.jcs))).toString("base64url");
    expect(mac).toBe(t.mac);
    expect(parseOperationToken(t.token)).toEqual({ kid: t.kid, expiry: input.expiry, mac });
    expect(input.binding).toBe(v.binding.binding);
  });
  it("header shapes parse with their schemas", () => {
    const h = v.headers;
    expect(X402PaymentRequiredAny.parse(h.payment_required_unquoted).accepts[0]).toMatchObject({
      amount: "",
      payTo: "",
    });
    expect(NearIntentsPaymentPayload.parse(h.payment_signature_quote).payload.type).toBe("quote");
    expect(NearIntentsVerifyResponse.parse(h.verify_response_quote).isValid).toBe(true);
    expect(NearIntentsPaymentPayload.parse(h.payment_signature_deposit).payload.type).toBe("deposit");
    for (const k of ["payment_response_settled", "payment_response_pending", "payment_response_failed"])
      expect(NearIntentsSettleResponse.safeParse(h[k]).success, k).toBe(true);
  });
  it("quotedRequirements fills payTo/amount and the quoted-only extra fields", () => {
    const unquoted = NearIntentsPaymentRequirements.parse(v.headers.payment_required_unquoted.accepts[0]);
    const q = quotedRequirements(unquoted, v.headers.verify_response_quote.extra);
    expect(q).toEqual(v.headers.payment_required_quoted.accepts[0]);
    expect(q.maxTimeoutSeconds).toBe(unquoted.maxTimeoutSeconds);
    expect(q.extra.operationToken).toBe(v.operation_token.token);
    expect(isNearIntentsRequirements(q)).toBe(true);
  });
  it("keeps intents-transfer and near-intents apart", () => {
    const ni = v.headers.payment_required_unquoted.accepts[0];
    expect(PaymentRequirements.safeParse(ni).success).toBe(false);
    expect(isNearIntentsRequirements({ extra: { assetTransferMethod: "intents-transfer" } })).toBe(false);
    // the intents-transfer request type is unchanged: a near-intents payload is not a VerifyRequest
    expect(
      VerifyRequest.safeParse({
        x402Version: 2,
        paymentPayload: v.headers.payment_signature_quote,
        paymentRequirements: ni,
      }).success,
    ).toBe(false);
    expect(
      NearIntentsVerifyRequest.safeParse({
        x402Version: 2,
        paymentPayload: v.headers.payment_signature_quote,
        paymentRequirements: ni,
      }).success,
    ).toBe(true);
  });
  it("unknown settle reasons are tolerated by tolerant parsing", () => {
    const r = safeParseTolerant(NearIntentsSettleResponse, {
      ...v.headers.payment_response_failed,
      errorReason: "some_future_reason",
    });
    expect(r.success).toBe(true);
  });
});

describe("routes", () => {
  it("serve near-intents on their own /x402/near-intents/* paths", () => {
    for (const r of [x402NearIntentsRequirements, x402NearIntentsVerify, x402NearIntentsSettle]) {
      expect(r.path.startsWith("/x402/near-intents/")).toBe(true);
      expect(r.service).toBe("agentpay");
      expect(r.stage).toBe(3);
      expect(PUBLIC_ROUTES).toContain(r);
    }
  });
  it("events stream has ready/event/reset frames and is key- or session-authenticated", () => {
    expect(Object.keys(streamEvents.stream?.events ?? {})).toEqual(["ready", "event", "reset"]);
    expect(streamEvents.auth).toContain("restricted_key:events.read");
    expect(PUBLIC_ROUTES).toContain(streamEvents);
  });
  it("CLI login mints keys with known scopes only and requires step-up to approve", () => {
    for (const s of CLI_KEY_SCOPES) expect(KEY_SCOPES).toContain(s);
    expect(approveCliLogin.stepUp).toBe(true);
    expect(createCliLogin.auth).toEqual(["anonymous"]);
  });
  it("the trigger helper is test-mode only and callable with the CLI key", () => {
    expect(payCheckoutSessionTestHelper.testModeOnly).toBe(true);
    const scope = payCheckoutSessionTestHelper.auth.find((a) => a.startsWith("restricted_key:"));
    expect(CLI_KEY_SCOPES).toContain(scope?.slice("restricted_key:".length));
  });
});

describe("rails and agentpay additions are optional", () => {
  it("AgentPayment without transfer_method/origin still parses", () => {
    const shape = AgentPayment.shape;
    expect(shape.transfer_method.safeParse(undefined).success).toBe(true);
    expect(shape.origin.safeParse(undefined).success).toBe(true);
    expect(shape.origin.safeParse(null).success).toBe(true);
  });
  it("Execution.owner and x402_binding are optional", () => {
    expect(Execution.shape.owner.safeParse(undefined).success).toBe(true);
    expect(Execution.shape.x402_binding.safeParse(undefined).success).toBe(true);
  });
  it("agentpay consumes terminal execution events and may create executions", () => {
    for (const s of ["settled", "refunded", "failed"] as const)
      expect(SUBJECTS[`evt.rails.execution.${s}`].consumers).toContain("agentpay");
    expect(SERVICE_CLIENT_SCOPES.agentpay).toContain("rails.executions.write");
  });
});
