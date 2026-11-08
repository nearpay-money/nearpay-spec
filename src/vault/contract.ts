/**
 * stage 4 — autodebit: the subscription vault's on-chain interface (lld/contracts-vault.md v1.5
 * §3–§4, ADR-0008), mirrored byte-for-byte from `nearpay-contracts/contracts/subscription-vault`
 * (branch `stage-4/4.1-vault`, `src/{events,errors,msg,types}.rs`).
 *
 * Who uses it: rails (indexer: parses `nearpay_vault` logs, `rails.md` §8.6), billing (mirror,
 * keeper, `POST /v1/mandates/prepare`), the sandbox vault stand-in (OQ-T-03: emits the same lines,
 * errors and views), checkout/dashboard (funding and payer transactions). The exact wire strings
 * are exported as test vectors (`test-vectors/vault.json`); the vault's unit tests and the
 * stand-in's contract tests assert against that one file.
 *
 * Encoding rules (contracts-vault §4.1): `mandate_id`, `period`, `period_secs`, `max_periods`,
 * `fee_bps` are JSON numbers; amounts and balances are decimal strings (u128); `start_at` /
 * `next_collect_at` are decimal strings of nanoseconds (u64); accounts are strings. The contract
 * serialises canonically (no sign, no leading zeros), so every value a consumer sees is canonical.
 */
import { MAX_SAFE_INTEGER, NearAccountId } from "../common/primitives.js";
import { closedEnum, inp, openEnum, out, z } from "../common/schema.js";

// =============================================================================================
// Constants (contracts-vault §2, §3.1, §3.3, §3.4, §3.7)
// =============================================================================================

/** NEP-297 `standard` of every vault event. */
export const VAULT_EVENT_STANDARD = "nearpay_vault" as const;
/** NEP-297 `version` of every vault event. */
export const VAULT_EVENT_VERSION = "1.0.0" as const;
/** Prefix of a NEP-297 log line. */
export const EVENT_JSON_PREFIX = "EVENT_JSON:" as const;

/** Contract limits and costs (constructor-independent constants of the deployed code). */
export const VAULT_LIMITS = {
  /** `period_secs` minimum (one day). */
  min_period_secs: 86_400,
  /** `period_secs` maximum: 12 × 366 days (v1.5, re-audit N-3). */
  max_period_secs: 379_468_800,
  /** `max_periods` maximum: 2^31 − 1. */
  max_max_periods: 2_147_483_647,
  /** `start_at` may be at most 366 days after the block time (ns). */
  max_start_delay_ns: "31622400000000000",
  /** `ext_ref` maximum length in bytes (printable ASCII 0x20–0x7E). */
  max_ext_ref_len: 64,
  /** `msg` longer than this is rejected unparsed (`ERR_BAD_MSG`). */
  max_msg_len: 2048,
  /** yoctoNEAR each open mandate locks from the payer's NEP-145 storage balance (0.01 NEAR). */
  mandate_storage_cost: "10000000000000000000000",
  /** NEP-145 registration minimum (`storage_balance_bounds.min`, 0.002 NEAR). */
  storage_registration_cost: "2000000000000000000000",
} as const;

/** One Tgas in gas units (decimal string, as wallets take it). */
export const TGAS = "1000000000000" as const;
const tgas = (n: number) => (BigInt(n) * BigInt(TGAS)).toString();

/**
 * Gas rules (contracts-vault §3.3–§3.4, billing §7). Values are gas units as decimal strings.
 * `collect` below `min_collect` and `cancel`/`withdraw` below `min_exit` fail with `ERR_GAS`.
 */
