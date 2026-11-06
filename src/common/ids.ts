/**
 * Prefixed identifiers (lld/00-foundations.md §5, architecture/domain-model.md §1).
 *
 * Format: `<prefix>_<26 chars>` where the suffix is a UUIDv7 encoded with the TypeID
 * base32 scheme (lower-case Crockford alphabet, 130 bits with the two high bits zero, so the
 * first character is 0-7). `@nearpay-internal/ids` implements encode/decode; this module only
 * validates the wire format.
 */
import { z } from "./schema.js";

/** Lower-case Crockford base32 alphabet used by TypeID. */
export const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Every prefix NearPay issues, with the object it names and the owning service. */
export const ID_PREFIXES = {
  acct: { object: "account", owner: "identity" },
  usr: { object: "user", owner: "identity" },
  key: { object: "api_key", owner: "identity" },
  sd: { object: "settlement_destination", owner: "identity" },
  chl: { object: "attestation_challenge", owner: "identity" },
  fs: { object: "fee_schedule", owner: "identity" },
  ses: { object: "session", owner: "identity" },
  cs: { object: "checkout_session", owner: "payments" },
  pi: { object: "payment_intent", owner: "payments" },
  pa: { object: "payment_attempt", owner: "payments" },
  re: { object: "refund", owner: "payments" },
  plink: { object: "payment_link", owner: "payments" },
  cus: { object: "customer", owner: "payments" },
  txn: { object: "balance_transaction", owner: "payments" },
  prod: { object: "product", owner: "billing" },
  price: { object: "price", owner: "billing" },
  in: { object: "invoice", owner: "billing" },
  sub: { object: "subscription", owner: "billing" },
  md: { object: "mandate", owner: "billing" },
  ex: { object: "execution", owner: "rails" },
  obs: { object: "provider_observation", owner: "rails" },
  ap: { object: "agent_payment", owner: "agentpay" },
  evt: { object: "event", owner: "webhooks" },
  we: { object: "webhook_endpoint", owner: "webhooks" },
  whd: { object: "webhook_delivery", owner: "webhooks" },
  case: { object: "compliance_case", owner: "compliance" },
  pol: { object: "geo_policy", owner: "compliance" },
  scr: { object: "screening", owner: "compliance" },
  fnd: { object: "audit_finding", owner: "sentinel" },
  ks: { object: "kill_switch", owner: "sentinel" },
  msg: { object: "message", owner: "notify" },
  req: { object: "request", owner: "gateway" },
  job: { object: "job", owner: "any" },
} as const;

export type IdPrefix = keyof typeof ID_PREFIXES;

/** Regular expression for an ID with the given prefix. */
export function idPattern(prefix: IdPrefix): RegExp {
  return new RegExp(`^${prefix}_[0-7][${ID_ALPHABET}]{25}$`);
}

/** Example ID used in generated documentation. */
export function exampleId(prefix: IdPrefix): string {
  return `${prefix}_01jbz9k3m4n5p6q7r8s9t0v1w2`;
}

/** Schema for an ID with the given prefix. */
export function id<P extends IdPrefix>(prefix: P, description?: string) {
  return z
    .string()
    .regex(idPattern(prefix), `must be a ${ID_PREFIXES[prefix].object} id (${prefix}_…)`)
    .meta({
      description: description ?? `${ID_PREFIXES[prefix].object} id (\`${prefix}_\` + 26 base32 chars).`,
      examples: [exampleId(prefix)],
    }) as unknown as z.ZodType<`${P}_${string}`, string>;
}

/** Request ID returned in `X-Request-Id` and in error envelopes. */
export const RequestId = id("req", "Request id, also returned in the `X-Request-Id` header.");

/** Raw UUID (internal wire format for event envelopes and database keys). */
export const Uuid = z.uuid().describe("UUID (RFC 9562).");
