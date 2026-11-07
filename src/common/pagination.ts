/** Cursor pagination (api-conventions §2, foundations §10). */

import { UnixTime } from "./primitives.js";
import { inp, out, z } from "./schema.js";

const Limit = z.coerce
  .number()
  .int()
  .min(1)
  .max(100)
  .default(10)
  .describe("Number of objects to return, 1–100 (default 10).");

/** Shape for list query strings; spread into a route's query object. */
export const listQueryShape = {
  limit: Limit,
  starting_after: z.string().max(64).optional().describe("Cursor: id of the last object of the previous page."),
  ending_before: z.string().max(64).optional().describe("Cursor: id of the first object of the next page."),
};

/** Query string accepted by every list endpoint. */
export const ListQuery = inp(listQueryShape);

/** `created[gte]` / `created[lte]` filters (unix seconds). */
export const createdFilterShape = {
  "created[gte]": z.coerce.number().pipe(UnixTime).optional().describe("Only objects created at or after this time."),
  "created[lte]": z.coerce.number().pipe(UnixTime).optional().describe("Only objects created at or before this time."),
};

/** Paginated list of objects, ordered by `(created desc, id desc)`. */
export function listOf<T extends z.ZodType>(item: T, id: string, description: string) {
  return out({
    object: z.literal("list").describe("Always `list`."),
    data: z.array(item).describe("Objects on this page."),
    has_more: z.boolean().describe("Whether more objects exist after this page."),
    url: z.string().describe("Path of this list endpoint."),
  }).meta({ id, description });
}

// stage 2 — payments
// ---------------------------------------------------------------------------------------------
// `metadata[key]=value` list filters (ADR-0018 §2). Query strings arrive as flat keys
// (`metadata[order_id]=42`), so the query object accepts extra keys of exactly that form.
// `codegen/emit.ts` documents them as one `deepObject` parameter named `metadata`.
// ---------------------------------------------------------------------------------------------

/** Metadata key marking a list query that accepts `metadata[key]=value` filters. */
export const METADATA_FILTER_KEY = "x-nearpay-metadata-filter" as const;
/** Most `metadata[…]` filters one request may combine. */
export const MAX_METADATA_FILTERS = 10;
const METADATA_FILTER_RE = /^metadata\[([^[\]]{1,40})\]$/;

/**
 * Adds `metadata[key]=value` filters to a strict list query: every extra key must have that form
 * (key 1–40 chars, value ≤ 500 chars, at most 10); any other unknown key is still rejected.
 */
export function withMetadataFilter<T extends z.ZodRawShape>(shape: T) {
  return z
    .strictObject(shape)
    .catchall(z.string().max(500).describe("Metadata value to match exactly."))
    .superRefine((v, ctx) => {
      let n = 0;
      for (const k of Object.keys(v)) {
        if (k in shape) continue;
        if (!METADATA_FILTER_RE.test(k)) {
          ctx.addIssue({ code: "custom", path: [k], message: "unknown query parameter" });
          continue;
        }
        n++;
      }
      if (n > MAX_METADATA_FILTERS)
        ctx.addIssue({ code: "custom", path: [], message: `at most ${MAX_METADATA_FILTERS} metadata filters` });
    })
    .meta({ [METADATA_FILTER_KEY]: true });
}

/** True when a query schema was built with `withMetadataFilter()`. */
export function hasMetadataFilter(schema: z.ZodType): boolean {
  return z.globalRegistry.get(schema)?.[METADATA_FILTER_KEY] === true;
}

/** Extracts `{key: value}` from the `metadata[key]` entries of a parsed query. */
export function metadataFilters(query: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) {
    const m = METADATA_FILTER_RE.exec(k);
    if (m && typeof v === "string") out[m[1] as string] = v;
  }
  return out;
}
