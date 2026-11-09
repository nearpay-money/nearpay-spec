/**
 * stage 4 — autodebit: billing mandates, the mirror of subscription-vault mandates (lld/billing.md
 * §5–§7.1, §14; lld/contracts-vault.md; ADR-0008; FR-BIL-02/04).
 *
 * A payer authorises auto-debit by funding a vault mandate from their own NEAR account
 * (`ft_transfer_call` on the token with the `msg` billing prepares). NearPay never holds the keys
 * to these funds (INV-1): billing's keeper may only trigger the permissionless `collect`, which pays
 * at most one period per elapsed period to the merchant's NEAR Intents account; the payer can
 * `cancel` at any time and gets the remaining balance back (FR-BIL-04).
 *
 * A `md_` mandate exists from the vault's `mandate_created` event on (forwarded by rails, billing §6):
 * `POST /v1/mandates/prepare` has no side effects. It is `linked` to the subscription named by its
 * `ext_ref` when every term matches what billing prepared, else `unlinked` (the payer is told to
 * cancel it; the contract cannot refuse payer-signed terms). Balances, periods and status follow
 * the vault's events, never an RPC response alone (INV-2).
 */
import { id } from "../common/ids.js";
import { createdFilterShape, listOf, listQueryShape } from "../common/pagination.js";
import { AssetId, BaseUnits, Livemode, NearAccountId, TxHash, UnixTime } from "../common/primitives.js";
import { route } from "../common/route.js";
import { closedEnum, inp, openEnum, out, z } from "../common/schema.js";
import { VaultReceiverKind } from "../vault/contract.js";
import { InvoiceSecretHeaders } from "./invoices.js";
import { PricingAssetDisplay } from "./payer.js";
import { SUBSCRIPTION_ROLES } from "./subscriptions.js";

// =============================================================================================
// NEAR transactions for the payer's / merchant's wallet
// =============================================================================================

const GasUnits = z
  .string()
  .regex(/^[1-9][0-9]{0,17}$/)
  .describe("Gas in gas units as a decimal string (1 Tgas = 10^12).");
const Yocto = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,38})$/)
  .describe("Attached deposit in yoctoNEAR as a decimal string.");

export const NearFunctionCallAction = out({
  type: z.literal("FunctionCall").describe("Always `FunctionCall`."),
  method_name: z.string().min(1).max(256).describe("Contract method."),
  args: z.record(z.string(), z.unknown()).describe("JSON arguments, exactly as they must be sent."),
  gas: GasUnits,
  deposit: Yocto,
}).meta({ id: "NearFunctionCallAction", description: "A NEAR function-call action to sign as is." });

export const NearTransactionRequest = out({
  signer_id: NearAccountId.nullable().describe(
    "Account that must sign; null = the connected wallet's account (it becomes the payer).",
  ),
  receiver_id: NearAccountId.describe("Contract the transaction calls."),
  actions: z.array(NearFunctionCallAction).min(1).max(4).describe("Actions, in order."),
}).meta({
  id: "NearTransactionRequest",
  description:
    "A NEAR transaction for a wallet to sign (snake_case; NEAR Connect / wallet-selector take the same fields in camelCase). Clients show a summary and never edit receiver, method, args, gas or deposit.",
});
export type NearTransactionRequest = z.infer<typeof NearTransactionRequest>;

// =============================================================================================
// Mandate
// =============================================================================================

export const MandateStatus = openEnum(
  ["active", "insufficient", "exhausted", "canceled"],
  "Mandate status (domain-model §4.5): `active` = on-chain active with at least one period funded; `insufficient` = on-chain active but the balance is below one period (top up, or the due invoice falls back to `send_invoice`); `exhausted` = `max_periods` collected; `canceled` = canceled by the payer or the merchant receiver.",
);

export const MandateLinkStatus = openEnum(
  ["linked", "unlinked"],
  "`linked`: billing collects this mandate for its subscription. `unlinked`: the on-chain terms do not match what billing prepared; billing never collects it and the payer is asked to cancel it.",
);

export const MandateUnlinkedReason = openEnum(
  [
    "subscription_not_auto_debit",
    "subscription_ended",
    "already_linked",
    "receiver_kind_mismatch",
    "receiver_not_destination",
    "token_mismatch",
    "amount_mismatch",
    "period_mismatch",
    "fee_mismatch",
    "start_too_late",
    "max_periods_too_low",
    "mode_mismatch",
  ],
  "Why a mandate is `unlinked` (billing §6 linkage rule): the subscription is not `auto_debit` or has ended, another mandate is already linked, or a term differs from the prepared one (receiver kind, receiver = an active Intents-account destination of the account, token, amount per period, period, fee, `start_at` after the current period end, `max_periods` below the remaining periods), or a test-vault mandate names a live subscription (or the reverse).",
);

