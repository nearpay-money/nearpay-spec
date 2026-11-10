/** Stage 2 payments contracts (step 2.1): refunds, links, customers, intents, reviews, reconciliation. */
import { describe, expect, it } from "vitest";
import {
  CreateExecution,
  CreateRefundExecution,
  Execution,
  INTERNAL_ROUTES,
  ReconciliationRun,
  Review,
  relaySignedIntent,
  SandboxQuoteRequest,
  SUBJECTS,
  toPublicReview,
} from "../src/internal-entry.js";
import {
  CreatedPaymentIntent,
  cancelRefund,
  createPaymentIntent,
  createPaymentLinkSession,
  createRefund,
  exampleId,
  getPublicPaymentLink,
  hasMetadataFilter,
  listPaymentIntents,
  metadataFilters,
  PaymentIntent,
  PUBLIC_ROUTES,
  PublicReview,
  Refund,
  RefundNextAction,
  RefundSubmission,
  reviewPaymentIntent,
  SUBJECT_TO_WEBHOOK_TYPE,
  submitRefundTx,
  updateRefundRecipient,
  WEBHOOK_TYPES,
} from "../src/public-entry.js";

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const NONCE = `${"A".repeat(43)}=`;
const BINDING = `np1:${"1".repeat(44)}`;
const TS = "2026-11-07T10:00:00.000Z";

type Parser = { safeParse(v: unknown): { success: boolean; data?: unknown } } | undefined;
/** `schema.safeParse(v).success` for optional route schemas. */
const ok = (schema: Parser, v: unknown): boolean => schema?.safeParse(v).success === true;

const evidence = {
  chain: "eip155:8453",
  tx_hash: "0xabcdef0123456789",
  block_ref: "123",
  recipient: "0xpayer",
  asset_id: USDC,
  amount: "1990000",
  finality: "confirmed", // Base: one block (ADR-0022 as amended)
  tier: "A",
  source: "watcher",
  observed_at: TS,
  explorer_url: null,
};

const intentMessage = {
  signer_id: "merchant.near",
  verifying_contract: "intents.near",
  deadline: TS,
  nonce: NONCE,
  intents: [{ intent: "transfer", receiver_id: "payer.near", tokens: { [USDC]: "2000000" }, memo: BINDING }],
};

const signIntent = {
  type: "sign_intent",
  signer_id: "merchant.near",
  transfer: { receiver_id: "payer.near", token: USDC, amount: "2000000", memo: BINDING },
  standards: ["nep413"],
  nep413: { recipient: "intents.near", nonce: NONCE, message: "{}" },
  payload: JSON.stringify(intentMessage),
  message: intentMessage,
  deadline: 1793873400,
  display: "Transfer 2.000000 USDC to payer.near",
};

