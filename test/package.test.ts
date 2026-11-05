import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SPEC_INTERNAL_VERSION } from "../src/internal-entry.js";
import { SPEC_VERSION } from "../src/public-entry.js";

const pkg = (p: string) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));

describe("package metadata", () => {
  it("keeps code, package and baseline versions in step", () => {
    expect(pkg("packages/spec-public/package.json").version).toBe(SPEC_VERSION);
    expect(pkg("packages/spec-internal/package.json").version).toBe(SPEC_INTERNAL_VERSION);
    expect(SPEC_INTERNAL_VERSION).toBe(SPEC_VERSION);
    expect(pkg("package.json").version).toBe(SPEC_VERSION);
  });
  it("pins the public package from the internal one and keeps zod a peer", () => {
    expect(pkg("packages/spec-internal/package.json").dependencies["@nearpay/spec"]).toBe("workspace:*");
    for (const p of ["packages/spec-public/package.json", "packages/spec-internal/package.json"]) {
      expect(pkg(p).peerDependencies.zod).toBe("^4.6.7");
      expect(pkg(p).license).toBe("Apache-2.0");
    }
  });
});
