/** Error envelope (architecture/api-conventions.md §6), shared by public and internal APIs. */
import { ERROR_CODES, ERROR_TYPES } from "../errors/catalogue.js";
import { RequestId } from "./ids.js";
import { openEnum, out, z } from "./schema.js";

export const ErrorCodeSchema = openEnum(ERROR_CODES, "Machine-readable error code from the error catalogue.");
export const ErrorTypeSchema = openEnum(ERROR_TYPES, "Error category; decides whether a retry can help.");

export const ErrorBody = out({
  type: ErrorTypeSchema,
  code: ErrorCodeSchema,
  message: z.string().describe("Human-readable message; safe to show to developers, not to payers."),
  param: z.string().optional().describe("The request parameter the error relates to, when there is one."),
  doc_url: z.url().describe("Documentation page for this error code."),
  request_id: RequestId,
}).meta({ id: "ErrorBody", description: "Details of a failed request." });

export const ErrorEnvelope = out({ error: ErrorBody }).meta({
  id: "Error",
  description: "Envelope returned with every non-2xx response.",
});

export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
