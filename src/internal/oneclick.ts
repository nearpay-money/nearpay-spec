/**
 * 1Click API v0 wire schemas (reference/landscape.md §2), transcribed from the OpenAPI types of
 * `@defuse-protocol/one-click-sdk-typescript` 0.1.26. The rails `oneclick` adapter and the
 * `nearpay-sandbox` mirror validate against the same schemas (sandbox LLD §7, schema parity).
 * Fields NearPay does not use are kept optional and loose so provider additions never break parsing.
 */
import { out, z } from "@nearpay/spec";

const AmountString = z.string().regex(/^\d+$/).describe("Integer amount in base units, as a string.");

export const OneClickAppFee = out({
  recipient: z.string().describe("Intents account receiving the fee."),
  fee: z.int().min(0).max(10_000).describe("Fee in bps of amountIn."),
}).meta({ id: "OneClickAppFee", description: "1Click app fee." });

export const OneClickQuoteRequest = out({
  dry: z.boolean().describe("Dry run (no deposit address)."),
  depositMode: z.enum(["SIMPLE", "MEMO"]).optional().describe("Deposit address mode."),
  swapType: z.enum(["EXACT_INPUT", "EXACT_OUTPUT", "FLEX_INPUT", "ANY_INPUT"]).describe("How `amount` is interpreted."),
  slippageTolerance: z.int().min(0).max(10_000).describe("Slippage, bps."),
  originAsset: z.string().describe("Origin asset id."),
  depositType: z.enum(["ORIGIN_CHAIN", "INTENTS", "CONFIDENTIAL_INTENTS"]).describe("Deposit address type."),
  destinationAsset: z.string().describe("Destination asset id."),
  amount: AmountString,
  refundTo: z.string().describe("Refund address."),
  refundType: z.enum(["ORIGIN_CHAIN", "INTENTS", "CONFIDENTIAL_INTENTS"]).describe("Refund address type."),
  recipient: z.string().describe("Recipient address."),
  connectedWallets: z.array(z.string()).optional().describe("Connected wallets."),
  sessionId: z.string().optional().describe("Client session id."),
  virtualChainRecipient: z.string().optional().describe("Virtual-chain recipient."),
  virtualChainRefundRecipient: z.string().optional().describe("Virtual-chain refund recipient."),
  customRecipientMsg: z.string().optional().describe("ft_transfer_call message (experimental)."),
  recipientType: z.enum(["DESTINATION_CHAIN", "INTENTS", "CONFIDENTIAL_INTENTS"]).describe("Recipient type."),
  deadline: z.string().describe("ISO deadline after which refunds begin."),
  confidentiality: z.enum(["public", "basic", "advanced"]).optional().describe("Confidentiality mode."),
  referral: z.string().optional().describe("Referral id (`nearpay`)."),
  rebates: z.array(z.unknown()).optional().describe("Rebates (unused)."),
  quoteWaitingTimeMs: z.int().min(0).optional().describe("Quote wait, ms."),
  appFees: z.array(OneClickAppFee).optional().describe("App fees."),
  insured: z.boolean().optional().describe("Insured swap."),
}).meta({ id: "OneClickQuoteRequest", description: "1Click `POST /v0/quote` request." });
export type OneClickQuoteRequest = z.infer<typeof OneClickQuoteRequest>;

export const OneClickQuote = out({
  depositAddress: z.string().optional().describe("Deposit address (absent on dry runs)."),
  depositMemo: z.string().optional().describe("Deposit memo."),
  amountIn: AmountString,
  amountInFormatted: z.string().describe("Readable amountIn."),
  amountInUsd: z.string().describe("USD value of amountIn."),
  minAmountIn: AmountString,
  amountOut: AmountString,
  amountOutFormatted: z.string().describe("Readable amountOut."),
  amountOutUsd: z.string().describe("USD value of amountOut."),
  minAmountOut: AmountString,
  deadline: z.string().optional().describe("Deposit deadline (ISO)."),
  timeWhenInactive: z.string().optional().describe("When the address goes cold (ISO)."),
  timeEstimate: z.number().describe("Estimated seconds to execute."),
  refundFee: z.string().optional().describe("Refund fee, origin base units."),
  withdrawFee: z.string().optional().describe("Withdraw fee, destination base units."),
}).meta({ id: "OneClickQuote", description: "1Click quote." });

