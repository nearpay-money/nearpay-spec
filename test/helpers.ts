import { z } from "zod";

type Json = Record<string, unknown>;

/** Visits every object schema (with `properties`) inside a JSON Schema, following local $refs once. */
export function walkObjects(root: Json, visit: (obj: Json, path: string) => void): void {
  const defs = { ...((root.$defs as Json) ?? {}), ...((root.definitions as Json) ?? {}) };
  const seen = new Set<unknown>();
  const go = (node: unknown, path: string): void => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    const n = node as Json;
    if (typeof n.$ref === "string") {
      const name = n.$ref.split("/").pop() as string;
      go(defs[name], `${path}→${name}`);
    }
    if (n.properties && typeof n.properties === "object") visit(n, path);
    for (const [k, v] of Object.entries(n)) {
      if (k === "$defs" || k === "definitions") continue;
      if (Array.isArray(v)) {
        for (const [i, x] of v.entries()) go(x, `${path}.${k}[${i}]`);
      } else go(v, `${path}.${k}`);
    }
  };
  go(root, "#");
  for (const [name, d] of Object.entries(defs)) go(d, `#/$defs/${name}`);
}

export function toJsonSchema(schema: z.ZodType, io: "input" | "output"): Json {
  return z.toJSONSchema(schema, { io, unrepresentable: "any" }) as Json;
}

/** Collects every property name used anywhere in a JSON Schema. */
export function propertyNames(root: Json): Set<string> {
  const names = new Set<string>();
  walkObjects(root, (obj) => {
    for (const k of Object.keys(obj.properties as Json)) names.add(k);
  });
  return names;
}
