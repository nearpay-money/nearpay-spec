/**
 * The closed catalogue of error codes (architecture/api-conventions.md §6).
 *
 * Every route lists the codes it can return (`route().errors`); generic codes (authentication,
 * validation, idempotency, rate limits, server errors) apply to every route and are not repeated.
 * Each code has an HTTP status, an error `type`, a message template (`{name}` placeholders), an
 * example and a docs slug (`https://docs.nearpay.money/errors/<code>`).
 */

/** Error `type` values and their meaning (api-conventions §6). */
export const ERROR_TYPES = [
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "payment_error",
  "idempotency_error",
  "state_conflict",
  "rate_limit_error",
  "api_error",
  "rail_unavailable",
] as const;
export type ErrorType = (typeof ERROR_TYPES)[number];

export interface ErrorDefinition {
  readonly status: 400 | 401 | 402 | 403 | 404 | 409 | 410 | 422 | 429 | 500 | 502 | 503;
  readonly type: ErrorType;
  /** Message template; `{name}` placeholders are filled from the error's `params`. */
  readonly message: string;
  /** A rendered example message. */
  readonly example: string;
  /** Whether a client may retry the same request (with the same Idempotency-Key). */
  readonly retryable: boolean;
  /** Generic codes apply to every route and are not listed per route. */
  readonly generic?: true;
  /** Spec version that introduced the code. */
  readonly since: `${number}.${number}.${number}`;
}

const e = (d: Omit<ErrorDefinition, "since">): ErrorDefinition => ({ ...d, since: "0.1.0" });
/** Codes introduced with the Stage 2 contract freeze. */
const e2 = (d: Omit<ErrorDefinition, "since">): ErrorDefinition => ({ ...d, since: "0.2.0" });

