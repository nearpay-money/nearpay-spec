/**
 * `NearPay-Signature` header format (api-conventions §9, lld/webhooks.md §6). Pure string
 * functions; HMAC/Ed25519 live in the signer (webhooks) and verifiers (`@nearpay/node`).
 *
 *   t=<unix>,v1=<hex hmac-sha256>[,v1=<hex for the secondary secret>],v1a=<base64url ed25519>,kid=<kid>
 *
 * Both signatures cover the UTF-8 bytes of `<t>.<raw body>`; receivers MUST verify the raw body.
 */

/** Default tolerance between `t` and the receiver's clock, seconds. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export interface ParsedSignatureHeader {
  readonly timestamp: number;
  /** One HMAC per active endpoint secret (two during rotation). */
  readonly v1: readonly string[];
  /** Ed25519 signature (base64url), if present. */
  readonly v1a: string | null;
  readonly kid: string | null;
}

/** The exact string both signatures cover. */
export function signedPayload(timestamp: number, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/** Builds the header value. */
export function formatSignatureHeader(h: {
  timestamp: number;
  v1: readonly string[];
  v1a?: string | null;
  kid?: string | null;
}): string {
  if (!Number.isSafeInteger(h.timestamp) || h.timestamp < 0) throw new Error("timestamp must be unix seconds");
  if (h.v1.length === 0) throw new Error("at least one v1 signature is required");
  const parts = [`t=${h.timestamp}`, ...h.v1.map((s) => `v1=${s}`)];
  if (h.v1a) parts.push(`v1a=${h.v1a}`);
  if (h.kid) parts.push(`kid=${h.kid}`);
  return parts.join(",");
}

/** Parses the header; returns null when it is malformed (receivers reject the delivery). */
export function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  let timestamp: number | null = null;
  const v1: string[] = [];
  let v1a: string | null = null;
  let kid: string | null = null;
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) return null;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (v === "") return null;
    if (k === "t") {
      if (!/^\d{1,15}$/.test(v) || timestamp !== null) return null;
      timestamp = Number(v);
    } else if (k === "v1") {
      if (!/^[0-9a-f]{64}$/.test(v)) return null;
      v1.push(v);
    } else if (k === "v1a") {
      if (!/^[A-Za-z0-9_-]{86}$/.test(v) || v1a !== null) return null;
      v1a = v;
    } else if (k === "kid") {
      if (kid !== null) return null;
      kid = v;
    }
    // unknown keys are ignored (forward compatible)
  }
  if (timestamp === null || v1.length === 0) return null;
  return { timestamp, v1, v1a, kid };
}