export const VAULT_GAS = {
  /** What billing's keeper attaches to `collect` (unused gas is refunded). */
  keeper_collect: tgas(250),
  /** `MIN_COLLECT_GAS`. */
  min_collect: tgas(170),
  /** `MIN_EXIT_GAS` (`cancel` / `withdraw`). */
  min_exit: tgas(50),
  /** What NearPay's payer transactions attach to `cancel` / `withdraw` (recommended). */
  exit: tgas(100),
  /** The payer's `ft_transfer_call` on the token (create or top up a mandate). */
  ft_transfer_call: tgas(100),
  /** `storage_deposit` on the vault. */
  storage_deposit: tgas(30),
} as const;

/** The deposit every `ft_transfer_call`, `cancel`, `withdraw` and `storage_withdraw` needs. */
export const ONE_YOCTO = "1" as const;

// =============================================================================================
// Error strings (contracts-vault §3 "Error strings", v1.2, v1.4; `src/errors.rs` `ALL`)
// =============================================================================================

/** Every stable error string the vault can emit, in the contract's `errors::ALL` order. */
export const VAULT_ERRORS = [
  "ERR_NOT_FOUND",
  "ERR_NOT_ACTIVE",
  "ERR_NOT_DUE",
  "ERR_IN_FLIGHT",
  "ERR_INSUFFICIENT_BALANCE",
  "ERR_MAX_PERIODS",
  "ERR_UNAUTHORIZED",
  "ERR_TOKEN_NOT_ALLOWED",
  "ERR_BAD_MSG",
  "ERR_CAP_EXCEEDED",
  "ERR_FEE_TOO_HIGH",
  "ERR_NO_STORAGE",
  "ERR_STILL_ACTIVE",
  "ERR_OPEN_MANDATES",
  "ERR_BAD_CONFIG",
  "ERR_UNSUPPORTED_SENDER",
  "ERR_GAS",
] as const;
export type VaultErrorCode = (typeof VAULT_ERRORS)[number];
export const VaultErrorCodeSchema = closedEnum(VAULT_ERRORS, "A stable vault error string.");

/**
 * The only rejection log lines with a detail (contracts-vault v1.3 §3.1): `ERR_CAP_EXCEEDED: mandate`
 * (per-mandate cap) and `ERR_CAP_EXCEEDED: tvl` (per-token TVL cap). Every other rejection logs the
 * bare code.
 */
export const VAULT_CAP_EXCEEDED_LOGS = ["ERR_CAP_EXCEEDED: mandate", "ERR_CAP_EXCEEDED: tvl"] as const;

/**
 * Codes `ft_on_transfer` can log for a rejected deposit (the full amount is refunded; not events).
 * `ERR_TOKEN_NOT_ALLOWED` from a token outside the allow-list is a panic instead (the token
 * refunds); for a top-up in another token it is a logged rejection.
 */
export const VAULT_FUNDING_REJECTIONS = [
  "ERR_UNSUPPORTED_SENDER",
  "ERR_BAD_MSG",
  "ERR_FEE_TOO_HIGH",
  "ERR_NO_STORAGE",
  "ERR_CAP_EXCEEDED",
  "ERR_NOT_FOUND",
  "ERR_UNAUTHORIZED",
  "ERR_TOKEN_NOT_ALLOWED",
  "ERR_NOT_ACTIVE",
] as const satisfies readonly VaultErrorCode[];

/** `collect` failure codes, in the contract's check order (contracts-vault §3.2). */
export const VAULT_COLLECT_ERRORS = [
  "ERR_GAS",
  "ERR_NOT_FOUND",
  "ERR_MAX_PERIODS",
  "ERR_NOT_ACTIVE",
  "ERR_IN_FLIGHT",
  "ERR_NOT_DUE",
  "ERR_INSUFFICIENT_BALANCE",
] as const satisfies readonly VaultErrorCode[];

/** `cancel` failure codes in check order (plus near-sdk's 1-yocto guard), contracts-vault §3.4. */
export const VAULT_CANCEL_ERRORS = [
  "ERR_GAS",
  "ERR_NOT_FOUND",
  "ERR_UNAUTHORIZED",
  "ERR_NOT_ACTIVE",
] as const satisfies readonly VaultErrorCode[];

