/** stage 4 — integration: cross-cutting checks between autodebit and chains (0.4.0). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  attestSettlementDestination,
  CLI_KEY_SCOPES,
  DESTINATION_SIGNING_STANDARDS,
  Event,
  Evidence,
  MANDATE_FUNDING_PAYER_NOTICE,
  Mandate,
  MandateFundingInstructions,
  PUBLIC_ANONYMOUS_ROUTES,
  PUBLIC_ROUTES,
  PublicMandate,
  streamEvents,
  VaultConfigView,
  VaultMandateView,
  WEBHOOK_TYPE_NAMES,
} from "../src/public-entry.js";

const mandateTypes = WEBHOOK_TYPE_NAMES.filter((t) => t.startsWith("mandate."));
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("stage 4 integration (autodebit × chains)", () => {
  it("the events stream renders the mandate.* events", () => {
    expect(mandateTypes).toHaveLength(8);
    expect(streamEvents.stream?.events.event).toBe(Event);
    const streamed = new Set(Event.options.map((o) => (o.shape.type as unknown as { value: string }).value));
    for (const t of mandateTypes) expect(streamed.has(t), t).toBe(true);
  });

  it("the CLI test key can drive every mandate route that admits a restricted key", () => {
    const routes = PUBLIC_ROUTES.filter((r) => /^\/v1\/(test_helpers\/)?mandates\b/.test(r.path));
    expect(routes.length).toBeGreaterThan(0);
    const cli = new Set<string>(CLI_KEY_SCOPES);
    for (const r of routes) {
      for (const a of r.auth) {
        if (a.startsWith("restricted_key:"))
          expect(cli.has(a.slice("restricted_key:".length)), `${r.id} ${a}`).toBe(true);
      }
    }
  });

  it("anonymous allow-list carries the hosted invoice mandate routes", () => {
    const keys = PUBLIC_ANONYMOUS_ROUTES.map((r) => `${r.method} ${r.path}`);
    for (const k of ["POST /v1/invoices/{id}/public/mandate_funding", "GET /v1/invoices/{id}/public/mandate"]) {
      expect(keys, k).toContain(k);
    }
  });

  it("vault types stay NEAR NEP-141 only (no Solana/Bitcoin leak)", () => {
    const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // Solana USDC mint
    const tokens = (
      VaultConfigView.shape.allowed_tokens as unknown as { element: { safeParse(v: unknown): { success: boolean } } }
    ).element;
    expect(tokens.safeParse(usdcMint).success).toBe(false);
    expect(Mandate.shape.token.safeParse(usdcMint).success).toBe(false);
    expect(Mandate.shape.asset_id.safeParse("nep141:usdc.near").success).toBe(true);
    expect(VaultMandateView.shape.token.safeParse(usdcMint).success).toBe(false);
    const vault = read("test-vectors/vault.json");
    expect(vault).not.toMatch(/solana:|bip122:|omft\.near/);
  });

  it("Evidence carries the chain detail everywhere it is embedded (one component, by $ref)", () => {
    expect(Object.keys(Evidence.shape)).toEqual(expect.arrayContaining(["sender", "solana", "bitcoin"]));
    const doc = parse(read("openapi/public.yaml")) as {
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    const ev = doc.components.schemas.Evidence?.properties ?? {};
    expect(Object.keys(ev)).toEqual(expect.arrayContaining(["sender", "solana", "bitcoin"]));
    // No inline copy of Evidence that would miss the additions.
    for (const [name, s] of Object.entries(doc.components.schemas)) {
      if (name === "Evidence") continue;
      const p = s.properties ?? {};
      const looksLikeEvidence = "tx_hash" in p && "finality" in p && "block_ref" in p;
      expect(looksLikeEvidence, name).toBe(false);
    }
  });

  it("destination signing standards match the attestation request enum", () => {
    const standard = attestSettlementDestination.body?.shape.standard as unknown as { options: string[] };
    expect([...standard.options].sort()).toEqual([...DESTINATION_SIGNING_STANDARDS].sort());
  });
});

describe("spec 0.4.1 change requests", () => {
  it("mandate funding instructions and the hosted-page mandate carry optional token display data", () => {
    for (const s of [MandateFundingInstructions, PublicMandate]) {
      const t = s.shape.token_asset;
      expect(t.safeParse(undefined).success).toBe(true);
      expect(t.safeParse({ asset_id: "nep141:usdc.near", symbol: "USDC", decimals: 6 }).success).toBe(true);
      expect(t.safeParse({ asset_id: "nep141:usdc.near", symbol: "USDC" }).success).toBe(false);
    }
  });
  it("the payer notice says cancel works only from the paying account", () => {
    expect(MANDATE_FUNDING_PAYER_NOTICE).toContain(
      "You can cancel at any time from the NEAR account you pay with; the remaining balance goes back to it.",
    );
    expect(MANDATE_FUNDING_PAYER_NOTICE).not.toMatch(/any NEAR wallet/);
  });
});
