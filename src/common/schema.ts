/**
 * Schema-construction helpers shared by every contract module.
 *
 * Conventions (nearpay-brain/architecture/api-conventions.md, lld/00-foundations.md §3):
 * - Request bodies and query strings are strict: unknown parameters are rejected (`invalid_request`).
 * - Response objects, events and webhook payloads are loose: consumers MUST tolerate unknown fields.
 * - Every field carries `.describe()`; `test/describe.test.ts` enforces it.
 * - Enums that may gain values within a version are declared with `openEnum()`; they are emitted as
 *   `x-extensible-enum` so the compatibility check treats new values as additive.
 */
import { z } from "zod";

export { z };

/** Response / event / webhook object. Unknown fields are allowed (forward compatible). */
export function out<T extends z.ZodRawShape>(shape: T) {
  return z.looseObject(shape);
}

/** Request body or query object. Unknown parameters are rejected. */
export function inp<T extends z.ZodRawShape>(shape: T) {
  return z.strictObject(shape);
}

/** Metadata key marking an enum as open: new values may be added without a new version. */
export const OPEN_ENUM_KEY = "x-extensible-enum" as const;

/**
 * An enum whose value set may grow within a version (statuses, event types, error codes).
 * Clients MUST tolerate unknown values (api-conventions §5).
 */
export function openEnum<const T extends readonly [string, ...string[]]>(values: T, description: string) {
  return z.enum(values).meta({ [OPEN_ENUM_KEY]: true, description });
}

/** A closed enum: adding a value is a breaking change and needs a new version. */
export function closedEnum<const T extends readonly [string, ...string[]]>(values: T, description: string) {
  return z.enum(values).meta({ description });
}

/** True when the schema was declared with `openEnum()`. */
export function isOpenEnum(schema: z.ZodType): boolean {
  return z.globalRegistry.get(schema)?.[OPEN_ENUM_KEY] === true;
}