/** `withdraw` failure codes in check order (plus near-sdk's 1-yocto guard), contracts-vault §3.4. */
export const VAULT_WITHDRAW_ERRORS = [
  "ERR_GAS",
  "ERR_NOT_FOUND",
  "ERR_UNAUTHORIZED",
  "ERR_STILL_ACTIVE",
  "ERR_IN_FLIGHT",
  "ERR_INSUFFICIENT_BALANCE",
] as const satisfies readonly VaultErrorCode[];

/** near-sdk's own guard messages (not vault codes; contracts-vault §3 v1.2). */
export const NEAR_SDK_GUARD_MESSAGES = {
  one_yocto: "Requires attached deposit of exactly 1 yoctoNEAR",
} as const;

/** How a NEAR RPC failure renders a contract panic: `Smart contract panicked: <message>`. */
export const SMART_CONTRACT_PANICKED_PREFIX = "Smart contract panicked: " as const;

/**
 * The vault error code in a panic message, a NEAR RPC `ExecutionError` string or a rejection log
 * line: the first `ERR_[A-Z_]+` token that is a known code (consumers match the code, never the
 * detail after `:`). `null` when the text carries no vault code.
 */
export function vaultErrorCodeOf(text: string): VaultErrorCode | null {
  for (const m of text.matchAll(/ERR_[A-Z_]+/g)) {
    const code = m[0];
    if ((VAULT_ERRORS as readonly string[]).includes(code)) return code as VaultErrorCode;
  }
  return null;
}

// =============================================================================================
// Scalars
// =============================================================================================

const U128 = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,38})$/, "must be a canonical u128 decimal string")
  .describe("u128 decimal string (token base units).");
const U64Ns = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/, "must be a canonical u64 decimal string")
  .describe("Nanoseconds since the Unix epoch as a u64 decimal string.");
const MandateIdNum = z
  .int()
  .min(0)
  .max(MAX_SAFE_INTEGER)
  .describe("On-chain mandate id (u64, sequential from 0; exact in JSON numbers far beyond any real count).");
const PeriodSecs = z
  .int()
  .min(VAULT_LIMITS.min_period_secs)
  .max(VAULT_LIMITS.max_period_secs)
  .describe("Period length in seconds (86 400 … 379 468 800).");
const MaxPeriods = z
  .int()
  .min(1)
  .max(VAULT_LIMITS.max_max_periods)
  .nullable()
  .describe("Number of periods the mandate may collect; null = unlimited.");
const FeeBps = z.int().min(0).max(10_000).describe("NearPay fee in basis points, fixed at creation.");
const ExtRef = z
  .string()
  .max(VAULT_LIMITS.max_ext_ref_len)
  .regex(/^[\x20-\x7e]*$/, "must be printable ASCII")
  .describe("Free reference (≤ 64 bytes printable ASCII); NearPay puts the subscription id (`sub_…`).");

export const VaultReceiverKind = closedEnum(
  ["intents_account", "near_account"],
  "How the merchant share is delivered: `intents_account` = `ft_transfer_call(intents.near, msg = merchant_receiver)` (credits the merchant's NEAR Intents balance); `near_account` = plain `ft_transfer`.",
);
export const VaultMandateStatus = closedEnum(["active", "canceled", "exhausted"], "On-chain mandate status.");

// =============================================================================================
// Events (contracts-vault §4, §4.1; `src/events.rs`)
// =============================================================================================

