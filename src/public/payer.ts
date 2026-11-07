/**
 * Payer API used by the checkout SPA (lld/payments.md §6.2, lld/checkout-and-js.md §5).
 * Anonymous at the gateway; authenticated by the session's client secret in
 * `X-NearPay-Client-Secret`. Responses carry no PII and never the raw destination address.
 * Times are RFC 3339 strings here (they are compared with sentinel attestations).
 */
import { id } from "../common/ids.js";
import {
  AssetId,
  BaseUnits,
  ChainAddress,
  ChainId,
  Livemode,
  NearAccountId,
  Timestamp,
  TxHash,
  Url,
} from "../common/primitives.js";
import { route } from "../common/route.js";
import { closedEnum, inp, openEnum, out, z } from "../common/schema.js";
import { IntentsRequirement, MultiPayload } from "../intents/payloads.js";
import { SettlementDestinationType } from "./identity.js";
import {
  AttemptMethod,
  AttemptStatus,
  CheckoutSessionStatus,
  IntentStatus,
  PricingAmount,
  PricingCurrency,
  UiMode,
} from "./payments.js";

export const ClientSecretHeaders = inp({
  "x-nearpay-client-secret": z
    .string()
    .regex(/^cs_[0-9a-z]{26}_secret_[0-9A-Za-z]{32}$/)
    .describe("Client secret of the checkout session (from the URL fragment)."),
});

/** Ed25519 ticket that lets checkout ask sentinel for a co-signature (L-SN-03). */
export const AttestationTicket = z
  .string()
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  .describe("`base64url(JCS payload).base64url(Ed25519 signature)` issued by payments; pass it to sentinel unchanged.");

export const DepositInstructions = out({
  address: ChainAddress.describe("1Click deposit address."),
  memo: z.string().nullable().describe("Memo the deposit must carry, if any."),
  amount_in: BaseUnits.describe("Amount to send, base units of the origin asset."),
  min_amount_in: BaseUnits.describe("Minimum the provider accepts; below it the deposit is refunded."),
  deadline: Timestamp.describe("Send before this time; later deposits are refunded."),
  chain: ChainId.describe("Chain to send on."),
  origin_asset_id: AssetId.describe("Asset to send."),
}).meta({
  id: "DepositInstructions",
  description: "Where and how much the payer sends (render only after sentinel attestation).",
});

export const PayerAttempt = out({
  id: id("pa"),
  object: z.literal("payment_attempt").describe("Always `payment_attempt`."),
  livemode: Livemode,
  status: AttemptStatus,
  method: AttemptMethod,
  visible: z.boolean().describe('False once a newer attempt replaced it ("don\'t send again").'),
  origin_asset_id: AssetId.describe("Asset the payer pays with."),
  deposit: DepositInstructions.nullable().describe("Deposit instructions (`route_quote`)."),
  intents_requirement: IntentsRequirement.nullable().describe("What to sign (`intents_transfer`)."),
  attestation_ticket: AttestationTicket.nullable().describe(
    "Ticket for sentinel; present while instructions are live.",
  ),
  failure_code: z.string().nullable().describe("Reason the attempt failed or was refunded."),
  refunded_amount: BaseUnits.nullable().describe("Amount the provider refunded to the payer, if any."),
}).meta({ id: "PayerAttempt", description: "A payment attempt as the payer sees it." });

export const PublicCheckoutSession = out({
  id: id("cs"),
  object: z.literal("checkout_session").describe("Always `checkout_session`."),
  livemode: Livemode,
  status: CheckoutSessionStatus,
  payment_intent: id("pi", "Payment intent of this session (embedded checkout reports it in `np:complete`)."),
  intent_status: IntentStatus,
  amount: PricingAmount,
  currency: PricingCurrency,
  asset_id: AssetId.nullable().describe("Pricing asset when `currency` is `asset`."),
  display: out({
    merchant_name_unverified: z
      .string()
      .describe("Merchant display name (not authenticated; the attested name comes from sentinel)."),
    description: z.string().nullable().describe("Payment description."),
  }).describe("What the payer is paying for."),
  expires_at: Timestamp.describe("When the session stops accepting new payments."),
  settlement: out({
    asset_id: AssetId.describe("Asset the merchant receives."),
    chain: ChainId.describe("Chain the merchant receives on."),
    type: SettlementDestinationType,
  }).describe("How the merchant is paid (never the raw address)."),
  ui_mode: UiMode,
  allowed_origins: z.array(z.string()).describe("Origins allowed to embed this session."),
  success_url: Url.describe("Redirect target after success (`?session_id=` appended)."),
  cancel_url: Url.nullable().describe("Redirect target on cancel."),
  attempt: PayerAttempt.nullable().describe("The current visible attempt, if any."),
}).meta({ id: "PublicCheckoutSession", description: "A checkout session as the payer sees it." });