export const OneClickQuoteResponse = out({
  correlationId: z.string().describe("Trace id."),
  timestamp: z.string().describe("ISO timestamp used to derive the deposit address."),
  signature: z.string().describe("1Click signature over the quote."),
  quoteRequest: OneClickQuoteRequest,
  quote: OneClickQuote,
}).meta({ id: "OneClickQuoteResponse", description: "1Click `POST /v0/quote` response." });
export type OneClickQuoteResponse = z.infer<typeof OneClickQuoteResponse>;

export const ONECLICK_STATUSES = [
  "KNOWN_DEPOSIT_TX",
  "PENDING_DEPOSIT",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
] as const;

const TxDetails = out({
  hash: z.string().describe("Transaction hash."),
  explorerUrl: z.string().describe("Explorer URL."),
}).describe("A transaction.");

export const OneClickSwapDetails = out({
  intentHashes: z.array(z.string()).describe("Intent hashes."),
  nearTxHashes: z.array(z.string()).describe("NEAR transactions."),
  amountIn: z.string().optional().describe("Settled amountIn."),
  amountInFormatted: z.string().optional().describe("Readable."),
  amountInUsd: z.string().optional().describe("USD."),
  amountOut: z.string().optional().describe("Settled amountOut."),
  amountOutFormatted: z.string().optional().describe("Readable."),
  amountOutUsd: z.string().optional().describe("USD."),
  slippage: z.number().optional().describe("Actual slippage."),
  originChainTxHashes: z.array(TxDetails).describe("Origin-chain transactions."),
  destinationChainTxHashes: z.array(TxDetails).describe("Destination-chain transactions."),
  refundedAmount: z.string().optional().describe("Refunded amount."),
  refundedAmountFormatted: z.string().optional().describe("Readable."),
  refundedAmountUsd: z.string().optional().describe("USD."),
  refundReason: z.string().optional().describe("Refund reason (e.g. `PARTIAL_DEPOSIT`)."),
  depositedAmount: z.string().optional().describe("Deposited amount."),
  depositedAmountFormatted: z.string().optional().describe("Readable."),
  depositedAmountUsd: z.string().optional().describe("USD."),
  withdrawFee: z.string().optional().describe("Withdraw fee."),
  referral: z.string().optional().describe("Referral id."),
}).meta({ id: "OneClickSwapDetails", description: "1Click swap details." });

/**
 * `GET /v0/status` / `POST /v0/deposit/submit` response. `status` is a plain string: unknown
 * values must map to `held` + alert, never fail parsing (domain-model §4.3).
 */
export const OneClickStatusResponse = out({
  correlationId: z.string().describe("Trace id."),
  quoteResponse: OneClickQuoteResponse,
  status: z.string().describe(`Provider status (${ONECLICK_STATUSES.join(", ")} or unknown).`),
  updatedAt: z.string().describe("Last update (ISO)."),
  swapDetails: OneClickSwapDetails,
}).meta({ id: "OneClickStatusResponse", description: "1Click execution status." });
export type OneClickStatusResponse = z.infer<typeof OneClickStatusResponse>;

export const OneClickSubmitDepositRequest = out({
  txHash: z.string().describe("Deposit transaction hash."),
  depositAddress: z.string().describe("Deposit address."),
  nearSenderAccount: z.string().optional().describe("Sender (NEAR only)."),
  memo: z.string().optional().describe("Memo."),
}).meta({ id: "OneClickSubmitDepositRequest", description: "1Click `POST /v0/deposit/submit` request." });

export const OneClickToken = out({
  assetId: z.string().describe("Asset id."),
  decimals: z.int().describe("Decimals."),
  blockchain: z.string().describe("Blockchain code."),
  symbol: z.string().describe("Symbol."),
  price: z.number().describe("USD price."),
  priceUpdatedAt: z.string().describe("Price timestamp."),
  contractAddress: z.string().optional().describe("Contract address."),
  coingeckoId: z.string().optional().describe("CoinGecko id."),
}).meta({ id: "OneClickToken", description: "1Click token." });

export const OneClickError = out({ message: z.string().describe("Error message.") }).meta({
  id: "OneClickError",
  description: "1Click 4xx body.",
});
