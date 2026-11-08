/** Stage 4 auto-debit contracts (step 4.1): vault wire mirror, mandates, events, sandbox vault stand-in. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BILLING_EMAIL_TEMPLATES,
  consumerFilters,
  INTERNAL_ROUTES,
  NearExecutionStatus,
  NearFinalExecutionOutcome,
  NearRpcRequest,
  NearRpcResponse,
  nearPanicStatus,
  STREAMS,
  SUBJECTS,
  VaultEventRecord,
  vaultEventDedupeKey,
  vaultSandboxPartialShare,
  vaultSandboxScenarioOf,
} from "../src/internal-entry.js";
import {
  CollectionMethod,
  ERRORS,
  EVENT_JSON_PREFIX,
  formatVaultEventLog,
  HEADERS,
  Invoice,
  Mandate,
  MandateFundingInstructions,
  PUBLIC_ANONYMOUS_ROUTES,
  PUBLIC_ROUTES,
  parseVaultEventLog,
  SERVICE_CLIENT_SCOPES,
  SUBJECT_TO_WEBHOOK_TYPE,
  Subscription,
  VAULT_ERRORS,
  VAULT_GAS,
  VAULT_LIMITS,
  VaultMsg,
  vaultErrorCodeOf,
  vaultMsgJson,
  vaultPeriodSecs,
  vaultSplit,
  WEBHOOK_TYPES,
  z,
} from "../src/public-entry.js";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const vectors = read("../test-vectors/vault.json");
const wire = read("./fixtures/vault-contract-wire.json");

describe("stage 4 vault mirror: byte parity with the contract (OQ-T-03)", () => {
  it("reproduces every event line the contract formats", () => {
    expect(vectors.events.length).toBe(Object.keys(wire.events).length);
    for (const v of vectors.events) expect(v.log, v.case).toBe(wire.events[v.case]);
  });

  it("reproduces every view result the contract serialises", () => {
    for (const v of vectors.views) expect(v.result_json, v.case).toBe(wire.views[v.case]);
  });

  it("has the contract's error strings, cap log lines and constants", () => {
    expect([...VAULT_ERRORS]).toEqual(wire.errors);
    expect(vectors.errors.cap_exceeded_log_lines).toEqual(wire.cap_logs);
    for (const k of Object.keys(wire.constants).filter((x) => !x.endsWith("_tgas"))) {
      expect(String(VAULT_LIMITS[k as keyof typeof VAULT_LIMITS]), k).toBe(String(wire.constants[k]));
    }
    expect(BigInt(VAULT_GAS.min_collect)).toBe(BigInt(wire.constants.min_collect_tgas) * 10n ** 12n);
    expect(BigInt(VAULT_GAS.min_exit)).toBe(BigInt(wire.constants.min_exit_tgas) * 10n ** 12n);
    expect(BigInt(VAULT_GAS.keeper_collect)).toBeGreaterThan(BigInt(VAULT_GAS.min_collect));
  });

  it("parses and re-formats every event line unchanged", () => {
    for (const v of vectors.events) {
      const parsed = parseVaultEventLog(v.log);
      expect(parsed, v.case).not.toBeNull();
      if (parsed) expect(formatVaultEventLog(parsed)).toBe(v.log);
    }
  });

  it("rejects lines that are not valid vault events", () => {
    const good = vectors.events[0].log as string;
    expect(parseVaultEventLog(good.replace('"1.0.0"', '"1.1.0"'))).toBeNull();
    expect(parseVaultEventLog(good.replace("nearpay_vault", "nep141"))).toBeNull();
    expect(parseVaultEventLog(good.slice(EVENT_JSON_PREFIX.length))).toBeNull();
    expect(parseVaultEventLog(`${EVENT_JSON_PREFIX}{`)).toBeNull();
    expect(parseVaultEventLog(good.replace('"10000000"', '"+10"'))).toBeNull(); // canonical decimals only
    expect(parseVaultEventLog(good.replace('"event":"mandate_created"', '"event":"minted"'))).toBeNull();
  });

  it("finds the vault code in panics and rejection lines, never in the detail", () => {
    expect(vaultErrorCodeOf("Smart contract panicked: ERR_NOT_DUE")).toBe("ERR_NOT_DUE");
    expect(vaultErrorCodeOf("ERR_CAP_EXCEEDED: mandate")).toBe("ERR_CAP_EXCEEDED");
    expect(vaultErrorCodeOf("Smart contract panicked: Requires attached deposit of exactly 1 yoctoNEAR")).toBeNull();
    expect(vaultErrorCodeOf("ERR_SOMETHING_ELSE")).toBeNull();
    const status = nearPanicStatus("ERR_GAS");
    expect(NearExecutionStatus.safeParse(status).success).toBe(true);
    expect(vaultErrorCodeOf(status.Failure.ActionError.kind.FunctionCallError.ExecutionError)).toBe("ERR_GAS");
  });

  it("serialises msgs the way the contract parses them", () => {
    for (const m of vectors.msgs) {
      expect(VaultMsg.safeParse(m.msg).success, m.case).toBe(true);
      expect(vaultMsgJson(m.msg)).toBe(m.json);
    }
    expect(() =>
      vaultMsgJson({ create_mandate: { ...vectors.msgs[0].msg.create_mandate, payer: "x.near" } } as never),
    ).toThrow();
    expect(
      VaultMsg.safeParse({ create_mandate: { ...vectors.msgs[0].msg.create_mandate, period_secs: 3600 } }).success,
    ).toBe(false);
  });

  it("splits like the contract and maps billing intervals to fixed periods", () => {
    for (const s of vectors.split) {
      const r = vaultSplit(BigInt(s.amount_per_period), s.fee_bps);
      expect([String(r.merchantShare), String(r.fee)]).toEqual([s.merchant_share, s.fee]);
    }
    expect(vaultPeriodSecs("month", 1)).toBe(2_629_746);
    expect(vaultPeriodSecs("month", 12)).toBe(vaultPeriodSecs("year", 1));
    expect(vaultPeriodSecs("year", 12)).toBeLessThanOrEqual(VAULT_LIMITS.max_period_secs);
    expect(() => vaultPeriodSecs("day", 0)).toThrow();
  });
});

describe("stage 4 mandates: routes", () => {
  const stage4 = PUBLIC_ROUTES.filter((r) => r.stage === 4 && r.service === "billing");

  it("adds the mandate, hosted-page and test-helper routes", () => {
    expect(stage4.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      [
        "GET /v1/invoices/{id}/public/mandate",
        "GET /v1/mandates",
        "GET /v1/mandates/{id}",
        "POST /v1/invoices/{id}/public/mandate_funding",
        "POST /v1/mandates/prepare",
        "POST /v1/mandates/{id}/prepare_cancel",
        "POST /v1/test_helpers/mandates/fund",
        "POST /v1/test_helpers/mandates/{id}/payer_action",
      ].sort(),
    );
  });

  it("uses the subscription scopes and keeps the payer routes behind the invoice secret", () => {
    for (const r of stage4) {
      if (r.auth.includes("anonymous")) {
        expect(r.headers instanceof z.ZodObject && HEADERS.invoiceSecret.toLowerCase() in r.headers.shape).toBe(true);
        expect(r.errors).toContain("invoice_secret_invalid");
        expect(PUBLIC_ANONYMOUS_ROUTES.some((a) => a.path === r.path && a.method === r.method)).toBe(true);
      } else {
        expect(
          r.auth.includes("restricted_key:subscriptions.write") || r.auth.includes("restricted_key:subscriptions.read"),
          r.id,
        ).toBe(true);
      }
      if (r.path.startsWith("/v1/test_helpers/")) expect(r.testModeOnly, r.id).toBe(true);
    }
    expect(ERRORS.auto_debit_unavailable.since).toBe("0.4.0");
    expect(ERRORS.vault_cap_exceeded.since).toBe("0.4.0");
  });

  it("widens subscriptions and invoices additively", () => {
    expect(CollectionMethod.safeParse("auto_debit").success).toBe(true);
    const create = PUBLIC_ROUTES.find((r) => r.id === "createSubscription");
    const body = create?.body as z.ZodType;
    const base = { customer: "cus_01jbz9k3m4n5p6q7r8s9t0v1w2", items: [{ price: "price_01jbz9k3m4n5p6q7r8s9t0v1w2" }] };
    expect(body.safeParse({ ...base, collection_method: "auto_debit" }).success).toBe(true);
    expect(body.safeParse({ ...base, collection_method: "send_invoice" }).success).toBe(true);
    expect(body.safeParse({ ...base, collection_method: "charge_automatically" }).success).toBe(false);
    expect("mandate" in Subscription.shape && Subscription.shape.mandate.safeParse(undefined).success).toBe(true);
    expect(Invoice.shape.mandate_collection.safeParse(undefined).success).toBe(true);
  });

  it("funding instructions carry a msg the vault parses and the payer notice", () => {
    const sample = {
      object: "mandate_funding_instructions",
      livemode: false,
      subscription: "sub_01jbz9k3m4n5p6q7r8s9t0v1w2",
      vault_contract: "vault.sandbox.near",
      token: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      asset_id: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      amount: "30000000",
      periods: 3,
      amount_per_period: "10000000",
      period_secs: 2_629_746,
      start_at: null,
      fee_bps: 100,
      merchant_receiver: "merchant-demo.near",
      receiver_kind: "intents_account",
      settlement_destination: "sd_01jbz9k3m4n5p6q7r8s9t0v1w2",
      ext_ref: "sub_01jbz9k3m4n5p6q7r8s9t0v1w2",
      msg: vectors.msgs[0].json,
      payer: null,
      storage: { payer_registered: null, deposit: "12000000000000000000000" },
      payer_notice: "Sign from your own account.",
      transactions: [
        {
          signer_id: null,
          receiver_id: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
          actions: [
            {
              type: "FunctionCall",
              method_name: "ft_transfer_call",
              args: { receiver_id: "vault.sandbox.near", amount: "30000000", msg: vectors.msgs[0].json },
              gas: VAULT_GAS.ft_transfer_call,
              deposit: "1",
            },
          ],
        },
      ],
    };
    expect(MandateFundingInstructions.safeParse(sample).success).toBe(true);
    expect(VaultMsg.safeParse(JSON.parse(sample.msg)).success).toBe(true);
  });
});

describe("stage 4 mandates: events, webhooks, notify", () => {
  const mandateSubjects = Object.keys(SUBJECTS).filter((s) => s.startsWith("evt.billing.mandate."));

  it("publishes mandate events and forwards vault events from rails to billing", () => {
    expect(mandateSubjects.sort()).toEqual(
      ["activated", "collected", "insufficient_funds", "canceled", "exhausted", "updated", "unlinked", "released"]
        .map((e) => `evt.billing.mandate.${e}`)
        .sort(),
    );
    expect(SUBJECTS["evt.rails.vault.event"].consumers).toEqual(["billing"]);
    expect(consumerFilters("billing")[STREAMS.rails.name]).toEqual(["evt.rails.vault.event"]);
    for (const s of mandateSubjects) {
      expect(SUBJECT_TO_WEBHOOK_TYPE[s]).toBe(s.replace("evt.billing.", ""));
      expect(WEBHOOK_TYPES[SUBJECT_TO_WEBHOOK_TYPE[s] as keyof typeof WEBHOOK_TYPES].object).toBe(Mandate);
    }
  });

  it("mails the payer for exactly the subjects notify consumes", () => {
    const notify = consumerFilters("notify")[STREAMS.billing.name] ?? [];
    for (const [tpl, d] of Object.entries(BILLING_EMAIL_TEMPLATES)) {
      if (tpl.startsWith("mandate.")) {
        expect(notify, tpl).toContain(d.subject);
        expect(d.context).toBe("getMandateNotificationContext");
      }
    }
    expect(INTERNAL_ROUTES.some((r) => r.id === "getMandateNotificationContext")).toBe(true);
  });

  it("carries a valid vault event with its receipt context", () => {
    const rec = {
      vault_contract: "v1.vault.nearpay.near",
      tx_hash: "9sYxQ8Kq1ZbH2x3Vt7YqzM1o4c5d6e7f8g9h1j2k3m4n",
      receipt_id: "4Wk1Z7aVqD3r8sL2nX6pT9uY5bC1eF3gH7jK2mN4pQ8r",
      log_index: 0,
      block_height: 140_000_000,
      block_hash: "7Hq2mP4rS6tU8vW1xY3zA5bC7dE9fG2hJ4kL6mN8pQ1r",
      block_timestamp: "1794268800000000000",
      event: JSON.parse((vectors.events[0].log as string).slice(EVENT_JSON_PREFIX.length)),
    };
    expect(VaultEventRecord.safeParse(rec).success).toBe(true);
    expect(vaultEventDedupeKey(rec)).toBe(`${rec.receipt_id}:0`);
  });
});

describe("stage 4 sandbox vault stand-in", () => {
  const sandbox = INTERNAL_ROUTES.filter((r) => r.service === "sandbox" && r.stage === 4);

  it("serves the RPC subset, funding, unsigned calls and the mandate clock", () => {
    expect(sandbox.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      [
        "POST /sim/near-rpc",
        "POST /sim/vault/advance",
        "POST /sim/vault/call",
        "POST /sim/vault/ft_transfer_call",
      ].sort(),
    );
    for (const r of sandbox) expect(r.auth).toEqual(["service:sandbox.use"]);
    expect(SERVICE_CLIENT_SCOPES.billing).toContain("sandbox.use");
  });

  it("accepts the requests a NEAR JSON-RPC client sends and answers in NEAR's shapes", () => {
    const ok = (v: unknown) => NearRpcRequest.safeParse(v).success;
    expect(ok({ jsonrpc: "2.0", id: "1", method: "block", params: { finality: "final" } })).toBe(true);
    expect(
      ok({
        jsonrpc: "2.0",
        id: 2,
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: "vault.sandbox.near",
          method_name: "get_mandate",
          args_base64: Buffer.from('{"mandate_id":7}').toString("base64"),
        },
      }),
    ).toBe(true);
    expect(
      ok({ jsonrpc: "2.0", id: 3, method: "send_tx", params: { signed_tx_base64: "AAAA", wait_until: "FINAL" } }),
    ).toBe(true);
    expect(ok({ jsonrpc: "2.0", id: 4, method: "broadcast_tx_commit", params: ["AAAA"] })).toBe(true);
    expect(ok({ jsonrpc: "2.0", id: 5, method: "gas_price", params: [null] })).toBe(false);
    const outcome = {
      status: vectors.rpc.collect_success.status,
      transaction: {
        signer_id: "keeper.nearpay.near",
        public_key: "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp",
        nonce: 1,
        receiver_id: "vault.sandbox.near",
        hash: "9sYxQ8Kq1ZbH2x3Vt7YqzM1o4c5d6e7f8g9h1j2k3m4n",
      },
      transaction_outcome: {
        id: "9sYxQ8Kq1ZbH2x3Vt7YqzM1o4c5d6e7f8g9h1j2k3m4n",
        block_hash: "7Hq2mP4rS6tU8vW1xY3zA5bC7dE9fG2hJ4kL6mN8pQ1r",
        outcome: {
          logs: [],
          receipt_ids: ["r1"],
          gas_burnt: 1,
          tokens_burnt: "0",
          executor_id: "keeper.nearpay.near",
          status: { SuccessReceiptId: "r1" },
        },
      },
      receipts_outcome: [
        {
          id: "r1",
          block_hash: "7Hq2mP4rS6tU8vW1xY3zA5bC7dE9fG2hJ4kL6mN8pQ1r",
          outcome: {
            logs: vectors.rpc.collect_success.vault_receipt.logs,
            receipt_ids: [],
            gas_burnt: 1,
            tokens_burnt: "0",
            executor_id: "vault.sandbox.near",
            status: { SuccessValue: vectors.rpc.collect_success.vault_receipt.status_success_value_base64 },
          },
        },
      ],
    };
    expect(NearFinalExecutionOutcome.safeParse(outcome).success).toBe(true);
    expect(NearRpcResponse.safeParse({ jsonrpc: "2.0", id: 3, result: outcome }).success).toBe(true);
    expect(
      NearFinalExecutionOutcome.safeParse({ ...outcome, status: vectors.rpc.collect_not_due_status }).success,
    ).toBe(true);
  });

  it("picks outcome scenarios by the last two digits of amount_per_period", () => {
    expect(vaultSandboxScenarioOf("10000000")).toBe("success");
    expect(vaultSandboxScenarioOf("10000091")).toBe("merchant_leg_fails");
    expect(vaultSandboxScenarioOf("10000092")).toBe("fee_leg_fails");
    expect(vaultSandboxScenarioOf("10000093")).toBe("first_refund_fails");
    expect(vaultSandboxScenarioOf("10000094")).toBe("partial_delivery");
    expect(vaultSandboxScenarioOf("9")).toBe("success");
    expect(vaultSandboxPartialShare(9_900_000n)).toBe(4_950_000n);
    expect(vaultSandboxPartialShare(1n)).toBe(0n);
  });
});