const signAndSend = {
  type: "sign_and_send",
  chain: "eip155:8453",
  from: "0xmerchant",
  to: "0xdeposit",
  asset_id: USDC,
  token: { standard: "erc20", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
  symbol: "USDC",
  decimals: 6,
  amount: "2000000",
  memo: null,
  deadline: 1793873400,
  display: "Send 2.000000 USDC on Base to 0xdeposit",
};

const refund = {
  id: exampleId("re"),
  object: "refund",
  created: 1793870000,
  livemode: false,
  status: "requires_action",
  payment_intent: exampleId("pi"),
  payment_attempt: exampleId("pa"),
  amount: "2000000",
  asset_id: USDC,
  decimals: 6,
  fee_mode: "payer_absorbs",
  reason: "requested_by_customer",
  method: "route_quote",
  recipient: { address: "0xpayer", asset_id: USDC, chain: "eip155:8453", type: "origin_chain", overridden: false },
  next_action: signAndSend,
  legs: [
    {
      number: 1,
      status: "awaiting_signature",
      method: "route_quote",
      swap_type: "EXACT_INPUT",
      amount: "2000000",
      amount_out_expected: "1990000",
      deadline: 1793873400,
      submitted_tx: null,
      duplicate: false,
      evidence: null,
      failure_code: null,
      created: 1793870000,
    },
  ],
  amount_received: null,
  evidence: null,
  extra_amount_sent: "0",
  source: "dashboard",
  failure_code: null,
  succeeded_at: null,
  canceled_at: null,
  sequence: 1,
  metadata: {},
};

describe("stage 2 payments: refunds", () => {
  it("parses a refund with either next action", () => {
    expect(Refund.safeParse(refund).success).toBe(true);
    expect(Refund.safeParse({ ...refund, method: "intents_transfer", next_action: signIntent }).success).toBe(true);
    expect(Refund.safeParse({ ...refund, status: "succeeded", next_action: null, evidence }).success).toBe(true);
    expect(RefundNextAction.safeParse({ ...signAndSend, type: "sign_anything" }).success).toBe(false);
    expect(
      RefundNextAction.safeParse({ ...signIntent, nep413: { ...signIntent.nep413, recipient: "x.near" } }).success,
    ).toBe(false);
  });

  it("accepts exactly one kind of submission", () => {
    expect(RefundSubmission.safeParse({ tx_hash: "0xabcdef0123456789" }).success).toBe(true);
    const signed = {
      standard: "nep413",
      payload: { recipient: "intents.near", nonce: NONCE, message: "{}" },
      public_key: `ed25519:${"1".repeat(44)}`,
      signature: `ed25519:${"1".repeat(88)}`,
    };
    expect(RefundSubmission.safeParse({ signed_intent: signed }).success).toBe(true);
    expect(RefundSubmission.safeParse({ tx_hash: "0xabcdef0123456789", signed_intent: signed }).success).toBe(false);
    expect(RefundSubmission.safeParse({}).success).toBe(false);
  });

  it("gates refund writes by role and the recipient override by owner + step-up (INV-7)", () => {
    for (const r of [createRefund, submitRefundTx, cancelRefund]) {
      expect(r.roles).toEqual(["owner", "admin", "finance"]);
      expect(r.idempotent).toBe(true);
    }
    expect(updateRefundRecipient.auth).toEqual(["session"]);
    expect(updateRefundRecipient.roles).toEqual(["owner"]);
    expect(updateRefundRecipient.stepUp).toBe(true);
  });

  it("defaults fee_mode to payer_absorbs and validates amounts as base units", () => {
    const body = createRefund.body;
    const parsed = body?.safeParse({ payment_intent: exampleId("pi") });
    expect(parsed?.success && parsed.data.fee_mode).toBe("payer_absorbs");
    expect(ok(body, { payment_intent: exampleId("pi"), amount: 100 })).toBe(false);
    expect(ok(body, { payment_intent: exampleId("pi"), amount: "1.5" })).toBe(false);
  });

  it("publishes refund events on the bus and as webhooks, with notify on success", () => {
    const events = ["created", "requires_action", "pending", "succeeded", "failed", "canceled"];
    for (const e of events) {
      const subject = `evt.payments.refund.${e}` as keyof typeof SUBJECTS;
      expect(SUBJECTS[subject].object).toBe(Refund);
      expect(SUBJECT_TO_WEBHOOK_TYPE[subject]).toBe(`refund.${e}`);
    }
    expect(SUBJECTS["evt.payments.refund.succeeded"].consumers).toContain("notify");
  });
});

describe("stage 2 payments: rails refund legs and agentpay relay", () => {
  const leg = {
    idempotency_key: `refund:${exampleId("re")}:leg:1`,
    account_id: exampleId("acct"),
    livemode: false,
    method: "route_quote",
    reference: {
      payment_intent: exampleId("pi"),
      payment_attempt: exampleId("pa"),
      refund: exampleId("re"),
      refund_leg: 1,
    },
    source: { asset_id: USDC, type: "intents_account", chain: "near:mainnet", address: "merchant.near" },
    recipient: { asset_id: USDC, chain: "eip155:8453", address: "0xpayer", type: "origin_chain" },
    amount: "2000000",
    swap_type: "EXACT_INPUT",
  };

  it("validates the refund-leg create request", () => {
    expect(CreateRefundExecution.safeParse(leg).success).toBe(true);
    expect(CreateRefundExecution.safeParse({ ...leg, fee: {} }).success).toBe(false);
    expect(CreateRefundExecution.safeParse({ ...leg, swap_type: "FLEX_INPUT" }).success).toBe(false);
  });

  it("keeps payment execution requests valid without a reference", () => {
    const ref = CreateExecution.shape.reference;
    expect(ref.safeParse(undefined).success).toBe(true);
    expect(ref.safeParse({ payment_intent: exampleId("pi"), payment_attempt: exampleId("pa") }).success).toBe(true);
  });

  it("carries refund details on the execution view (optional for Stage 1 producers)", () => {
    const refundBlock = {
      swap_type: null,
      amount: "2000000",
      amount_out_expected: "2000000",
      min_amount_out: null,
      token: null,
      transfer: {
        signer_id: "merchant.near",
        receiver_id: "payer.near",
        token: USDC,
        amount: "2000000",
        memo: BINDING,
        deadline: TS,
      },
    };
    expect(Execution.shape.refund.safeParse(undefined).success).toBe(true);
    expect(Execution.shape.refund.safeParse(refundBlock).success).toBe(true);
    expect(Execution.shape.reference.safeParse(null).success).toBe(true);
  });

  it("relays refund payloads with an explicit kind; checkout bodies are unchanged", () => {
    const signed = {
      standard: "raw_ed25519",
      payload: "{}",
      public_key: `ed25519:${"1".repeat(44)}`,
      signature: `ed25519:${"1".repeat(88)}`,
    };
    const base = { execution_id: exampleId("ex"), binding: BINDING, signed };
    expect(ok(relaySignedIntent.body, base)).toBe(true);
    expect(ok(relaySignedIntent.body, { ...base, kind: "refund", refund: exampleId("re") })).toBe(true);
    expect(ok(relaySignedIntent.body, { ...base, kind: "x402" })).toBe(false);
  });

  it("lets the sandbox group quotes per payment or refund (scenario 06)", () => {
    const shape = SandboxQuoteRequest.shape;
    expect(shape.scenario_group.safeParse(exampleId("re")).success).toBe(true);
    expect(shape.scenario_kind.safeParse("refund").success).toBe(true);
    expect(shape.scenario_kind.safeParse(undefined).success).toBe(true);
  });
});

describe("stage 2 payments: intents, filters, review, links", () => {
  it("filters payment intents by typed parameters and metadata[key]", () => {
    const q = listPaymentIntents.query;
    expect(q !== undefined && hasMetadataFilter(q)).toBe(true);
    const parsed = q?.safeParse({ "amount[gte]": "100", currency: "usd", "metadata[order_id]": "42" });
    expect(parsed?.success).toBe(true);
    if (parsed?.success) expect(metadataFilters(parsed.data)).toEqual({ order_id: "42" });
    expect(ok(q, { colour: "red" })).toBe(false);
    expect(ok(q, { "metadata[]": "x" })).toBe(false);
    expect(ok(q, { "amount[gte]": "-1" })).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`metadata[k${i}]`, "v"]));
    expect(ok(q, many)).toBe(false);
  });

  it("returns the payer credential only from createPaymentIntent", () => {
    expect(createPaymentIntent.response).toBe(CreatedPaymentIntent);
    expect(CreatedPaymentIntent.shape.client_secret.safeParse(undefined).success).toBe(false);
    expect("client_secret" in PaymentIntent.shape).toBe(false);
    expect(ok(createPaymentIntent.body, { amount: 500, currency: "usd" })).toBe(false);
    expect(ok(createPaymentIntent.body, { amount: 500, currency: "usd", return_url: "https://m.example/done" })).toBe(
      true,
    );
  });

  it("keeps earlier payment intents valid (new fields are optional)", () => {
    for (const k of ["customer", "payment_link", "amount_refund_pending", "refunds", "review_decision"] as const)
      expect(PaymentIntent.shape[k].safeParse(undefined).success, k).toBe(true);
  });

  it("refuses to accept held verifications (INV-2)", () => {
    expect(reviewPaymentIntent.errors).toContain("review_requires_evidence");
    expect(ok(reviewPaymentIntent.body, { decision: "maybe" })).toBe(false);
  });

  it("serves payment-link payer routes anonymously", () => {
    expect(getPublicPaymentLink.auth).toEqual(["anonymous"]);
    expect(createPaymentLinkSession.auth).toEqual(["anonymous"]);
    expect(createPaymentLinkSession.errors).toContain("link_inactive");
  });

  it("ships every new payments route in Stage 2", () => {
    const stage2 = [...PUBLIC_ROUTES, ...INTERNAL_ROUTES].filter(
      (r) =>
        /(Refund|PaymentLink|Customer|Reconciliation|createPaymentIntent|reviewPaymentIntent|IntentsTransfer)/.test(
          r.id,
        ) && r.id !== "getInternalCustomer" /* stage 3 — billing */,
    );
    expect(stage2.length).toBe(30); // + getOpsRefund (contracts integration)
    for (const r of stage2) expect(r.stage, r.id).toBe(2);
  });
});