export const MandateCollection = out({
  period: z.int().min(1).describe("1-based vault period."),
  amount: BaseUnits.describe("`merchant_share + fee` actually paid (token base units)."),
  merchant_share: BaseUnits.describe("Share delivered to the merchant receiver."),
  fee: BaseUnits.describe('NearPay fee; `"0"` when the fee leg failed (the fee stayed with the payer).'),
  short: z
    .boolean()
    .describe(
      "The merchant share was below the expected share (partial delivery): the invoice is not marked paid; billing issues a `send_invoice` balance invoice for the shortfall.",
    ),
  invoice: id("in").nullable().describe("Invoice the collection paid (or applied to)."),
  tx_hash: TxHash.describe("NEAR transaction of the `collect`."),
  receipt_id: z.string().min(1).max(64).describe("Vault receipt that logged `collected` (evidence)."),
  collected_at: UnixTime.describe("Block time of the receipt."),
}).meta({ id: "MandateCollection", description: "A period collected by the vault (evidence: the `collected` event)." });

export const Mandate = out({
  id: id("md"),
  object: z.literal("mandate").describe("Always `mandate`."),
  created: UnixTime.describe("Block time of `mandate_created`."),
  livemode: Livemode.describe("`true` for the mainnet vault, `false` for the sandbox vault stand-in."),
  status: MandateStatus,
  link_status: MandateLinkStatus,
  unlinked_reason: MandateUnlinkedReason.nullable().describe("Set when `link_status` is `unlinked`."),
  collecting: z
    .boolean()
    .describe(
      "Billing's keeper collects renewal invoices from this mandate: linked, on-chain active, and its subscription is active and `auto_debit`. Turns false for good when the subscription ends or leaves `auto_debit` (`mandate.released`).",
    ),
  subscription: id("sub").describe("Subscription named by the mandate's `ext_ref`."),
  customer: id("cus").describe("Customer of that subscription."),
  vault_contract: NearAccountId.describe("Vault account (`v1.vault.nearpay.near`; the stand-in's in test mode)."),
  onchain_id: z.int().min(0).describe("The vault's `mandate_id`."),
  payer: NearAccountId.describe("Payer: the NEAR account that signed the funding transaction (always its owner)."),
  token: NearAccountId.describe("NEP-141 token contract."),
  asset_id: AssetId.describe("The token as a NEAR Intents asset id (`nep141:<token>`)."),
  merchant_receiver: NearAccountId.describe("Receiver of the merchant share (the merchant's NEAR Intents account)."),
  receiver_kind: VaultReceiverKind,
  settlement_destination: id("sd")
    .nullable()
    .describe("Settlement destination that matches `merchant_receiver` (linked mandates); null otherwise."),
  amount_per_period: BaseUnits.describe("Tokens collected per period."),
  period_secs: z.int().min(86_400).describe("Vault period length (seconds)."),
  start_at: UnixTime.describe("When vault period 1 became (or becomes) due."),
  max_periods: z.int().min(1).nullable().describe("Maximum periods; null = until canceled."),
  fee_bps: z.int().min(0).max(10_000).describe("NearPay fee in basis points, fixed on chain at creation."),
  collected_periods: z.int().min(0).describe("Periods the vault has counted."),
  balance: BaseUnits.describe("Tokens on the mandate available for the next periods (mirror of the vault events)."),
  funded_periods: z.int().min(0).describe("`floor(balance / amount_per_period)`: periods the balance still covers."),
  next_collect_at: UnixTime.nullable().describe(
    "When the next vault period becomes due; null unless on-chain active below `max_periods`.",
  ),
  last_collection: MandateCollection.nullable().describe("Most recent collected period."),
  collect_failures: z
    .int()
    .min(0)
    .describe("Consecutive `collect_failed` outcomes (merchant leg delivered nothing); reset by a collection."),
  canceled: out({
    by: NearAccountId.describe("Who canceled (the payer or the merchant receiver)."),
    by_role: openEnum(["payer", "merchant_receiver"], "Role of `by`."),
    refunded: BaseUnits.describe(
      'Returned to the payer by the cancel; `"0"` if that refund failed (then withdrawable).',
    ),
    canceled_at: UnixTime.describe("Block time of the `canceled` event."),
  })
    .nullable()
    .describe("Set once canceled."),
  withdrawn: BaseUnits.describe("Total the payer withdrew after cancel/exhaustion (`withdrawn` events)."),
  ext_ref: z.string().max(64).describe("The mandate's on-chain reference (the subscription id for NearPay mandates)."),
  sequence: z.int().min(0).describe("Increases with every change; discard webhook objects with a lower sequence."),
}).meta({
  id: "Mandate",
  description:
    "An auto-debit mandate: NearPay's mirror of a subscription-vault mandate the payer funded (FR-BIL-02/04).",
});
export type Mandate = z.infer<typeof Mandate>;

