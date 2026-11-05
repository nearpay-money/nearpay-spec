/** Foundations §3: every schema field has `.describe()`. */
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { envelopeOf, INTERNAL_ROUTES, SUBJECTS, type Subject } from "../src/internal-entry.js";
import { type AnyRoute, PUBLIC_ROUTES, WEBHOOK_TYPES } from "../src/public-entry.js";
import { toJsonSchema, walkObjects } from "./helpers.js";

function undocumented(schema: z.ZodType, io: "input" | "output"): string[] {
  const missing: string[] = [];
  const js = toJsonSchema(schema, io);
  const defs = (js.$defs ?? {}) as Record<string, Record<string, unknown>>;
  walkObjects(js, (obj, path) => {
    for (const [name, prop] of Object.entries(obj.properties as Record<string, Record<string, unknown>>)) {
      const ref = typeof prop.$ref === "string" ? defs[prop.$ref.split("/").pop() as string] : undefined;
      const anyOfRef = Array.isArray(prop.anyOf)
        ? (prop.anyOf as Record<string, unknown>[]).find((x) => typeof x.$ref === "string")
        : undefined;
      const anyOfDef = anyOfRef ? defs[(anyOfRef.$ref as string).split("/").pop() as string] : undefined;
      const described =
        typeof prop.description === "string" ||
        typeof ref?.description === "string" ||
        typeof anyOfDef?.description === "string" ||
        (Array.isArray(prop.anyOf) &&
          (prop.anyOf as Record<string, unknown>[]).some((x) => typeof x.description === "string"));
      if (!described) missing.push(`${path}.${name}`);
    }
  });
  return missing;
}

function routeSchemas(r: AnyRoute): [string, z.ZodType, "input" | "output"][] {
  const out: [string, z.ZodType, "input" | "output"][] = [];
  if (r.params) out.push(["params", r.params, "input"]);
  if (r.query) out.push(["query", r.query, "input"]);
  if (r.body) out.push(["body", r.body, "input"]);
  if (r.headers) out.push(["headers", r.headers, "input"]);
  if (r.response) out.push(["response", r.response, "output"]);
  if (r.responseHeaders) out.push(["responseHeaders", r.responseHeaders, "output"]);
  if (r.stream) for (const [n, s] of Object.entries(r.stream.events)) out.push([`sse:${n}`, s, "output"]);
  return out;
}

describe("the describe check itself", () => {
  it("flags an undocumented field and accepts a documented one", async () => {
    const { z } = await import("zod");
    expect(undocumented(z.object({ a: z.string() }), "output")).toEqual(["#.a"]);
    expect(undocumented(z.object({ a: z.string().describe("A.") }), "output")).toEqual([]);
    expect(undocumented(z.object({ o: z.object({ b: z.int() }).describe("O.") }), "output")).toEqual([
      "#.properties.o.b",
    ]);
  });
});

describe("every field is described", () => {
  for (const r of [...PUBLIC_ROUTES, ...INTERNAL_ROUTES]) {
    it(`${r.method} ${r.path}`, () => {
      for (const [part, schema, io] of routeSchemas(r)) {
        expect(undocumented(schema, io), `${r.id} ${part}`).toEqual([]);
      }
    });
  }
  for (const subject of Object.keys(SUBJECTS) as Subject[]) {
    it(subject, () => expect(undocumented(envelopeOf(subject), "output")).toEqual([]));
  }
  for (const [type, def] of Object.entries(WEBHOOK_TYPES)) {
    it(`webhook ${type}`, () => expect(undocumented(def.object, "output")).toEqual([]));
  }
});