export const ERRORS = {
  // ------------------------------------------------------------------ generic (every route)
  invalid_request: e({
    status: 400,
    type: "invalid_request_error",
    retryable: false,
    generic: true,
    message: "The request is invalid: {detail}",
    example: "The request is invalid: amount must be an integer.",
  }),
  resource_missing: e({
    status: 404,
    type: "invalid_request_error",
    retryable: false,
    generic: true,
    message: "No such {object}: {id}",
    example: "No such checkout_session: cs_01jbz9k3m4n5p6q7r8s9t0v1w2",
  }),
  authentication_required: e({
    status: 401,
    type: "authentication_error",
    retryable: false,
    generic: true,
    message: "This request needs a credential.",
    example: "This request needs a credential.",
  }),
  invalid_api_key: e({
    status: 401,
    type: "authentication_error",
    retryable: false,
    generic: true,
    message: "The API key is invalid, expired or revoked.",
    example: "The API key is invalid, expired or revoked.",
  }),
  permission_denied: e({
    status: 403,
    type: "permission_error",
    retryable: false,
    generic: true,
    message: "This credential is not allowed to {action}.",
    example: "This credential is not allowed to write checkout_sessions.",
  }),
  csrf_token_invalid: e({
    status: 403,
    type: "permission_error",
    retryable: false,
    generic: true,
    message: "The CSRF token is missing or does not match the session.",
    example: "The CSRF token is missing or does not match the session.",
  }),
  ip_not_allowed: e({
    status: 403,
    type: "permission_error",
    retryable: false,
    generic: true,
    message: "Requests with this API key are not allowed from {ip}.",
    example: "Requests with this API key are not allowed from 203.0.113.7.",
  }),
  account_suspended: e({
    status: 403,
    type: "permission_error",
    retryable: false,
    generic: true,
    message: "The account is suspended; live-mode changes are not allowed.",
    example: "The account is suspended; live-mode changes are not allowed.",
  }),
  step_up_required: e({
    status: 401,
    type: "authentication_error",
    retryable: false,
    generic: true,
    message: "This action needs a fresh passkey confirmation (step-up).",
    example: "This action needs a fresh passkey confirmation (step-up).",
  }),
  rate_limited: e({
    status: 429,
    type: "rate_limit_error",
    retryable: true,
    generic: true,
    message: "Too many requests; retry after {retry_after} seconds.",
    example: "Too many requests; retry after 2 seconds.",
  }),
  idempotency_key_reused: e({
    status: 409,
    type: "idempotency_error",
    retryable: false,
    generic: true,
    message: "This Idempotency-Key was used with a different request.",
    example: "This Idempotency-Key was used with a different request.",
  }),
  idempotency_in_progress: e({
    status: 409,
    type: "idempotency_error",
    retryable: true,
    generic: true,
    message: "A request with this Idempotency-Key is still in progress.",
    example: "A request with this Idempotency-Key is still in progress.",
  }),
  api_error: e({
    status: 500,
    type: "api_error",
    retryable: true,
    generic: true,
    message: "An internal error occurred; retry with the same Idempotency-Key.",
    example: "An internal error occurred; retry with the same Idempotency-Key.",
  }),

  // ------------------------------------------------------------------ state and mode
  state_conflict: e({
    status: 409,
    type: "state_conflict",
    retryable: false,
    message: "The {object} is {state}; this action is not allowed.",
    example: "The checkout_session is complete; this action is not allowed.",
  }),
  livemode_forbidden: e({
    status: 403,
    type: "permission_error",
    retryable: false,
    message: "This endpoint is available in test mode only.",
    example: "This endpoint is available in test mode only.",
  }),

  // ------------------------------------------------------------------ identity: auth
  link_expired: e({
    status: 410,
    type: "invalid_request_error",
    retryable: false,
    message: "The link has expired; request a new one.",
    example: "The link has expired; request a new one.",
  }),
  link_used: e({
    status: 410,
    type: "invalid_request_error",
    retryable: false,
    message: "The link was already used; request a new one.",
    example: "The link was already used; request a new one.",
  }),
  webauthn_failed: e({
    status: 400,
    type: "invalid_request_error",
    retryable: false,
    message: "The passkey operation could not be verified: {reason}",
    example: "The passkey operation could not be verified: challenge mismatch",
  }),
  invalid_client: e({
    status: 401,
    type: "authentication_error",
    retryable: false,
    message: "The service client credentials are invalid.",
    example: "The service client credentials are invalid.",
  }),
  turnstile_failed: e({
    status: 403,
    type: "permission_error",
    retryable: false,
    message: "The human-verification challenge failed; reload and try again.",
    example: "The human-verification challenge failed; reload and try again.",
  }),

  // ------------------------------------------------------------------ identity: account, keys, destinations
  invalid_setting: e({
    status: 400,
    type: "invalid_request_error",
    retryable: false,
    message: "The setting {setting} is not valid: {reason}",
    example: "The setting underpay_tolerance_bps is not valid: must be at most 100.",
  }),
  scope_unknown: e({
    status: 400,
    type: "invalid_request_error",
    retryable: false,
    message: "Unknown scope: {scope}",
    example: "Unknown scope: payments.write",
  }),
  address_invalid: e({
    status: 400,
    type: "invalid_request_error",
    retryable: false,
    message: "{address} is not a valid address on {chain}.",
    example: "0x12 is not a valid address on eip155:8453.",
  }),
  asset_unsupported: e({
    status: 400,
    type: "invalid_request_error",
    retryable: false,
    message: "The asset {asset_id} is not supported.",
    example: "The asset nep141:unknown.near is not supported.",
  }),
  memo_destination_unsupported: e({
    status: 400,
    type: "invalid_request_error",
    retryable: false,
    message: "Destinations that need a memo or tag are not supported.",
    example: "Destinations that need a memo or tag are not supported.",
  }),
  destination_in_use: e({
    status: 409,
    type: "state_conflict",
    retryable: false,
    message: "This address and asset are already registered as a settlement destination.",
    example: "This address and asset are already registered as a settlement destination.",
  }),
  recovery_lock: e({
    status: 403,
    type: "permission_error",
    retryable: false,
    message: "Settlement destinations cannot change until {until} after account recovery.",
    example: "Settlement destinations cannot change until 2026-11-07T10:00:00Z after account recovery.",
  }),
  screening_blocked: e({
    status: 402,
    type: "payment_error",
    retryable: false,
    message: "This address cannot be used.",
    example: "This address cannot be used.",
  }),
  attestation_invalid: e({
    status: 400,
    type: "invalid_request_error",
    retryable: false,
    message: "The ownership signature is not valid for this destination.",
    example: "The ownership signature is not valid for this destination.",
  }),
  challenge_expired: e({
    status: 410,
    type: "invalid_request_error",
    retryable: false,
    message: "The attestation challenge has expired or was used; request a new challenge for the destination.",
    example: "The attestation challenge has expired or was used; request a new challenge for the destination.",
  }),
  destination_not_active: e({
    status: 409,
    type: "state_conflict",
    retryable: false,
    message: "The settlement destination {destination} is not active.",
    example: "The settlement destination sd_01jbz9k3m4n5p6q7r8s9t0v1w2 is not active.",
  }),

  // ------------------------------------------------------------------ payments: merchant API
  account_not_live: e({
    status: 403,
    type: "permission_error",
    retryable: false,
    message: "Live mode is not enabled for this account ({missing}).",
    example: "Live mode is not enabled for this account (kyb).",
  }),
  amount_below_destination_minimum: e({
    status: 422,
    type: "invalid_request_error",
    retryable: false,
    message: "Amount must be at least {minimum} for destination {destination}.",
    example: "Amount must be at least 2.00 USD for destination sd_01jbz9k3m4n5p6q7r8s9t0v1w2 (USDC on Ethereum).",
  }),
  amount_above_unverified_cap: e({
    status: 422,
    type: "invalid_request_error",
    retryable: false,
    message: "Amount exceeds the {cap} per-payment cap of an unverified destination.",
    example: "Amount exceeds the 1,000.00 USD per-payment cap of an unverified destination.",
  }),
  currency_unsupported: e({
    status: 400,
    type: "invalid_request_error",
    retryable: false,
    message: "The currency {currency} is not supported.",
    example: "The currency eur is not supported.",
  }),
  allowed_origins_required: e({
    status: 400,
    type: "invalid_request_error",
    retryable: false,
    message: "Embedded sessions need allowed_origins (https origins).",
    example: "Embedded sessions need allowed_origins (https origins).",
  }),
  attempt_in_flight: e({
    status: 409,
    type: "state_conflict",
    retryable: false,
    message: "A payment for this session is already being processed.",
    example: "A payment for this session is already being processed.",
  }),

  // ------------------------------------------------------------------ payments: payer API
  client_secret_invalid: e({
    status: 401,
    type: "authentication_error",
    retryable: false,
    message: "The client secret does not match this checkout session.",
    example: "The client secret does not match this checkout session.",
  }),
  session_not_open: e({
    status: 409,
    type: "state_conflict",
    retryable: false,
    message: "This checkout session is no longer open.",
    example: "This checkout session is no longer open.",
  }),
  too_many_attempts: e({
    status: 429,
    type: "rate_limit_error",
    retryable: false,
    message: "Too many payment attempts for this checkout session.",
    example: "Too many payment attempts for this checkout session.",
  }),
  route_too_slow: e({
    status: 422,
    type: "invalid_request_error",
    retryable: false,
    message: "Payments from {chain} take too long to fit the time left in this session.",
    example:
      "Payments from bip122:000000000019d6689c085ae165831e93 take too long to fit the time left in this session.",
  }),
  refund_address_invalid: e({
    status: 400,
    type: "invalid_request_error",
    retryable: false,
    message: "The refund address is not a valid address on {chain}.",
    example: "The refund address is not a valid address on eip155:8453.",
  }),
  geo_blocked: e({
    status: 403,
    type: "permission_error",
    retryable: false,
    message: "Payments are not available in your region.",
    example: "Payments are not available in your region.",
  }),
  intent_invalid: e({
    status: 400,
    type: "invalid_request_error",
    retryable: false,
    message: "The signed intent does not match the payment requirement: {reason}",
    example: "The signed intent does not match the payment requirement: amount mismatch",
  }),
  insufficient_balance: e({
    status: 402,
    type: "payment_error",
    retryable: false,
    message: "The NEAR Intents balance is not enough for this payment.",
    example: "The NEAR Intents balance is not enough for this payment.",
  }),
  rail_unavailable: e({
    status: 503,
    type: "rail_unavailable",
    retryable: true,
    message: "Payments are temporarily unavailable ({reason}); try again shortly.",
    example: "Payments are temporarily unavailable (route provider); try again shortly.",
  }),

  // ------------------------------------------------------------------ rails (internal)
  route_unavailable: e({
    status: 422,
    type: "invalid_request_error",
    retryable: false,
    message: "No route from {origin_asset_id} to {destination_asset_id}.",
    example: "No route from nep141:a.near to nep141:b.near.",
  }),
  pricing_unavailable: e({
    status: 503,
    type: "rail_unavailable",
    retryable: true,
    message: "A reliable price for {asset_id} is not available right now.",
    example: "A reliable price for nep141:wrap.near is not available right now.",
  }),
  deadline_too_short: e({
    status: 422,
    type: "invalid_request_error",
    retryable: false,
    message: "The remaining time is shorter than the minimum deadline for {chain}.",
    example: "The remaining time is shorter than the minimum deadline for eip155:1.",
  }),
  quote_rejected: e({
    status: 422,
    type: "invalid_request_error",
    retryable: false,
    message: "The route provider rejected the quote: {provider_message}",
    example: "The route provider rejected the quote: Amount is too low for bridge.",
  }),
  quote_integrity_failed: e({
    status: 502,
    type: "api_error",
    retryable: true,
    message: "The route provider's quote failed NearPay's integrity checks.",
    example: "The route provider's quote failed NearPay's integrity checks.",
  }),

  // ------------------------------------------------------------------ sentinel
  ticket_invalid: e({
    status: 401,
    type: "authentication_error",
    retryable: false,
    message: "The attestation ticket is invalid or expired.",
    example: "The attestation ticket is invalid or expired.",
  }),
  attestation_refused: e({
    status: 409,
    type: "state_conflict",
    retryable: false,
    message: "These deposit instructions could not be verified; do not send funds.",
    example: "These deposit instructions could not be verified; do not send funds.",
  }),
  attestation_stale: e({
    status: 409,
    type: "state_conflict",
    retryable: false,
    message: "These deposit instructions have expired or settled; start a new payment.",
    example: "These deposit instructions have expired or settled; start a new payment.",
  }),
  attestation_unavailable: e({
    status: 503,
    type: "api_error",
    retryable: true,
    message: "Deposit instructions cannot be verified right now; try again shortly.",
    example: "Deposit instructions cannot be verified right now; try again shortly.",
  }),

  // ------------------------------------------------------------------ agentpay
  destination_not_intents_account: e({
    status: 409,
    type: "state_conflict",
    retryable: false,
    message: "Agent payments need a NEAR Intents account settlement destination for {asset_id}.",
    example:
      "Agent payments need a NEAR Intents account settlement destination for nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1.",
  }),
  amount_below_minimum: e({
    status: 422,
    type: "invalid_request_error",
    retryable: false,
    message: "Amount must be at least {minimum}.",
    example: "Amount must be at least 1000 base units.",
  }),

  // ------------------------------------------------------------------ compliance
  screening_unavailable: e({
    status: 503,
    type: "api_error",
    retryable: true,
    message: "Address screening is unavailable for this amount; try again shortly.",
    example: "Address screening is unavailable for this amount; try again shortly.",
  }),

  // ------------------------------------------------------------------ webhooks
  url_invalid: e({
    status: 400,
    type: "invalid_request_error",
    retryable: false,
    message: "The URL is not allowed: {reason}",
    example: "The URL is not allowed: https is required in live mode.",
  }),
  event_type_unknown: e({
    status: 400,
    type: "invalid_request_error",
    retryable: false,
    message: "Unknown event type: {type}",
    example: "Unknown event type: payment_intent.done",
  }),

  // stage 2 — identity-console
  // ------------------------------------------------------------------ identity: team, approvals, console
  last_owner: e2({
    status: 409,
    type: "state_conflict",
    retryable: false,
    message: "The account must keep at least one owner.",
    example: "The account must keep at least one owner.",
  }),
  member_exists: e2({
    status: 409,
    type: "state_conflict",
    retryable: false,
    message: "{email} is already a member of this account or has a pending invitation.",
    example: "ana@example.com is already a member of this account or has a pending invitation.",
  }),
  invitation_invalid: e2({
    status: 400,
    type: "invalid_request_error",
    retryable: false,
    message: "The invitation is invalid: {reason}",
    example: "The invitation is invalid: it was sent to another email address.",
  }),
  approver_conflict: e2({
    status: 403,
    type: "permission_error",
    retryable: false,
    message: "This approval needs a different approver: {reason}",
    example: "This approval needs a different approver: the requester cannot approve their own request.",
  }),
  two_person_required: e2({
    status: 409,
    type: "state_conflict",
    retryable: false,
    message: "This action needs a second approver; request it in the console.",
    example: "This action needs a second approver; request it in the console.",
  }),
  authenticator_not_allowed: e2({
    status: 403,
    type: "permission_error",
    retryable: false,
    message: "Console passkeys must be hardware security keys on the allow-list.",
    example: "Console passkeys must be hardware security keys on the allow-list.",
  }),
  // ------------------------------------------------------------------ compliance: KYB
  kyb_profile_incomplete: e2({
    status: 400,
    type: "invalid_request_error",
    retryable: false,
    message: "The business details are incomplete: {fields}",
    example: "The business details are incomplete: registration_number, business_address.",
  }),
  // stage 2 — payments
  intent_not_succeeded: e2({
    status: 409,
    type: "state_conflict",
    retryable: false,
    message: "Payment intent {payment_intent} has no accepted settlement to refund (status {status}).",
    example: "Payment intent pi_01jbz9k3m4n5p6q7r8s9t0v1w2 has no accepted settlement to refund (status processing).",
  }),
  attempt_not_settled: e2({
    status: 409,
    type: "state_conflict",
    retryable: false,
    message: "Payment attempt {payment_attempt} has no verified settlement to refund.",
    example: "Payment attempt pa_01jbz9k3m4n5p6q7r8s9t0v1w2 has no verified settlement to refund.",
  }),
  amount_exceeds_refundable: e2({
    status: 422,
    type: "invalid_request_error",
    retryable: false,
    message: "Amount {amount} exceeds the refundable amount {refundable} (base units of {asset_id}).",
    example:
      "Amount 3000000 exceeds the refundable amount 2000042 (base units of nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1).",
  }),
  leg_expired: e2({
    status: 409,
    type: "state_conflict",
    retryable: false,
    message: "The refund's current leg expired at {deadline}; prepare a new leg and sign that one.",
    example: "The refund's current leg expired at 2026-11-07T10:30:00.000Z; prepare a new leg and sign that one.",
  }),
  signed_intent_mismatch: e2({
    status: 422,
    type: "invalid_request_error",
    retryable: false,
    message: "The signed payload does not match the refund's next action: {detail}",
    example: "The signed payload does not match the refund's next action: nonce differs.",
  }),
  review_requires_evidence: e2({
    status: 409,
    type: "state_conflict",
    retryable: false,
    message: "Payment intent {payment_intent} is held for verification; it can be accepted only once evidence arrives.",
    example:
      "Payment intent pi_01jbz9k3m4n5p6q7r8s9t0v1w2 is held for verification; it can be accepted only once evidence arrives.",
  }),
  link_inactive: e2({
    status: 410,
    type: "invalid_request_error",
    retryable: false,
    message: "This payment link is no longer accepting payments.",
    example: "This payment link is no longer accepting payments.",
  }),
  customer_deleted: e2({
    status: 409,
    type: "state_conflict",
    retryable: false,
    message: "Customer {customer} is deleted.",
    example: "Customer cus_01jbz9k3m4n5p6q7r8s9t0v1w2 is deleted.",
  }),
  reconciliation_day_open: e2({
    status: 422,
    type: "invalid_request_error",
    retryable: false,
    message: "Day {day} has not ended (UTC); reconcile only completed days.",
    example: "Day 2026-11-07 has not ended (UTC); reconcile only completed days.",
  }),
  // stage 2 — rails-fx
  fx_rate_unavailable: e2({
    status: 503,
    type: "rail_unavailable",
    retryable: true,
    message: "A current exchange rate for {currency} is not available right now.",
    example: "A current exchange rate for eur is not available right now.",
  }),
} as const satisfies Record<string, ErrorDefinition>;

export type ErrorCode = keyof typeof ERRORS;

export const ERROR_CODES = Object.keys(ERRORS) as [ErrorCode, ...ErrorCode[]];

/** Codes that apply to every route. */
export const GENERIC_ERROR_CODES = ERROR_CODES.filter((c) => (ERRORS[c] as ErrorDefinition).generic === true);

/** Documentation URL of an error code. */
export function errorDocUrl(code: ErrorCode): string {
  return `https://docs.nearpay.money/errors/${code}`;
}

/** Fills `{name}` placeholders of a code's message template. Missing params are left visible. */
export function renderErrorMessage(code: ErrorCode, params: Record<string, string | number> = {}): string {
  return ERRORS[code].message.replace(/\{([a-z_]+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}