// =============================================================================================
// Funding instructions
// =============================================================================================

/** Default `payer_notice` billing returns (English; UIs may localise it without weakening it). */
export const MANDATE_FUNDING_PAYER_NOTICE =
  "Sign both transactions from your own NEAR account and pay the gas yourself. Relayer or gasless wallets, NEAR Intents balances, bridges and smart wallets cannot fund a mandate: the vault refunds such deposits. You can cancel at any time from the NEAR account you pay with; the remaining balance goes back to it.";

export const MandateFundingInstructions = out({
  object: z.literal("mandate_funding_instructions").describe("Always `mandate_funding_instructions`."),
  livemode: Livemode,
  subscription: id("sub"),
  vault_contract: NearAccountId.describe("Vault the mandate is created in."),
  token: NearAccountId.describe("NEP-141 token the payer funds with."),
  asset_id: AssetId.describe("The token as a NEAR Intents asset id."),
  // spec 0.4.1 — checkout CR: render the token without a registry call
  token_asset: PricingAssetDisplay.optional().describe(
    "Display data of `token` (asset id, symbol, decimals) for the funding UI. Spec 0.4.1; absent from older billing builds.",
  ),
  amount: BaseUnits.describe("Initial funding: `periods × amount_per_period`."),
  periods: z.int().min(1).describe("Periods the initial funding covers."),
  amount_per_period: BaseUnits.describe(
    "Tokens per period: the subscription's per-period total (items and tax) in the token (USD at par for USDC/USDT, or the pricing asset itself).",
  ),
  period_secs: z.int().min(86_400).describe("Vault period for the subscription's interval (billing §14 d3)."),
  start_at: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,19})$/)
    .nullable()
    .describe(
      "Period 1 due time in ns as written in `msg`; null = the block time (the mandate pays the subscription's open invoice right away).",
    ),
  fee_bps: z.int().min(0).max(10_000).describe("The account's agreed NearPay fee (ADR-0006)."),
  merchant_receiver: NearAccountId.describe("The merchant's NEAR Intents account (an active destination)."),
  receiver_kind: VaultReceiverKind,
  settlement_destination: id("sd").describe("Destination `merchant_receiver` belongs to."),
  ext_ref: z.string().max(64).describe("The subscription id, written as the mandate's `ext_ref`."),
  msg: z
    .string()
    .max(2048)
    .describe(
      'Exact `ft_transfer_call` msg (`{"create_mandate":{…}}`, compact JSON, the contract\'s key order). A mandate whose on-chain terms differ is not linked.',
    ),
  payer: NearAccountId.nullable().describe("Payer the storage check was made for; null when none was given."),
  storage: out({
    payer_registered: z
      .boolean()
      .nullable()
      .describe("Whether the payer has a vault storage balance; null when no payer was given."),
    deposit: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,38})$/)
      .describe(
        'yoctoNEAR the payer must add with `storage_deposit` before funding (0.002 NEAR registration + 0.01 NEAR per open mandate, minus what is available); `"0"` = none.',
      ),
  }).describe("Vault storage (NEP-145) the payer pays for."),
  payer_notice: z
    .string()
    .describe(
      "Text the funding UI must show before signing (billing v1.9 §5): sign from your own NEAR account and pay your own gas; relayer/gasless wallets (NEP-366 meta-transactions), NEAR Intents balances, bridges and smart wallets cannot fund (the vault refunds such deposits). Cancel and withdraw are accepted only from the paying account (from any wallet holding it, meta-transactions included); the remaining balance returns to that account.",
    ),
  transactions: z
    .array(NearTransactionRequest)
    .min(1)
    .max(2)
    .describe(
      "Transactions to sign from the payer's own NEAR account, in order: `storage_deposit` on the vault (only when `storage.deposit` > 0 or the payer is unknown), then `ft_transfer_call` on the token (`receiver_id` = the vault, `amount`, `msg`; 100 Tgas, 1 yoctoNEAR). Deposits relayed by contracts, smart wallets or NEP-366 meta-transactions are refunded (`ERR_UNSUPPORTED_SENDER`).",
    ),
}).meta({
  id: "MandateFundingInstructions",
  description:
    "What the payer signs to authorise auto-debit for a subscription (lld/billing.md §5, §14). Computing it has no side effects.",
});

