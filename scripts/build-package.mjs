#!/usr/bin/env node
// Builds one publishable package (public | internal): tsc from ../../src, then copies generated
// artifacts and the license into the package directory.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const which = process.argv[2];
if (which !== "public" && which !== "internal") throw new Error("usage: build-package.mjs public|internal");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "packages", which === "public" ? "spec-public" : "spec-internal");

const copies =
  which === "public"
    ? [
        ["test-vectors", "test-vectors"],
        ["openapi/public.yaml", "openapi/public.yaml"],
        ["schemas/webhooks", "schemas/webhooks"],
        ["schemas/x402", "schemas/x402"],
        ["schemas/intents", "schemas/intents"],
        ["errors", "errors"],
      ]
    : [
        ["openapi/internal", "openapi/internal"],
        ["asyncapi", "asyncapi"],
        ["schemas/events", "schemas/events"],
      ];

for (const d of ["dist", "test-vectors", "openapi", "schemas", "errors", "asyncapi"])
  rmSync(join(pkg, d), { recursive: true, force: true });
const tsc = join(root, "node_modules", ".bin", "tsc");
execFileSync(tsc, ["-p", join(pkg, "tsconfig.build.json")], { stdio: "inherit" });
for (const [from, to] of copies) {
  const src = join(root, from);
  if (!existsSync(src)) throw new Error(`missing ${from}; run pnpm emit && pnpm vectors`);
  mkdirSync(dirname(join(pkg, to)), { recursive: true });
  cpSync(src, join(pkg, to), { recursive: true });
}
cpSync(join(root, "LICENSE"), join(pkg, "LICENSE"));
console.log(`built ${which}`);
