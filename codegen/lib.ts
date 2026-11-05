/** Shared helpers for code generation (emit, vectors, compat). */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringify } from "yaml";

export const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/**
 * Open enums are authored as `enum` + `x-extensible-enum: true`. Emitted artifacts carry
 * `x-extensible-enum: [values]` and no `enum`, so validators accept new values and oasdiff treats
 * additions as non-breaking.
 */
export function rewriteOpenEnums(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteOpenEnums);
  if (node === null || typeof node !== "object") return node;
  const o = node as Record<string, unknown>;
  const outObj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) outObj[k] = rewriteOpenEnums(v);
  if (outObj["x-extensible-enum"] === true && Array.isArray(outObj.enum)) {
    outObj["x-extensible-enum"] = outObj.enum;
    delete outObj.enum;
  }
  return outObj;
}

/** Recursively sorts object keys (stable output, minimal diffs). Arrays keep their order. */
export function sortKeys(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sortKeys);
  if (node === null || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.keys(node as object)
      .sort()
      .map((k) => [k, sortKeys((node as Record<string, unknown>)[k])]),
  );
}

export function toYaml(doc: unknown): string {
  return stringify(doc, { lineWidth: 0, aliasDuplicateObjects: false });
}

export function toJson(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export interface Output {
  readonly path: string;
  readonly content: string;
}

/**
 * Writes outputs, or in `check` mode compares them with what is on disk and returns the
 * paths that differ (generated files must be committed up to date).
 */
export function writeOutputs(outputs: readonly Output[], check: boolean): string[] {
  const stale: string[] = [];
  for (const o of outputs) {
    const abs = `${ROOT}/${o.path}`;
    if (check) {
      let current = "";
      try {
        current = readFileSync(abs, "utf8");
      } catch {
        /* missing */
      }
      if (current !== o.content) stale.push(o.path);
    } else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, o.content);
    }
  }
  return stale;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