const FundingBody = {
  payer: NearAccountId.optional().describe(
    "Payer's NEAR account, if known: billing reads its vault storage balance and leaves out `storage_deposit` when it is enough.",
  ),
  token: NearAccountId.optional().describe(
    "Token to fund with (an allowed vault token). USD subscriptions: USDC or USDT at par (default USDC); asset subscriptions: the pricing asset's token only.",
  ),
  periods: z.int().min(1).max(36).optional().describe("Periods to fund up front (default 3)."),
};

const FUNDING_ERRORS = [
  "state_conflict",
  "auto_debit_unavailable",
  "destination_not_intents_account",
  "vault_cap_exceeded",
  "account_not_live",
  "rail_unavailable",
] as const;

const MandateParams = inp({ id: id("md") });
const WRITE = ["secret_key", "restricted_key:subscriptions.write", "session"] as const;
const READ = ["secret_key", "restricted_key:subscriptions.read", "session"] as const;

export const prepareMandate = route({
  id: "prepareMandate",
  method: "POST",
  path: "/v1/mandates/prepare",
  service: "billing",
  visibility: "public",
  summary: "Compute what a payer signs to fund an auto-debit mandate for a subscription.",
  description:
    "The subscription must be `auto_debit`, not canceled, and without a linked active mandate (`state_conflict`). Its pricing must be vault-compatible: USD (paid at par in USDC/USDT) or an asset whose token the vault allows, with a per-period total within the vault's per-mandate cap (`auto_debit_unavailable`). The merchant receiver is the subscription's settlement destination if it is an active NEAR Intents account for the token, else the account's default one (`destination_not_intents_account`). `start_at` is null (block time) while the subscription's latest invoice is open — the first collection pays it — else the current period end (or `trial_end`). Funding above the vault's per-mandate or TVL cap is `vault_cap_exceeded`; the NEAR RPC being unreachable is `rail_unavailable`. No mandate exists until the payer's transaction lands and rails forwards `mandate_created`.",
  auth: WRITE,
  roles: SUBSCRIPTION_ROLES,
  idempotent: true,
  body: inp({ subscription: id("sub").describe("The `auto_debit` subscription."), ...FundingBody }).meta({
    id: "MandatePrepare",
    description: "Parameters to prepare a mandate's funding.",
  }),
  response: MandateFundingInstructions,
  status: 200,
  errors: [...FUNDING_ERRORS],
  stage: 4,
});

export const getMandate = route({
  id: "getMandate",
  method: "GET",
  path: "/v1/mandates/{id}",
  service: "billing",
  visibility: "public",
  summary: "Retrieve a mandate.",
  auth: READ,
  idempotent: false,
  params: MandateParams,
  response: Mandate,
  status: 200,
  errors: [],
  stage: 4,
});

export const listMandates = route({
  id: "listMandates",
  method: "GET",
  path: "/v1/mandates",
  service: "billing",
  visibility: "public",
  summary: "List mandates.",
  auth: READ,
  idempotent: false,
  query: inp({
    ...listQueryShape,
    ...createdFilterShape,
    subscription: id("sub").optional().describe("Only mandates of this subscription."),
    customer: id("cus").optional().describe("Only mandates of this customer."),
    status: MandateStatus.optional().describe("Only mandates in this status."),
    link_status: MandateLinkStatus.optional().describe("Only linked or only unlinked mandates."),
    payer: NearAccountId.optional().describe("Only mandates funded by this NEAR account."),
  }),
  response: listOf(Mandate, "MandateList", "A page of mandates."),
  status: 200,
  errors: [],
  stage: 4,
});

export const MandateCancelInstructions = out({
  object: z.literal("mandate_cancel_instructions").describe("Always `mandate_cancel_instructions`."),
  mandate: id("md"),
  transaction: NearTransactionRequest.describe(
    "`cancel({mandate_id})` on the vault, signed by `merchant_receiver` (100 Tgas, 1 yoctoNEAR): the whole balance returns to the payer.",
  ),
}).meta({
  id: "MandateCancelInstructions",
  description:
    "The transaction the merchant receiver signs to cancel a mandate. NearPay cannot cancel (it holds no key the vault accepts, INV-1).",
});

