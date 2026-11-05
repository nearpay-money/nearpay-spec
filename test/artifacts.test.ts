/** Generated artifacts are valid per the official OpenAPI 3.1 and AsyncAPI 3.0 schemas, and current. */
import { readdirSync, readFileSync } from "node:fs";
import { Parser } from "@asyncapi/parser";
import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { outputs } from "../codegen/emit.js";
import { vectorOutputs } from "../codegen/vectors.js";

const root = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(`${root}${p}`, "utf8");

describe("generated artifacts", () => {
  const openapiFiles = [
    "openapi/public.yaml",
    ...readdirSync(`${root}openapi/internal`).map((f) => `openapi/internal/${f}`),
  ];
  for (const f of openapiFiles) {
    it(`${f} is valid OpenAPI 3.1`, async () => {
      const v = new Validator();
      const res = await v.validate(parse(read(f)));
      expect(res.errors ?? [], f).toEqual([]);
      expect(res.valid).toBe(true);
    });
  }

  it("asyncapi/events.yaml is valid AsyncAPI 3.0 with no errors", async () => {
    const parser = new Parser();
    const { diagnostics, document } = await parser.parse(read("asyncapi/events.yaml"));
    const errors = diagnostics.filter((d) => d.severity === 0);
    expect(errors.map((d) => `${d.path.join(".")}: ${d.message}`)).toEqual([]);
    expect(document?.channels().length).toBeGreaterThan(30);
  });

  it("committed generated files and vectors are up to date", () => {
    for (const o of [...outputs(), ...vectorOutputs()]) expect(read(o.path), o.path).toBe(o.content);
  });

  it("no stale generated files are left behind", () => {
    const expected = new Set(outputs().map((o) => o.path));
    const onDisk = [
      ...readdirSync(`${root}openapi/internal`).map((f) => `openapi/internal/${f}`),
      ...["events", "webhooks", "x402", "intents"].flatMap((d) =>
        readdirSync(`${root}schemas/${d}`).map((f) => `schemas/${d}/${f}`),
      ),
    ];
    expect(onDisk.filter((p) => !expected.has(p))).toEqual([]);
  });
});
