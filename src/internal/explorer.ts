/**
 * NEAR Intents Explorer API wire schemas (`GET https://explorer.near-intents.org/api/v0/transactions`,
 * reference/landscape.md §2; read from docs.near-intents.org "get transactions" on 2026-11-07).
 * The rails Explorer feed (lld/rails.md §8.5) and the `nearpay-sandbox` mirror (lld/sandbox.md §3)
 * validate against the same schemas. Bearer JWT (the owner's Partner Dashboard token), 1 request per
 * 5 s per partner, bare array body.
 *
 * Tolerance: like the 1Click schemas, optional fields are `nullish`, `status` is a plain string
 * (an unknown value is recorded as an observation and never moves an execution; domain-model §4.3)
 * and rows are loose objects.
 */
import { inp, out, z } from "@nearpay/spec";

/** Statuses the Explorer documents (2026-11-07). The API's default filter omits the two `*_DEPOSIT` ones. */
export const EXPLORER_STATUSES = [
  "PENDING_DEPOSIT",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
] as const;

const AmountString = z.string().regex(/^\d+$/).describe("Integer amount in base units, as a string.");
const AddressType = z.string().describe("`ORIGIN_CHAIN`, `INTENTS`, `CONFIDENTIAL_INTENTS` or a newer value.");

/** Query parameters NearPay sends (a subset of the documented ones; the others are left out on purpose). */
export const ExplorerTransactionsQuery = inp({
  numberOfTransactions: z.coerce.number().int().min(1).max(1000).optional().describe("Rows (1–1000, default 50)."),
  lastDepositAddress: z.string().optional().describe("Page cursor: `depositAddress` of the last row."),
  lastDepositMemo: z.string().optional().describe("Page cursor: `depositMemo` of the last row."),
  direction: z.enum(["next", "prev"]).optional().describe("`next` = older rows (default), `prev` = newer rows."),
  referral: z.string().optional().describe("Referral filter (`nearpay`)."),
  statuses: z
    .string()
    .regex(/^[A-Z_]+(,[A-Z_]+)*$/)
    .optional()
    .describe(`Comma-separated statuses (${EXPLORER_STATUSES.join(", ")}); default omits the \`*_DEPOSIT\` ones.`),
  startTimestamp: z.iso.datetime({ offset: true }).optional().describe("Exclusive start bound (ISO 8601)."),
  endTimestamp: z.iso.datetime({ offset: true }).optional().describe("Exclusive end bound (ISO 8601)."),
  depositMemo: z.string().optional().describe("Deposit memo filter."),
  search: z.string().optional().describe("Deposit address, recipient, sender or tx hash."),
  showTestTxs: z.string().optional().describe("Include test-account transactions."),
}).meta({
  id: "ExplorerTransactionsQuery",
  description: "Explorer `GET /api/v0/transactions` query (NearPay subset).",
});
export type ExplorerTransactionsQuery = z.infer<typeof ExplorerTransactionsQuery>;

export const ExplorerTransaction = out({
  originAsset: z.string().describe("Origin asset id."),
  destinationAsset: z.string().describe("Destination asset id."),
  depositAddress: z.string().describe("Deposit address (matches `executions.deposit_address`)."),
  depositMemo: z.string().nullish().describe("Deposit memo."),
  depositAddressAndMemo: z.string().nullish().describe("Deprecated combined key."),
  recipient: z.string().describe("Recipient."),
  status: z.string().describe(`Status (${EXPLORER_STATUSES.join(", ")} or unknown).`),
  createdAt: z.string().describe("Creation time (ISO)."),
  createdAtTimestamp: z.number().describe("Creation time (unix seconds)."),
  intentHashes: z.string().nullish().describe("Intent hashes (comma-separated)."),
  referral: z.string().nullish().describe("Referral id."),
  amountIn: AmountString.describe("Amount in, origin base units (`0` while in flight)."),
  amountInFormatted: z.string().describe("Readable amount in."),
  amountInUsd: z.string().describe("USD value of amount in."),
  amountOut: AmountString.describe("Amount out, destination base units (`0` while in flight)."),
  amountOutFormatted: z.string().describe("Readable amount out."),
  amountOutUsd: z.string().describe("USD value of amount out."),
  appFees: z
    .array(
      out({
        recipient: z.string().describe("Fee recipient."),
        fee: z.number().describe("Fee, bps."),
      }).describe("An app fee."),
    )
    .nullish()
    .describe("App fees."),
  nearTxHashes: z.array(z.string()).nullish().describe("NEAR transactions."),
  originChainTxHashes: z.array(z.string()).nullish().describe("Origin-chain transactions."),
  destinationChainTxHashes: z.array(z.string()).nullish().describe("Destination-chain transactions."),
  refundTo: z.string().nullish().describe("Refund address."),
  senders: z.array(z.string()).nullish().describe("Senders."),
  refundFee: z.string().nullish().describe("Refund fee, origin base units."),
  refundFeeFormatted: z.string().nullish().describe("Readable refund fee."),
  refundReason: z.string().nullish().describe("Refund reason (e.g. `PARTIAL_DEPOSIT`, `NO_LIQUIDITY`)."),
  depositType: AddressType.nullish(),
  recipientType: AddressType.nullish(),
  refundType: AddressType.nullish(),
}).meta({
  id: "ExplorerTransaction",
  description: "One Explorer transaction row (no `updatedAt`: change detection compares `status`).",
});
export type ExplorerTransaction = z.infer<typeof ExplorerTransaction>;

export const ExplorerTransactionList = z
  .array(ExplorerTransaction)
  .meta({ id: "ExplorerTransactionList", description: "Explorer transactions, newest first (bare array)." });

export const ExplorerError = out({
  status: z.number().describe("HTTP status."),
  error: out({
    code: z.string().describe("Error code."),
    message: z.string().describe("Message."),
  }).describe("Error."),
}).meta({ id: "ExplorerError", description: "Explorer 4xx body (400, 401, 429)." });
