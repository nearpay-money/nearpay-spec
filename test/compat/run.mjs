#!/usr/bin/env node
/**
 * Contract compatibility gate (lld/00-foundations.md §3: "oasdiff against the last released tag;
 * fails on breaking change").
 *
 * 1. Self-test: proves oasdiff flags a breaking change and ignores an open-enum addition, so the
 *    gate can never pass because the tooling silently does nothing.
 * 2. Compares every released document in test/compat/baseline/ (snapshot of the last release)
 *    with the current one: public and internal OpenAPI, plus events and webhook payloads rendered
 *    as GET responses (consumer-side compatibility rules).
 *
 * Usage: node test/compat/run.mjs                  run the gate
 *        node test/compat/run.mjs --update-baseline snapshot current documents (release step only)
 * oasdiff: uses `oasdiff` on PATH, else Docker image tufin/oasdiff:v1.34.1.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const OASDIFF_IMAGE = "tufin/oasdiff:v1.34.1";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const baselineDir = join(root, "test", "compat", "baseline");
const work = mkdtempSync(join(tmpdir(), "nearpay-compat-"));

function oasdiffCmd() {
  const local = spawnSync("oasdiff", ["--version"], { encoding: "utf8" });
  if (local.status === 0) return { cmd: "oasdiff", map: (p) => p, pre: [] };
  const docker = spawnSync("docker", ["image", "inspect", OASDIFF_IMAGE], { encoding: "utf8" });
  if (docker.status !== 0) execFileSync("docker", ["pull", "-q", OASDIFF_IMAGE], { stdio: "inherit" });
  return {
    cmd: "docker",
    pre: ["run", "--rm", "-v", `${root}:/root-dir:ro`, "-v", `${work}:/work-dir:ro`, OASDIFF_IMAGE],
    map: (p) => (p.startsWith(work) ? `/work-dir/${relative(work, p)}` : `/root-dir/${relative(root, p)}`),
  };
}

const od = oasdiffCmd();
function breaking(base, rev) {
  const r = spawnSync(
    od.cmd,
    [...od.pre, "breaking", od.map(base), od.map(rev), "--fail-on", "ERR", "--format", "singleline"],
    { encoding: "utf8" },
  );
  if (r.error) throw r.error;
  return { status: r.status, output: `${r.stdout}${r.stderr}`.trim() };
}

function currentDocs() {
  const compatOut = join(work, "compat");
  execFileSync(
    join(root, "node_modules", ".bin", "tsx"),
    [join(root, "codegen", "emit.ts"), "--compat-out", compatOut],
    { stdio: "inherit", cwd: root },
  );
  const docs = { "openapi/public.yaml": join(root, "openapi", "public.yaml") };
  for (const f of readdirSync(join(root, "openapi", "internal")))
    docs[`openapi/internal/${f}`] = join(root, "openapi", "internal", f);
  for (const f of readdirSync(compatOut)) docs[`compat/${f}`] = join(compatOut, f);
  return docs;
}

/** Removes a required property (must break) and adds an optional one + an open-enum value (must not). */
function selfTestOne(label, yamlPath, component, removeProp, openEnumProp) {
  const doc = parse(readFileSync(yamlPath, "utf8"));
  const schema = doc.components.schemas[component];
  if (!schema?.properties?.[removeProp]) throw new Error(`self-test: ${component}.${removeProp} not found in ${label}`);
  const brokenDoc = structuredClone(doc);
  delete brokenDoc.components.schemas[component].properties[removeProp];
  brokenDoc.components.schemas[component].required = schema.required.filter((k) => k !== removeProp);
  const additiveDoc = structuredClone(doc);
  const st = additiveDoc.components.schemas[component].properties[openEnumProp];
  if (!Array.isArray(st?.["x-extensible-enum"]))
    throw new Error(`self-test: ${component}.${openEnumProp} is not an open enum`);
  st["x-extensible-enum"] = [...st["x-extensible-enum"], "self_test_value"];
  additiveDoc.components.schemas[component].properties.self_test_field = { type: "string" };
  const base = join(work, `selftest-${label}-base.yaml`);
  const broken = join(work, `selftest-${label}-broken.yaml`);
  const additive = join(work, `selftest-${label}-additive.yaml`);
  writeFileSync(base, stringify(doc));
  writeFileSync(broken, stringify(brokenDoc));
  writeFileSync(additive, stringify(additiveDoc));
  const b = breaking(base, broken);
  if (b.status !== 1 || !b.output.includes("response-required-property-removed")) {
    throw new Error(`self-test (${label}) failed: removing a required response field was not detected\n${b.output}`);
  }
  const a = breaking(base, additive);
  if (a.status !== 0)
    throw new Error(`self-test (${label}) failed: an additive change was reported as breaking\n${a.output}`);
}

function selfTest(docs) {
  selfTestOne("public", docs["openapi/public.yaml"], "PaymentIntent", "amount_settled", "status");
  selfTestOne("events", docs["compat/events.yaml"], "Execution", "settled_amount", "state");
  selfTestOne("webhooks", docs["compat/webhooks.yaml"], "AgentPayment", "tx_hash", "status");
  console.log("compat self-test: breaking changes detected, additive changes accepted (public, events, webhooks)");
}

try {
  const docs = currentDocs();
  if (process.argv.includes("--update-baseline")) {
    rmSync(baselineDir, { recursive: true, force: true });
    for (const [name, path] of Object.entries(docs)) cpSync(path, join(baselineDir, name), { recursive: true });
    writeFileSync(
      join(baselineDir, "VERSION"),
      `${JSON.parse(readFileSync(join(root, "packages", "spec-public", "package.json"), "utf8")).version}\n`,
    );
    console.log(`baseline updated (${Object.keys(docs).length} documents)`);
  } else {
    selfTest(docs);
    if (!existsSync(baselineDir))
      throw new Error("no baseline: run `node test/compat/run.mjs --update-baseline` when releasing");
    const version = readFileSync(join(baselineDir, "VERSION"), "utf8").trim();
    let failed = false;
    const baselineFiles = [
      "openapi/public.yaml",
      ...readdirSync(join(baselineDir, "openapi", "internal")).map((f) => `openapi/internal/${f}`),
      ...readdirSync(join(baselineDir, "compat")).map((f) => `compat/${f}`),
    ];
    for (const name of baselineFiles) {
      const current = docs[name];
      if (!current) {
        console.error(`✗ ${name}: removed since ${version} (breaking)`);
        failed = true;
        continue;
      }
      const r = breaking(join(baselineDir, name), current);
      if (r.status === 0) console.log(`✓ ${name}`);
      else {
        console.error(`✗ ${name}: breaking changes since ${version}\n${r.output}`);
        failed = true;
      }
    }
    for (const name of Object.keys(docs))
      if (!baselineFiles.includes(name)) console.log(`+ ${name} (new since ${version})`);
    if (failed) process.exit(1);
    console.log(`compat: no breaking changes since ${version}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