export const prepareMandateCancel = route({
  id: "prepareMandateCancel",
  method: "POST",
  path: "/v1/mandates/{id}/prepare_cancel",
  service: "billing",
  visibility: "public",
  summary: "Get the transaction the merchant receiver signs to cancel a mandate.",
  description:
    "The vault accepts `cancel` from the payer or the merchant receiver only, so the merchant signs it with the wallet of its NEAR Intents account (accounts that cannot sign NEAR transactions, e.g. EVM-keyed implicit accounts without a wallet contract, cannot cancel; the payer always can). Canceled or exhausted mandates answer `state_conflict`. Ending the subscription instead stops collection (`mandate.released`) and asks the payer to cancel.",
  auth: WRITE,
  roles: SUBSCRIPTION_ROLES,
  idempotent: true,
  params: MandateParams,
  response: MandateCancelInstructions,
  status: 200,
  errors: ["state_conflict"],
  stage: 4,
});

// =============================================================================================
// Hosted invoice page (`/i/:id`): payer-side funding and management
// =============================================================================================

const PublicInvoiceParams = inp({ id: id("in") });

export const PublicMandate = out({
  id: id("md"),
  object: z.literal("mandate").describe("Always `mandate`."),
  livemode: Livemode,
  status: MandateStatus,
  link_status: MandateLinkStatus,
  payer: NearAccountId.describe("Payer account."),
  vault_contract: NearAccountId.describe("Vault account."),
  onchain_id: z.int().min(0).describe("The vault's `mandate_id`."),
  token: NearAccountId.describe("Token contract."),
  asset_id: AssetId.describe("Token as a NEAR Intents asset id."),
  // spec 0.4.1 — checkout CR: render the token without a registry call
  token_asset: PricingAssetDisplay.optional().describe(
    "Display data of `token` (asset id, symbol, decimals) for the hosted page. Spec 0.4.1; absent from older billing builds.",
  ),
  amount_per_period: BaseUnits.describe("Tokens per period."),
  period_secs: z.int().min(86_400).describe("Period length (seconds)."),
  balance: BaseUnits.describe("Remaining balance."),
  funded_periods: z.int().min(0).describe("Periods the balance still covers."),
  collected_periods: z.int().min(0).describe("Periods collected."),
  next_collect_at: UnixTime.nullable().describe("Next due time; null when none."),
  collecting: z.boolean().describe("The merchant still collects from it."),
  top_up_msg: z
    .string()
    .nullable()
    .describe(
      '`ft_transfer_call` msg to top up (`{"top_up":{"mandate_id":n}}`) while on-chain active; send it to the vault from the payer\'s account with any amount.',
    ),
  transactions: out({
    cancel: NearTransactionRequest.nullable().describe(
      "`cancel` signed by the payer (100 Tgas, 1 yoctoNEAR); null unless on-chain active.",
    ),
    withdraw: NearTransactionRequest.nullable().describe(
      "`withdraw` signed by the payer after cancel/exhaustion while a balance remains; null otherwise.",
    ),
  }).describe("Payer transactions the page offers."),
}).meta({
  id: "PublicMandate",
  description: "A mandate as the hosted invoice page shows it to the payer (holder of the invoice secret).",
});

export const createPublicInvoiceMandateFunding = route({
  id: "createPublicInvoiceMandateFunding",
  method: "POST",
  path: "/v1/invoices/{id}/public/mandate_funding",
  service: "billing",
  visibility: "public",
  summary: "Hosted invoice page: compute the payer's auto-debit funding transactions.",
  description:
    "Anonymous; billing checks the invoice secret. Offered when `PublicInvoice.auto_debit.available`: the invoice belongs to an `auto_debit` subscription without a linked active mandate. Same computation as `prepareMandate` (no side effects); paid or void invoices answer `invoice_not_payable`.",
  auth: ["anonymous"],
  idempotent: false,
  params: PublicInvoiceParams,
  headers: InvoiceSecretHeaders,
  body: inp(FundingBody),
  response: MandateFundingInstructions,
  status: 200,
  errors: ["invoice_secret_invalid", "invoice_not_payable", ...FUNDING_ERRORS],
  stage: 4,
});

