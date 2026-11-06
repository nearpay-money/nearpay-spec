/**
 * Tolerant parsing of open enums for clients and SDKs (api-conventions §5: clients MUST tolerate
 * unknown enum values; foundations §3).
 *
 * `openEnum()` schemas stay strict `z.enum`s: servers validate what they produce and the typed
 * unions are unchanged. A client that parses responses, events or webhook payloads with the spec
 * schemas calls `safeParseTolerant(schema, input)` instead of `schema.safeParse(input)`: a string
 * that an **open** enum does not know is accepted, kept verbatim in the result and reported in
 * `unknown`. Everything else (closed enums, literals, types, formats, missing fields) still fails.
 *
 * Typing: `data` is typed as `z.output<T>`, so an open-enum field may at run time hold a string
 * outside its declared union (listed in `unknown`). Handle it with a `default` branch.
 */
import { isOpenEnum, z } from "./schema.js";

/** A value an open enum did not know, accepted by a tolerant parse. */
export interface UnknownEnumValue {
  /** Path of the value in the parsed data. */
  readonly path: readonly PropertyKey[];
  /** The value as received. */
  readonly value: string;
}

export type TolerantParseResult<T> =
  | { readonly success: true; readonly data: T; readonly unknown: readonly UnknownEnumValue[] }
  | { readonly success: false; readonly error: z.ZodError };

/** Message marking an issue raised by an open enum on an unknown string value. */
const OPEN_ENUM_MISS = "\u0000nearpay:open-enum-unknown-value";
/** Each round replaces the unknown values one union level deeper; real payloads need one or two. */
const MAX_ROUNDS = 8;

const markOpenEnumMisses: z.core.$ZodErrorMap = (iss) => {
  const inst = (iss as { inst?: unknown }).inst;
  if (iss.code === "invalid_value" && typeof iss.input === "string" && inst instanceof z.ZodType && isOpenEnum(inst))
    return OPEN_ENUM_MISS;
  return undefined;
};

interface Replacement {
  readonly path: readonly PropertyKey[];
  readonly placeholder: string;
}

/** Replacements that would clear every issue, or null if some issue is not an open-enum miss. */
function replacementsFor(issues: readonly z.core.$ZodIssue[], prefix: readonly PropertyKey[]): Replacement[] | null {
  const out: Replacement[] = [];
  for (const iss of issues) {
    const path = [...prefix, ...iss.path];
    if (iss.code === "invalid_value" && iss.message === OPEN_ENUM_MISS && typeof iss.values[0] === "string") {
      out.push({ path, placeholder: iss.values[0] });
    } else if (iss.code === "invalid_union" && iss.errors.length > 0) {
      // A union is tolerable when one branch fails only on open-enum misses; take the first such branch.
      const branch = iss.errors.map((b) => (b.length > 0 ? replacementsFor(b, path) : null)).find((r) => r !== null);
      if (!branch) return null;
      out.push(...branch);
    } else {
      return null;
    }
  }
  return out;
}

function getAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let node = root;
  for (const k of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<PropertyKey, unknown>)[k];
  }
  return node;
}

/** Sets a value in place; false when the path does not lead to an existing string. */
function setAt(root: unknown, path: readonly PropertyKey[], value: string): boolean {
  if (path.length === 0) return false;
  const parent = getAt(root, path.slice(0, -1));
  const key = path[path.length - 1] as PropertyKey;
  if (parent === null || typeof parent !== "object") return false;
  if (typeof (parent as Record<PropertyKey, unknown>)[key] !== "string") return false;
  (parent as Record<PropertyKey, unknown>)[key] = value;
  return true;
}

/**
 * Parses like `schema.safeParse(input)`, except that unknown string values of open enums are
 * accepted and kept (see the module comment). The input is never mutated.
 */
export function safeParseTolerant<T extends z.ZodType>(schema: T, input: unknown): TolerantParseResult<z.output<T>> {
  const fail = (): TolerantParseResult<z.output<T>> => {
    const plain = schema.safeParse(input);
    return plain.success
      ? { success: true, data: plain.data, unknown: [] }
      : { success: false, error: plain.error as z.ZodError };
  };
  let working: unknown = input;
  const unknown: UnknownEnumValue[] = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const r = schema.safeParse(working, { error: markOpenEnumMisses });
    if (r.success) {
      if (unknown.length === 0) return { success: true, data: r.data, unknown };
      // Root-level misses (the schema itself is an open enum) return the received value directly.
      const root = unknown.find((u) => u.path.length === 0);
      if (root) return { success: true, data: root.value as z.output<T>, unknown };
      for (const u of unknown) if (!setAt(r.data, u.path, u.value)) return fail();
      return { success: true, data: r.data, unknown };
    }
    const reps = replacementsFor(r.error.issues, []);
    if (!reps || reps.length === 0) return fail();
    if (working === input) working = structuredClone(input);
    for (const rep of reps) {
      if (rep.path.length === 0) {
        unknown.push({ path: [], value: working as string });
        working = rep.placeholder;
        continue;
      }
      const value = getAt(working, rep.path);
      if (typeof value !== "string" || !setAt(working, rep.path, rep.placeholder)) return fail();
      unknown.push({ path: rep.path, value });
    }
  }
  return fail();
}

/** Like `schema.parse(input)` with open-enum tolerance; throws the `ZodError` of a strict parse. */
export function parseTolerant<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const r = safeParseTolerant(schema, input);
  if (!r.success) throw r.error;
  return r.data;
}