/** Event data shapes, fields in the contract's serialisation order. */
export const VaultMandateCreatedData = out({
  mandate_id: MandateIdNum,
  payer: NearAccountId.describe("Payer = the NEP-141 `sender_id`, which is always the transaction signer (v1.5)."),
  merchant_receiver: NearAccountId.describe("Receiver of the merchant share (an Intents account for NearPay)."),
  token: NearAccountId.describe("NEP-141 token contract (the calling token)."),
  amount_per_period: U128.describe("Tokens collected per period (base units)."),
  period_secs: PeriodSecs,
  start_at: U64Ns.describe("When period 1 becomes due (ns); a past or omitted `start_at` became the block time."),
  max_periods: MaxPeriods,
  fee_bps: FeeBps,
  ext_ref: ExtRef,
  receiver_kind: VaultReceiverKind,
  balance: U128.describe("Initial funding (base units)."),
}).describe("`mandate_created` data.");

export const VaultToppedUpData = out({
  mandate_id: MandateIdNum,
  amount: U128.describe("Deposited amount."),
  balance: U128.describe("Balance after the deposit."),
}).describe("`topped_up` data.");

export const VaultCollectedData = out({
  mandate_id: MandateIdNum,
  period: z.int().min(1).describe("1-based period that was counted."),
  amount: U128.describe("`merchant_share + fee` actually paid."),
  merchant_share: U128.describe(
    "Share delivered to the merchant receiver; below `floor(amount_per_period × (10000 − fee_bps) / 10000)` only on partial delivery (the period still counts).",
  ),
  fee: U128.describe('Fee sent to the treasury; `"0"` when the fee leg failed or after a partial delivery.'),
  balance: U128.describe("Balance after the period."),
}).describe("`collected` data.");

export const VaultCollectFailedData = out({
  mandate_id: MandateIdNum,
  period: z.int().min(1).describe("Period that was attempted (not counted)."),
  reason: openEnum(
    ["merchant_transfer_failed"],
    "Why: `merchant_transfer_failed` (the merchant leg delivered nothing; the only reason in v1).",
  ),
}).describe("`collect_failed` data.");

export const VaultCanceledData = out({
  mandate_id: MandateIdNum,
  by: NearAccountId.describe("Who canceled: the payer or the merchant receiver."),
  refunded: U128.describe('Amount actually returned to the payer; `"0"` when the refund failed (then withdrawable).'),
}).describe("`canceled` data.");

export const VaultWithdrawnData = out({
  mandate_id: MandateIdNum,
  amount: U128.describe("Amount returned to the payer."),
}).describe("`withdrawn` data.");

export const VaultExhaustedData = out({ mandate_id: MandateIdNum }).describe("`exhausted` data.");

/** Event name → data schema and field order (the order the contract serialises). */
export const VAULT_EVENTS = {
  mandate_created: {
    data: VaultMandateCreatedData,
    fields: [
      "mandate_id",
      "payer",
      "merchant_receiver",
      "token",
      "amount_per_period",
      "period_secs",
      "start_at",
      "max_periods",
      "fee_bps",
      "ext_ref",
      "receiver_kind",
      "balance",
    ],
  },
  topped_up: { data: VaultToppedUpData, fields: ["mandate_id", "amount", "balance"] },
  collected: {
    data: VaultCollectedData,
    fields: ["mandate_id", "period", "amount", "merchant_share", "fee", "balance"],
  },
  collect_failed: { data: VaultCollectFailedData, fields: ["mandate_id", "period", "reason"] },
  canceled: { data: VaultCanceledData, fields: ["mandate_id", "by", "refunded"] },
  withdrawn: { data: VaultWithdrawnData, fields: ["mandate_id", "amount"] },
  exhausted: { data: VaultExhaustedData, fields: ["mandate_id"] },
} as const;
export type VaultEventName = keyof typeof VAULT_EVENTS;
export const VAULT_EVENT_NAMES = Object.keys(VAULT_EVENTS) as [VaultEventName, ...VaultEventName[]];
export const VaultEventNameSchema = openEnum(VAULT_EVENT_NAMES, "Vault event name.");