describe("stage 2 payments: reviews and reconciliation", () => {
  const busReview = {
    id: exampleId("case"),
    object: "review",
    account_id: exampleId("acct"),
    subject: { type: "execution", id: exampleId("ex") },
    reason: "post_screen_hit",
    status: "open",
    opened_at: TS,
    closed_at: null,
  } as const;

  it("renders execution reviews as payment-intent reviews and hides unattributed ones", () => {
    expect(toPublicReview(Review.parse(busReview), true)).toBeNull();
    const pub = toPublicReview(Review.parse({ ...busReview, payment_intent: exampleId("pi") }), true);
    expect(pub?.subject).toEqual({ type: "payment_intent", id: exampleId("pi") });
    expect(pub?.created).toBe(Math.floor(Date.parse(TS) / 1000));
    expect(PublicReview.safeParse(pub).success).toBe(true);
    expect(WEBHOOK_TYPES["review.opened"].object).toBe(PublicReview);
  });

  it("describes a zero-diff reconciliation run", () => {
    const run = {
      id: exampleId("rcn"),
      object: "reconciliation_run",
      account_id: exampleId("acct"),
      livemode: true,
      day: "2026-11-06",
      status: "ok",
      trigger: "schedule",
      rerun_of: null,
      started_at: TS,
      completed_at: TS,
      totals: [
        {
          asset_id: USDC,
          inflow: { statement: "2000042", evidence: "2000042", statement_lines: 1, executions: 1 },
          outflow: { statement: "0", evidence: "0", statement_lines: 0, executions: 0 },
          fees: { expected: "10000", observed: null },
        },
      ],
      diffs: [],
      diff_count: 0,
      error: null,
      resolution: null,
    };
    expect(ReconciliationRun.safeParse(run).success).toBe(true);
  });
});
