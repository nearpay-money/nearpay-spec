/**
 * Compliance reviews as merchants see them (`review.opened` / `review.closed` webhooks; webhooks §4,
 * domain-model §5) — Stage 2. A review never changes a payment's state: the payment stands (INV-1).
 *
 * The bus object (`evt.compliance.review.*`, `Review` in `@nearpay-internal/spec`) is rendered into
 * this shape by webhooks (`toPublicReview`): RFC 3339 times become unix seconds, and a review of a
 * rails execution is shown as a review of its payment intent (executions are never exposed).
 */
import { id } from "../common/ids.js";
import { Livemode, UnixTime } from "../common/primitives.js";
import { openEnum, out, z } from "../common/schema.js";

export const PublicReviewSubjectType = openEnum(
  ["payment_intent", "agent_payment", "settlement_destination"],
  "Reviewed object type.",
);

export const PublicReview = out({
  id: id("case"),
  object: z.literal("review").describe("Always `review`."),
  created: UnixTime.describe("When the review opened."),
  livemode: Livemode,
  subject: out({
    type: PublicReviewSubjectType,
    id: z.string().describe("Reviewed object id (`pi_…`, `ap_…` or `sd_…`)."),
  }).describe("What is under review."),
  reason: openEnum(["post_screen_hit", "held_execution", "audit_mismatch", "screening_hit"], "Why the review opened."),
  status: openEnum(["open", "closed"], "Review status."),
  closed_at: UnixTime.nullable().describe("When the review closed."),
}).meta({ id: "PublicReview", description: "A compliance review of a payment or destination (the payment stands)." });
export type PublicReview = z.infer<typeof PublicReview>;