function vaultEventVariant<N extends VaultEventName>(name: N) {
  return out({
    standard: z.literal(VAULT_EVENT_STANDARD).describe("Always `nearpay_vault`."),
    version: z.literal(VAULT_EVENT_VERSION).describe("Always `1.0.0`."),
    event: z.literal(name).describe("Event name."),
    data: z.tuple([VAULT_EVENTS[name].data]).describe("One-element array (NEP-141/171 convention)."),
  }).describe(`\`${name}\` event.`);
}

/** A parsed `nearpay_vault` NEP-297 event (the JSON after `EVENT_JSON:`). */
export const VaultEvent = z
  .discriminatedUnion(
    "event",
    VAULT_EVENT_NAMES.map((n) => vaultEventVariant(n)) as unknown as [
      ReturnType<typeof vaultEventVariant>,
      ...ReturnType<typeof vaultEventVariant>[],
    ],
  )
  .meta({
    id: "VaultEvent",
    description:
      "A subscription-vault NEP-297 event (contracts-vault §4.1). Valid only in a successful receipt executed by the vault account itself (rails §8.6).",
  });
export type VaultEvent = {
  [N in VaultEventName]: {
    standard: typeof VAULT_EVENT_STANDARD;
    version: typeof VAULT_EVENT_VERSION;
    event: N;
    data: [z.infer<(typeof VAULT_EVENTS)[N]["data"]>];
  };
}[VaultEventName];

/**
 * Formats a vault event as the contract logs it: `EVENT_JSON:` + compact JSON with the envelope
 * keys `standard, version, event, data` and the data keys in the contract's order. The sandbox
 * stand-in uses it so its logs are byte-identical to the vault's.
 */
export function formatVaultEventLog(event: VaultEvent): string {
  const def = VAULT_EVENTS[event.event];
  const src = event.data[0] as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  for (const f of def.fields) {
    if (!(f in src)) throw new Error(`vault event ${event.event}: missing ${f}`);
    data[f] = src[f];
  }
  return `${EVENT_JSON_PREFIX}${JSON.stringify({
    standard: VAULT_EVENT_STANDARD,
    version: VAULT_EVENT_VERSION,
    event: event.event,
    data: [data],
  })}`;
}

/**
 * Parses one log line into a vault event. `null` when the line is not a `nearpay_vault` NEP-297
 * event or does not match the schema (version other than `1.0.0`, unknown event, bad field).
 * Proves nothing about validity on chain: the caller must also check the receipt (executor =
 * the vault account, successful outcome, final block; rails §8.6).
 */
export function parseVaultEventLog(line: string): VaultEvent | null {
  if (!line.startsWith(EVENT_JSON_PREFIX)) return null;
  let json: unknown;
  try {
    json = JSON.parse(line.slice(EVENT_JSON_PREFIX.length));
  } catch {
    return null;
  }
  const r = VaultEvent.safeParse(json);
  return r.success ? (r.data as VaultEvent) : null;
}

// =============================================================================================
// `ft_on_transfer` msg (contracts-vault §3.1; `src/msg.rs`)
// =============================================================================================

export const VaultCreateMandateArgs = inp({
  merchant_receiver: NearAccountId.describe("Receiver of the merchant share (≠ the vault)."),
  receiver_kind: VaultReceiverKind,
  amount_per_period: U128.describe("Tokens per period (> 0; the merchant share of one period must be > 0)."),
  period_secs: PeriodSecs,
  start_at: U64Ns.nullable()
    .optional()
    .describe("When period 1 becomes due (ns); omitted, null or past = the block time; ≤ block time + 366 days."),
  max_periods: MaxPeriods.optional(),
  fee_bps: FeeBps.describe("NearPay fee; ≤ the vault's `max_fee_bps` (else `ERR_FEE_TOO_HIGH`)."),
  ext_ref: ExtRef,
}).describe(
  "`create_mandate` arguments (unknown or duplicate fields are rejected; `payer`/`token` come from the call).",
);