// stage 2 — rails-fx (CR-15-06)
/** Token contract of an asset on its chain (CR-15-06), so wallets need not derive it from asset-id naming. */
export const TokenContract = out({
  standard: openEnum(
    ["erc20", "native", "nep141"],
    "`erc20`: ERC-20 contract on an EVM chain; `native`: the chain's native coin (no contract); `nep141`: NEP-141 token on NEAR.",
  ),
  address: z
    .string()
    .min(1)
    .max(256)
    .nullable()
    .describe("Contract address (EVM `0x…`) or token account (NEAR); null for `native`."),
}).meta({ id: "TokenContract", description: "How to transfer an asset on its chain (wallet path)." });
// end stage 2 — rails-fx

export const PaymentOption = out({
  method: AttemptMethod,
  origin_asset_id: AssetId.describe("Asset the payer would pay with."),
  chain: ChainId.describe("Chain of that asset."),
  symbol: z.string().describe("Token symbol."),
  decimals: z.int().min(0).max(255).describe("Token decimals."),
  estimated_amount_in: BaseUnits.nullable().describe("Indicative amount to pay, base units (null if unknown)."),
  route_class: openEnum(["same_asset", "stable_pair", "volatile", "intents_transfer"], "Route class."),
  min_deadline_s: z.int().min(0).describe("Minimum deposit window this chain needs, seconds."),
  available: z.boolean().describe("Whether this option can be used now."),
  reason: openEnum(
    ["route_too_slow", "amount_too_low", "route_unavailable", "pricing_unavailable"],
    "Why it is unavailable.",
  ).nullable(),
  token: TokenContract.nullable()
    .optional()
    .describe(
      "Token contract to pay with; null when unknown (then use the manual path). Spec 0.1.6 (CR-15-06); optional so older servers stay valid.",
    ),
}).meta({ id: "PaymentOption", description: "An indicative way to pay (not a quote)." });

const SessionParams = inp({ id: id("cs") });
const AttemptParams = inp({ id: id("cs"), attempt: id("pa") });

export const getPublicCheckoutSession = route({
  id: "getPublicCheckoutSession",
  method: "GET",
  path: "/v1/checkout/sessions/{id}/public",
  service: "payments",
  visibility: "public",
  summary: "Load a session for the checkout page.",
  auth: ["client_secret"],
  idempotent: false,
  params: SessionParams,
  headers: ClientSecretHeaders,
  response: PublicCheckoutSession,
  status: 200,
  errors: ["client_secret_invalid"],
  stage: 1,
});

export const listPaymentOptions = route({
  id: "listPaymentOptions",
  method: "GET",
  path: "/v1/checkout/sessions/{id}/public/payment_options",
  service: "payments",
  visibility: "public",
  summary: "Indicative ways to pay this session.",
  auth: ["client_secret"],
  idempotent: false,
  params: SessionParams,
  headers: ClientSecretHeaders,
  query: inp({
    chain: ChainId.optional().describe("Only options on this chain."),
    wallet: ChainAddress.optional().describe("Connected wallet (used to rank by balance)."),
  }),
  response: out({
    object: z.literal("payment_options").describe("Always `payment_options`."),
    options: z.array(PaymentOption).describe("Options, best first."),
  }).meta({ id: "PaymentOptions", description: "Indicative payment options." }),
  status: 200,
  errors: ["client_secret_invalid", "session_not_open"],
  stage: 1,
});

export const createPaymentAttempt = route({
  id: "createPaymentAttempt",
  method: "POST",
  path: "/v1/checkout/sessions/{id}/public/attempts",
  service: "payments",
  visibility: "public",
  summary: "Start paying: get deposit instructions or a transfer requirement.",
  description:
    "`route_quote` needs `refund_to` (the connected wallet, or a payer-supplied address on the manual path). `intents_transfer` needs `payer_wallet` (the payer's Intents account; refunds go there).",
  auth: ["client_secret"],
  idempotent: false,
  params: SessionParams,
  headers: ClientSecretHeaders,
  body: inp({
    method: AttemptMethod,
    origin_asset_id: AssetId.describe("Asset to pay with."),
    refund_to: ChainAddress.optional().describe("Refund address on the origin chain (`route_quote`)."),
    payer_wallet: NearAccountId.optional().describe("Payer's Intents account (`intents_transfer`)."),
    turnstile_token: z.string().min(1).max(4096).describe("Cloudflare Turnstile token."),
  }).superRefine((v, ctx) => {
    if (v.method === "route_quote" && !v.refund_to)
      ctx.addIssue({ code: "custom", path: ["refund_to"], message: "required for route_quote" });
    if (v.method === "intents_transfer" && !v.payer_wallet)
      ctx.addIssue({ code: "custom", path: ["payer_wallet"], message: "required for intents_transfer" });
  }),
  response: PayerAttempt,
  status: 201,
  errors: [
    "client_secret_invalid",
    "session_not_open",
    "attempt_in_flight",
    "too_many_attempts",
    "route_too_slow",
    "refund_address_invalid",
    "screening_blocked",
    "geo_blocked",
    "rail_unavailable",
    "turnstile_failed",
    "asset_unsupported",
    "route_unavailable",
    "pricing_unavailable",
    "quote_rejected",
    "screening_unavailable",
  ],
  stage: 1,
});

