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