/** Field order NearPay writes in `create_mandate` (the contract's struct order). */
export const VAULT_CREATE_MANDATE_FIELDS = [
  "merchant_receiver",
  "receiver_kind",
  "amount_per_period",
  "period_secs",
  "start_at",
  "max_periods",
  "fee_bps",
  "ext_ref",
] as const;

export const VaultMsg = z
  .union([
    inp({ create_mandate: VaultCreateMandateArgs }),
    inp({ top_up: inp({ mandate_id: MandateIdNum }).describe("`top_up` arguments (sender must be the payer).") }),
  ])
  .meta({
    id: "VaultMsg",
    description: "The `msg` of the payer's `ft_transfer_call` to the vault: exactly one of `create_mandate`, `top_up`.",
  });
export type VaultMsg = z.infer<typeof VaultMsg>;

/**
 * Serialises a vault `msg` canonically (compact JSON, `create_mandate` keys in the contract's
 * order, optional keys left out when undefined). Billing's prepare route and the stand-in use it.
 */
export function vaultMsgJson(msg: VaultMsg): string {
  const parsed = VaultMsg.parse(msg);
  if ("top_up" in parsed) return JSON.stringify({ top_up: { mandate_id: parsed.top_up.mandate_id } });
  const src = parsed.create_mandate as Record<string, unknown>;
  const cm: Record<string, unknown> = {};
  for (const f of VAULT_CREATE_MANDATE_FIELDS) if (src[f] !== undefined) cm[f] = src[f];
  const s = JSON.stringify({ create_mandate: cm });
  if (new TextEncoder().encode(s).length > VAULT_LIMITS.max_msg_len) throw new Error("vault msg too long");
  return s;
}

// =============================================================================================
// Views (contracts-vault §3.6, §3.7; `src/types.rs`)
// =============================================================================================

export const VaultMandateView = out({
  mandate_id: MandateIdNum,
  payer: NearAccountId.describe("Payer."),
  merchant_receiver: NearAccountId.describe("Merchant receiver."),
  receiver_kind: VaultReceiverKind,
  token: NearAccountId.describe("Token contract."),
  amount_per_period: U128.describe("Tokens per period."),
  period_secs: PeriodSecs,
  start_at: U64Ns.describe("Period 1 due time (ns)."),
  max_periods: MaxPeriods,
  fee_bps: FeeBps,
  collected_periods: z.int().min(0).describe("Periods counted so far."),
  balance: U128.describe("Tokens available to the next collect or refund (excludes in-flight amounts)."),
  status: VaultMandateStatus,
  in_flight: z.boolean().describe("A collect awaits its callbacks."),
  refund_in_flight: U128.describe('Amount of a pending cancel/withdraw refund; `"0"` when none.'),
  ext_ref: ExtRef,
  next_collect_at: U64Ns.nullable().describe(
    "When the next period becomes due (ns); null unless active below `max_periods`.",
  ),
}).meta({ id: "VaultMandateView", description: "`get_mandate` / `get_mandates_by_payer` element." });

export const VaultTokenCap = out({
  token: NearAccountId.describe("Token contract."),
  cap: U128.describe("Per-token TVL cap."),
  mandate_cap: U128.describe("Per-mandate cap (≤ `cap`): max `amount_per_period` and max held by one mandate."),
}).describe("Caps of one allowed token.");

export const VaultConfigView = out({
  allowed_tokens: z.array(NearAccountId).describe("Allowed NEP-141 tokens."),
  fee_receiver: NearAccountId.describe("Treasury that receives fees."),
  max_fee_bps: FeeBps.describe("Maximum `fee_bps` a mandate may set."),
  intents_account: NearAccountId.describe("NEAR Intents Verifier the merchant leg deposits into (`intents.near`)."),
  min_period_secs: z.int().min(1).describe("Minimum period (86 400)."),
  caps: z.array(VaultTokenCap).describe("Caps in `allowed_tokens` order."),
  mandate_storage_cost: U128.describe("yoctoNEAR locked per open mandate."),
  storage_registration_cost: U128.describe("NEP-145 registration minimum (yoctoNEAR)."),
}).meta({ id: "VaultConfigView", description: "`get_config` result (constructor parameters, immutable)." });