export const getPublicInvoiceMandate = route({
  id: "getPublicInvoiceMandate",
  method: "GET",
  path: "/v1/invoices/{id}/public/mandate",
  service: "billing",
  visibility: "public",
  summary: "Hosted invoice page: the subscription's mandate with the payer's cancel/withdraw transactions.",
  description:
    "Anonymous; billing checks the invoice secret. Returns the newest mandate linked to the invoice's subscription (or unlinked for it), else `404 resource_missing`. The payer may also cancel straight from any NEAR wallet holding the paying account: the vault needs no NearPay involvement (it accepts `cancel`/`withdraw` only from the payer).",
  auth: ["anonymous"],
  idempotent: false,
  params: PublicInvoiceParams,
  headers: InvoiceSecretHeaders,
  response: PublicMandate,
  status: 200,
  errors: ["invoice_secret_invalid"],
  stage: 4,
});

// =============================================================================================
// Test helpers (test mode: the sandbox vault stand-in, lld/sandbox.md §3.1)
// =============================================================================================

export const MandateSimulation = out({
  object: z.literal("mandate_simulation").describe("Always `mandate_simulation`."),
  action: openEnum(["fund", "top_up", "cancel", "withdraw"], "What the simulated payer did."),
  tx_hash: TxHash.describe("Sandbox NEAR transaction."),
  accepted: z
    .boolean()
    .describe(
      "The vault accepted it (`fund`/`top_up`: not refunded; `cancel`/`withdraw`: no failure). The mirror follows asynchronously from the forwarded events.",
    ),
  rejection: z
    .string()
    .nullable()
    .describe("The vault's error or rejection log line (`ERR_…[: detail]`) when not accepted."),
  onchain_id: z.int().min(0).nullable().describe("Vault `mandate_id` (from `mandate_created` / the mandate)."),
  logs: z.array(z.string()).describe("Every log line of the vault's receipts, in order."),
}).meta({ id: "MandateSimulation", description: "Result of a simulated payer action on the sandbox vault." });

const TEST_HELPER_AUTH = WRITE;
const TEST_HELPER_ROLES = ["owner", "admin", "developer"] as const;

export const simulateMandateFunding = route({
  id: "simulateMandateFunding",
  method: "POST",
  path: "/v1/test_helpers/mandates/fund",
  service: "billing",
  visibility: "public",
  summary: "Test mode: fund a mandate for a subscription as the simulated payer.",
  description:
    "Prepares the funding like `prepareMandate` and submits it to the sandbox vault stand-in as `payer` (default the simulated NEAR payer `sandbox-payer.near`, sandbox §4.1): storage is registered and the payer's test tokens are minted as needed, then `ft_transfer_call` runs with the prepared `msg`. Outcome scenarios follow the last two digits of `amount_per_period` (sandbox §4.2: `91` merchant leg fails, `92` fee leg fails, `93` first refund fails, `94` partial delivery).",
  auth: TEST_HELPER_AUTH,
  roles: TEST_HELPER_ROLES,
  idempotent: true,
  testModeOnly: true,
  body: inp({ subscription: id("sub").describe("The `auto_debit` subscription."), ...FundingBody }).meta({
    id: "MandateFundingSimulation",
    description: "Parameters of a simulated mandate funding.",
  }),
  response: MandateSimulation,
  status: 200,
  errors: ["livemode_forbidden", ...FUNDING_ERRORS.filter((c) => c !== "account_not_live")],
  stage: 4,
});

export const simulateMandatePayerAction = route({
  id: "simulateMandatePayerAction",
  method: "POST",
  path: "/v1/test_helpers/mandates/{id}/payer_action",
  service: "billing",
  visibility: "public",
  summary: "Test mode: top up, cancel or withdraw a mandate as its payer.",
  description:
    "Submits the payer's transaction to the sandbox vault stand-in (`top_up`: `periods × amount_per_period`, default 1; `cancel` and `withdraw` with 100 Tgas and 1 yoctoNEAR). The vault's own errors come back in `rejection` with `accepted: false` (e.g. `ERR_STILL_ACTIVE` for a withdraw before cancel), not as API errors.",
  auth: TEST_HELPER_AUTH,
  roles: TEST_HELPER_ROLES,
  idempotent: true,
  testModeOnly: true,
  params: MandateParams,
  body: inp({
    action: closedEnum(["top_up", "cancel", "withdraw"], "Payer action."),
    periods: z.int().min(1).max(36).optional().describe("`top_up` only: periods to add (default 1)."),
  }),
  response: MandateSimulation,
  status: 200,
  errors: ["livemode_forbidden"],
  stage: 4,
});