export const submitDepositTx = route({
  id: "submitDepositTx",
  method: "POST",
  path: "/v1/checkout/sessions/{id}/public/attempts/{attempt}/deposit_tx",
  service: "payments",
  visibility: "public",
  summary: "Report the deposit transaction hash (speeds up detection).",
  auth: ["client_secret"],
  idempotent: false,
  params: AttemptParams,
  headers: ClientSecretHeaders,
  body: inp({ tx_hash: TxHash }),
  response: null,
  status: 202,
  errors: ["client_secret_invalid", "state_conflict"],
  stage: 1,
});

export const signalDepositSent = route({
  id: "signalDepositSent",
  method: "POST",
  path: "/v1/checkout/sessions/{id}/public/attempts/{attempt}/sent",
  service: "payments",
  visibility: "public",
  summary: 'Payer says they sent the deposit ("I\'ve sent it").',
  auth: ["client_secret"],
  idempotent: false,
  params: AttemptParams,
  headers: ClientSecretHeaders,
  body: inp({}),
  response: null,
  status: 202,
  errors: ["client_secret_invalid", "state_conflict"],
  stage: 1,
});

export const submitSignedIntent = route({
  id: "submitSignedIntent",
  method: "POST",
  path: "/v1/checkout/sessions/{id}/public/attempts/{attempt}/signed_intent",
  service: "payments",
  visibility: "public",
  summary: "Submit the signed Intents transfer for an `intents_transfer` attempt.",
  auth: ["client_secret"],
  idempotent: false,
  params: AttemptParams,
  headers: ClientSecretHeaders,
  body: inp({ signed: MultiPayload }),
  response: null,
  status: 202,
  errors: ["client_secret_invalid", "state_conflict", "intent_invalid", "insufficient_balance"],
  stage: 1,
});

export const IntentStreamEvent = out({
  id: id("pi"),
  status: IntentStatus,
  amount_settled: BaseUnits.describe("Settled amount, base units."),
  late: z.boolean().describe("Settled after expiry."),
}).meta({ id: "IntentStreamEvent", description: "Payment intent status pushed to the checkout page." });

export const streamCheckoutSession = route({
  id: "streamCheckoutSession",
  method: "GET",
  path: "/v1/checkout/sessions/{id}/public/stream",
  service: "payments",
  visibility: "public",
  summary: "Live status as server-sent events (FR-PAY-06).",
  description:
    "Events `session`, `attempt` and `intent` carry full snapshots; a comment heartbeat every 15 s; `retry: 3000`. The SPA uses a fetch-based SSE client because `EventSource` cannot send headers; on failure it polls `GET …/public` every 3 s.",
  auth: ["client_secret"],
  idempotent: false,
  params: SessionParams,
  headers: ClientSecretHeaders,
  response: null,
  status: 200,
  stream: {
    events: { session: PublicCheckoutSession, attempt: PayerAttempt, intent: IntentStreamEvent },
    heartbeatSeconds: 15,
    retryMs: 3000,
  },
  errors: ["client_secret_invalid"],
  stage: 1,
});

export const simulateDeposit = route({
  id: "simulateDeposit",
  method: "POST",
  path: "/v1/checkout/sessions/{id}/public/attempts/{attempt}/simulate_deposit",
  service: "payments",
  visibility: "public",
  summary: 'Test mode: simulate the payer\'s deposit ("Simulate payment").',
  auth: ["client_secret"],
  idempotent: false,
  testModeOnly: true,
  params: AttemptParams,
  headers: ClientSecretHeaders,
  body: inp({ amount_in: BaseUnits.optional().describe("Deposit amount; default the quoted `amount_in`.") }),
  response: null,
  status: 202,
  errors: ["client_secret_invalid", "livemode_forbidden", "state_conflict"],
  stage: 1,
});

export const advancePaymentAttempt = route({
  id: "advancePaymentAttempt",
  method: "POST",
  path: "/v1/test_helpers/payment_attempts/{attempt}/advance",
  service: "payments",
  visibility: "public",
  summary: "Test mode: move a sandbox attempt to the next step.",
  auth: ["secret_key"],
  idempotent: true,
  testModeOnly: true,
  params: inp({ attempt: id("pa") }),
  body: inp({
    to: closedEnum(["deposit", "processing", "success", "refund", "fail"], "Step to move the sandbox execution to."),
  }),
  response: null,
  status: 202,
  errors: ["livemode_forbidden", "state_conflict"],
  stage: 1,
});