export const VaultTokenTvlView = out({
  token: NearAccountId.describe("Token contract."),
  tvl: U128.describe("Tokens the vault holds for the token's mandates."),
  cap: U128.describe("TVL cap."),
  mandate_cap: U128.describe("Per-mandate cap."),
}).meta({ id: "VaultTokenTvlView", description: "`get_token_tvl` result (null for a token that is not allowed)." });

export const VaultStorageBalance = out({
  total: U128.describe("yoctoNEAR deposited."),
  available: U128.describe("yoctoNEAR not locked by the registration or open mandates."),
}).meta({ id: "VaultStorageBalance", description: "NEP-145 `storage_balance_of` result (null when unregistered)." });

export const VaultStorageBalanceBounds = out({
  min: U128.describe("Registration minimum."),
  max: U128.nullable().describe("Always null."),
}).meta({ id: "VaultStorageBalanceBounds", description: "NEP-145 `storage_balance_bounds` result." });

/** View method → JSON result schema (the stand-in answers `query call_function` with the same JSON). */
export const VAULT_VIEWS = {
  get_mandate: VaultMandateView.nullable(),
  get_mandates_by_payer: z.array(VaultMandateView),
  next_collect_at: U64Ns.nullable(),
  get_config: VaultConfigView,
  get_token_tvl: VaultTokenTvlView.nullable(),
  storage_balance_of: VaultStorageBalance.nullable(),
  storage_balance_bounds: VaultStorageBalanceBounds,
} as const;
export type VaultViewMethod = keyof typeof VAULT_VIEWS;

/** Change methods a NearPay component or a payer calls on the vault (besides the token's `ft_transfer_call`). */
export const VAULT_CALL_METHODS = [
  "collect",
  "cancel",
  "withdraw",
  "storage_deposit",
  "storage_withdraw",
  "storage_unregister",
] as const;
export type VaultCallMethod = (typeof VAULT_CALL_METHODS)[number];

// =============================================================================================
// Arithmetic shared by billing, the stand-in and displays (INV-5: bigint only)
// =============================================================================================

/**
 * One period's split (contracts-vault §3): `merchant_share = floor(amount × (10000 − fee_bps) / 10000)`,
 * `fee = amount − merchant_share`.
 */
export function vaultSplit(amountPerPeriod: bigint, feeBps: number): { merchantShare: bigint; fee: bigint } {
  if (amountPerPeriod < 0n || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new Error("invalid split input");
  }
  const merchantShare = (amountPerPeriod * BigInt(10_000 - feeBps)) / 10_000n;
  return { merchantShare, fee: amountPerPeriod - merchantShare };
}

/**
 * Fixed vault period for a billing interval (billing §14 d3). Vault periods are fixed seconds while
 * billing's months and years are calendar-based, so months and years use the mean Gregorian length:
 * the vault then allows exactly 12 periods per average year (never more than billing invoices) and
 * calendar renewals drift from it by at most ~3 days (the keeper retries at `next_collect_at`).
 */
export const VAULT_PERIOD_SECS_PER_INTERVAL = {
  day: 86_400,
  week: 604_800,
  /** 30.436875 days = 365.2425 / 12. */
  month: 2_629_746,
  /** 365.2425 days. */
  year: 31_556_952,
} as const;

export function vaultPeriodSecs(interval: keyof typeof VAULT_PERIOD_SECS_PER_INTERVAL, count: number): number {
  if (!Number.isInteger(count) || count < 1 || count > 12) throw new Error("interval_count must be 1–12");
  const secs = VAULT_PERIOD_SECS_PER_INTERVAL[interval] * count;
  if (secs > VAULT_LIMITS.max_period_secs) throw new Error("period too long for the vault");
  return secs;
}
