/**
 * Domain events on NATS JetStream (lld/00-foundations.md §8, ADR-0004).
 *
 * Every subject is `evt.<domain>.<aggregate>.<event>`. Payloads carry IDs and non-personal
 * fields only (L-F-02). Consumers dedupe on `id` (inbox) and ignore `aggregate.version` ≤ the
 * last applied version.
 */
import {
  Account,
  AgentPayment,
  ApiKey,
  CheckoutSession,
  CountryCode,
  closedEnum,
  id,
  KybStatus,
  OpsRoleSchema,
  openEnum,
  out,
  PaymentIntent,
  type PublicReview,
  Refund,
  RequestId,
  RoleSchema,
  type ServiceName,
  Timestamp,
  Uuid,
  z,
} from "@nearpay/spec";
import { InternalSettlementDestination } from "../internal/identity.js";
import { OpsApproval } from "../internal/ops-approval.js";
import { Execution } from "../internal/rails.js";

// ---------------------------------------------------------------------------------------------
// Payload objects that only exist on the bus
// ---------------------------------------------------------------------------------------------

export const KybDecisionEvent = out({
  account_id: id("acct"),
  status: KybStatus,
  reason: z.string().nullable().describe("Decision reason (internal: never shown to merchants)."),
  // stage 2 — identity-console
  requested_info: z
    .string()
    .nullable()
    .optional()
    .describe(
      "What ops asked the merchant for (`needs_info`; shown in the `kyb.decision` mail). Absent before Stage 2.",
    ),
}).meta({ id: "KybDecisionEvent", description: "A KYB decision." });

export const DestinationBlockedEvent = out({
  destination_id: id("sd"),
  account_id: id("acct"),
  reason: z.string().describe("Why it was blocked."),
}).meta({ id: "DestinationBlockedEvent", description: "Compliance blocked a destination." });

export const AccountStatusEvent = out({
  account_id: id("acct"),
  reason: z.string().describe("Reason."),
}).meta({ id: "AccountStatusEvent", description: "Compliance suspended or reinstated an account." });

export const Review = out({
  id: id("case"),
  object: z.literal("review").describe("Always `review`."),
  account_id: id("acct"),
  subject: out({
    type: openEnum(
      ["payment_intent", "agent_payment", "settlement_destination", "execution"],
      "Reviewed object type (`execution`: a rails execution; payments maps it to its payment intent).",
    ),
    id: z.string().describe("Reviewed object id."),
  }).describe("What is under review."),
  reason: openEnum(["post_screen_hit", "held_execution", "audit_mismatch", "screening_hit"], "Why."),
  status: openEnum(["open", "closed"], "Review status."),
  opened_at: Timestamp.describe("Opened."),
  closed_at: Timestamp.nullable().describe("Closed."),
  // stage 2 — payments
  payment_intent: id("pi")
    .nullable()
    .optional()
    .describe(
      "Payment intent of an `execution` subject (from `Execution.reference`); webhooks shows such a review as one of this intent.",
    ),
}).meta({ id: "Review", description: "A compliance review of a payment (payment stands; INV-1)." });

export const PolicyUpdatedEvent = out({
  version: z.string().describe("Policy version."),
  blocked_countries: z.array(CountryCode).describe("Blocked countries."),
  blocked_regions: z.array(z.string()).describe("Blocked regions."),
}).meta({ id: "PolicyUpdatedEvent", description: "Geo policy changed." });

export const KillSwitchEvent = out({
  engaged: z.boolean().describe("Engaged or released."),
  reason: z.string().describe("Reason."),
  actor: z.string().describe("Who."),
}).meta({ id: "KillSwitchEvent", description: "Kill switch changed." });

export const AuditFinding = out({
  id: id("fnd"),
  execution_id: id("ex"),
  account_id: id("acct"),
  livemode: z.boolean().describe("Mode."),
  check_kind: z.string().describe("Which independent check ran."),
  result: openEnum(["pass", "mismatch", "unverifiable"], "Result."),
  details: z.record(z.string(), z.unknown()).describe("Details."),
}).meta({ id: "AuditFinding", description: "Sentinel independent re-verification finding." });

export const EndpointDisabledEvent = out({
  endpoint_id: id("we"),
  account_id: id("acct"),
  url: z.url().describe("Endpoint URL."),
  reason: openEnum(["failing"], "Why."),
  failing_since: Timestamp.describe("First failure of the streak."),
}).meta({ id: "EndpointDisabledEvent", description: "A webhook endpoint was disabled after 72 h of failures." });

// stage 2 — identity-console
export const MemberEvent = out({
  account_id: id("acct"),
  user_id: id("usr"),
  role: RoleSchema,
  previous_role: RoleSchema.nullable().describe("Role before a change (`role_changed`); null otherwise."),
  actor_user_id: id("usr")
    .nullable()
    .describe("Owner/admin who made the change; null when the user accepted an invitation."),
}).meta({ id: "MemberEvent", description: "A team change (ids only; notify resolves emails through identity)." });

export const KybSubmittedEvent = out({
  account_id: id("acct"),
  status: KybStatus,
  submitted_at: Timestamp.describe("Submission time."),
}).meta({ id: "KybSubmittedEvent", description: "The owner submitted self-declared business details for review." });

// stage 2 — contracts integration: unified console audit trail (T-12)
export const OpsActionEvent = out({
  id: Uuid.describe(
    "Action id (UUIDv7, bare); identity dedupes `audit_events` on it and uses it as the audit event id. The envelope `aggregate.id` is the same uuid as a prefixed id, `aud_<TypeID suffix>` (the outbox keys aggregates by prefixed id; spec 0.2.1 clarification).",
  ),
  actor: out({
    sub: id("usr").describe(
      "Operator user id (`sub` of the ops principal). Ops CLI actions are not published as ops-action events (they stay in the owning service's own log); a CLI actor would be a breaking change to this event (spec 0.2.1 decision).",
    ),
    ops_role: OpsRoleSchema,
  }).describe("Operator who acted (ids only; identity resolves the email for display)."),
  action: z
    .string()
    .min(1)
    .max(100)
    .describe(
      "Action, `<object>.<verb>`, e.g. `case.closed`, `blocklist_entry.added`, `kill_switch.engaged`, `kill_switch.release_approved`, `finding.acknowledged`.",
    ),
  target: out({
    type: z.string().min(1).max(64).describe("Object type, e.g. `compliance_case`, `blocklist_entry`, `kill_switch`."),
    id: z.string().min(1).max(128).describe("Object id (prefixed id, or a fixed name such as `global`)."),
  }).describe("Object acted on."),
  account_id: id("acct").nullable().describe("Merchant account concerned, if any (the `audit_events.account`)."),
  approval: id("opa").nullable().describe("Two-person approval the action completed, if any."),
  occurred_at: Timestamp.describe("When the action committed."),
}).meta({
  id: "OpsActionEvent",
  description:
    "A console operator action recorded by the owning service; identity copies it into `audit_events` so the console audit log is one trail. Ids only: no emails, notes or addresses.",
});

// spec 0.2.1 — identity CR: account recovery (notify `security.recovery`)
export const UserRecoveredEvent = out({
  user_id: id("usr"),
  account_ids: z
    .array(id("acct"))
    .describe("Accounts where the user is owner or admin: each gets the 48 h recovery lock and its owners are told."),
  recovered_at: Timestamp.describe("When the new passkey was registered."),
  lock_until: Timestamp.describe("End of the recovery lock on destination and team changes (48 h)."),
}).meta({
  id: "UserRecoveredEvent",
  description:
    "A user regained access by email recovery and registered a new passkey (platform event; ids only, notify resolves emails through identity).",
});

// spec 0.2.1 — webhooks CR: signing-secret rotation (notify tells developers/owners)
export const EndpointSecretRotatedEvent = out({
  endpoint_id: id("we"),
  account_id: id("acct"),
  url: z.url().describe("Endpoint URL."),
  previous_secret_expires_at: Timestamp.nullable().describe(
    "Until when deliveries still carry a signature with the previous secret; null when it was dropped at once.",
  ),
  actor_user_id: id("usr").nullable().describe("Dashboard user who rotated it; null for an API key."),
}).meta({
  id: "EndpointSecretRotatedEvent",
  description: "A webhook endpoint's signing secret was rotated (never the secret).",
});

export const ApiKeyEvent = ApiKey.omit({ secret: true }).meta({
  id: "ApiKeyEvent",
  description: "API key record (never the secret).",
});

/** Checkout session on the bus: never the client secret or URL (they embed the secret). */
export const CheckoutSessionEvent = CheckoutSession.extend({
  url: z.null().describe("Always null on the bus."),
  client_secret: z.null().describe("Always null on the bus."),
}).meta({ id: "CheckoutSessionEvent", description: "Checkout session snapshot (no secrets)." });

// ---------------------------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------------------------

export type Consumer = ServiceName;

export interface SubjectDefinition {
  readonly object: z.ZodType;
  readonly aggregate: string;
  readonly producer: ServiceName;
  readonly consumers: readonly Consumer[];
  readonly stage: 1 | 2 | 3 | 4;
}

const s = (d: SubjectDefinition) => d;

/** Every Stage-1 subject: payload, producer and consumers (from the component LLDs §7). */
export const SUBJECTS = {
  // identity (identity §7)
  "evt.identity.account.created": s({
    object: Account,
    aggregate: "account",
    producer: "identity",
    consumers: ["notify", "compliance", "sentinel" /* spec 0.2.1 — finding display names */],
    stage: 1,
  }),
  "evt.identity.account.updated": s({
    object: Account,
    aggregate: "account",
    producer: "identity",
    consumers: [
      "payments",
      "webhooks" /* stage 2 — identity-console: `account.updated` */,
      "compliance" /* spec 0.2.1 — case display names */,
      "sentinel" /* spec 0.2.1 — finding display names */,
    ],
    stage: 1,
  }),
  "evt.identity.settlement_destination.created": s({
    object: InternalSettlementDestination,
    aggregate: "settlement_destination",
    producer: "identity",
    consumers: ["payments"],
    stage: 1,
  }),
  "evt.identity.settlement_destination.cooling_off": s({
    object: InternalSettlementDestination,
    aggregate: "settlement_destination",
    producer: "identity",
    consumers: ["payments", "notify"],
    stage: 1,
  }),
  "evt.identity.settlement_destination.activated": s({
    object: InternalSettlementDestination,
    aggregate: "settlement_destination",
    producer: "identity",
    consumers: ["payments", "notify", "rails", "compliance"],
    stage: 1,
  }),
  "evt.identity.settlement_destination.disabled": s({
    object: InternalSettlementDestination,
    aggregate: "settlement_destination",
    producer: "identity",
    consumers: ["payments", "notify", "rails", "compliance", "sentinel"],
    stage: 1,
  }),
  "evt.identity.settlement_destination.default_changed": s({
    object: InternalSettlementDestination,
    aggregate: "settlement_destination",
    producer: "identity",
    consumers: ["payments"],
    stage: 1,
  }),
  "evt.identity.api_key.created": s({
    object: ApiKeyEvent,
    aggregate: "api_key",
    producer: "identity",
    consumers: ["identity"],
    stage: 1,
  }),
  "evt.identity.api_key.revoked": s({
    object: ApiKeyEvent,
    aggregate: "api_key",
    producer: "identity",
    consumers: ["identity"],
    stage: 1,
  }),

  // payments (payments §7)
  "evt.payments.checkout_session.completed": s({
    object: CheckoutSessionEvent,
    aggregate: "checkout_session",
    producer: "payments",
    consumers: ["webhooks"],
    stage: 1,
  }),
  "evt.payments.checkout_session.expired": s({
    object: CheckoutSessionEvent,
    aggregate: "checkout_session",
    producer: "payments",
    consumers: ["webhooks"],
    stage: 1,
  }),
  "evt.payments.payment_intent.created": s({
    object: PaymentIntent,
    aggregate: "payment_intent",
    producer: "payments",
    consumers: ["webhooks"],
    stage: 1,
  }),
  "evt.payments.payment_intent.processing": s({
    object: PaymentIntent,
    aggregate: "payment_intent",
    producer: "payments",
    consumers: ["webhooks"],
    stage: 1,
  }),
  "evt.payments.payment_intent.succeeded": s({
    object: PaymentIntent,
    aggregate: "payment_intent",
    producer: "payments",
    consumers: ["webhooks", "notify"],
    stage: 1,
  }),
  "evt.payments.payment_intent.payment_failed": s({
    object: PaymentIntent,
    aggregate: "payment_intent",
    producer: "payments",
    consumers: ["webhooks"],
    stage: 1,
  }),
  "evt.payments.payment_intent.requires_review": s({
    object: PaymentIntent,
    aggregate: "payment_intent",
    producer: "payments",
    consumers: ["webhooks"],
    stage: 1,
  }),
  "evt.payments.payment_intent.overpaid": s({
    object: PaymentIntent,
    aggregate: "payment_intent",
    producer: "payments",
    consumers: ["webhooks"],
    stage: 1,
  }),
  "evt.payments.payment_intent.canceled": s({
    object: PaymentIntent,
    aggregate: "payment_intent",
    producer: "payments",
    consumers: ["webhooks"],
    stage: 1,
  }),
  "evt.payments.payment_intent.expired": s({
    object: PaymentIntent,
    aggregate: "payment_intent",
    producer: "payments",
    consumers: ["billing"],
    stage: 1,
  }),
  // stage 2 — payments (payments §7: refunds)
  "evt.payments.refund.created": s({
    object: Refund,
    aggregate: "refund",
    producer: "payments",
    consumers: ["webhooks"],
    stage: 2,
  }),
  "evt.payments.refund.requires_action": s({
    object: Refund,
    aggregate: "refund",
    producer: "payments",
    consumers: ["webhooks"],
    stage: 2,
  }),
  "evt.payments.refund.pending": s({
    object: Refund,
    aggregate: "refund",
    producer: "payments",
    consumers: ["webhooks"],
    stage: 2,
  }),
  "evt.payments.refund.succeeded": s({
    object: Refund,
    aggregate: "refund",
    producer: "payments",
    consumers: ["webhooks", "notify"],
    stage: 2,
  }),
  "evt.payments.refund.failed": s({
    object: Refund,
    aggregate: "refund",
    producer: "payments",
    consumers: ["webhooks"],
    stage: 2,
  }),
  "evt.payments.refund.canceled": s({
    object: Refund,
    aggregate: "refund",
    producer: "payments",
    consumers: ["webhooks"],
    stage: 2,
  }),

  // rails (rails §7)
  "evt.rails.execution.updated": s({
    object: Execution,
    aggregate: "execution",
    producer: "rails",
    consumers: ["payments"],
    stage: 1,
  }),
  "evt.rails.execution.settled": s({
    object: Execution,
    aggregate: "execution",
    producer: "rails",
    consumers: ["payments", "compliance", "sentinel", "agentpay" /* stage 3 — agent-commerce: owner agentpay */],
    stage: 1,
  }),
  "evt.rails.execution.refunded": s({
    object: Execution,
    aggregate: "execution",
    producer: "rails",
    consumers: ["payments", "agentpay" /* stage 3 — agent-commerce: owner agentpay */],
    stage: 1,
  }),
  "evt.rails.execution.failed": s({
    object: Execution,
    aggregate: "execution",
    producer: "rails",
    consumers: ["payments", "agentpay" /* stage 3 — agent-commerce: owner agentpay */],
    stage: 1,
  }),
  "evt.rails.execution.held": s({
    object: Execution,
    aggregate: "execution",
    producer: "rails",
    consumers: ["payments", "compliance"],
    stage: 1,
  }),

  // agentpay (agentpay §8)
  "evt.agentpay.agent_payment.settled": s({
    object: AgentPayment,
    aggregate: "agent_payment",
    producer: "agentpay",
    consumers: ["webhooks", "compliance"],
    stage: 1,
  }),
  "evt.agentpay.agent_payment.failed": s({
    object: AgentPayment,
    aggregate: "agent_payment",
    producer: "agentpay",
    consumers: ["webhooks"],
    stage: 1,
  }),

  // compliance (compliance §6)
  "evt.compliance.kyb.approved": s({
    object: KybDecisionEvent,
    aggregate: "kyb_case",
    producer: "compliance",
    consumers: ["identity", "notify"],
    stage: 1,
  }),
  "evt.compliance.kyb.rejected": s({
    object: KybDecisionEvent,
    aggregate: "kyb_case",
    producer: "compliance",
    consumers: ["identity", "notify"],
    stage: 1,
  }),
  "evt.compliance.kyb.needs_info": s({
    object: KybDecisionEvent,
    aggregate: "kyb_case",
    producer: "compliance",
    consumers: ["identity", "notify"],
    stage: 1,
  }),
  "evt.compliance.destination.blocked": s({
    object: DestinationBlockedEvent,
    aggregate: "settlement_destination",
    producer: "compliance",
    consumers: ["identity", "notify"],
    stage: 1,
  }),
  "evt.compliance.account.suspended": s({
    object: AccountStatusEvent,
    aggregate: "account",
    producer: "compliance",
    consumers: ["identity", "notify"],
    stage: 1,
  }),
  "evt.compliance.account.reinstated": s({
    object: AccountStatusEvent,
    aggregate: "account",
    producer: "compliance",
    consumers: ["identity", "notify"],
    stage: 1,
  }),
  "evt.compliance.review.opened": s({
    object: Review,
    aggregate: "case",
    producer: "compliance",
    consumers: ["payments", "notify", "webhooks"],
    stage: 1,
  }),
  "evt.compliance.review.closed": s({
    object: Review,
    aggregate: "case",
    producer: "compliance",
    consumers: ["payments", "notify", "webhooks"],
    stage: 1,
  }),
  "evt.compliance.policy.updated": s({
    object: PolicyUpdatedEvent,
    aggregate: "policy",
    producer: "compliance",
    consumers: ["payments"],
    stage: 1,
  }),

  // sentinel (sentinel §7)
  "evt.sentinel.kill_switch.engaged": s({
    object: KillSwitchEvent,
    aggregate: "kill_switch",
    producer: "sentinel",
    consumers: ["rails", "agentpay", "notify", "payments" /* stage 2 — kill switch blocks live refund legs */],
    stage: 1,
  }),
  "evt.sentinel.kill_switch.released": s({
    object: KillSwitchEvent,
    aggregate: "kill_switch",
    producer: "sentinel",
    consumers: ["rails", "agentpay", "notify", "payments" /* stage 2 — kill switch blocks live refund legs */],
    stage: 1,
  }),
  "evt.sentinel.audit_finding.created": s({
    object: AuditFinding,
    aggregate: "audit_finding",
    producer: "sentinel",
    consumers: ["compliance", "notify"],
    stage: 1,
  }),

  // webhooks (webhooks §7)
  "evt.webhooks.endpoint.disabled": s({
    object: EndpointDisabledEvent,
    aggregate: "webhook_endpoint",
    producer: "webhooks",
    consumers: ["notify"],
    stage: 1,
  }),

  // stage 2 — identity-console
  "evt.identity.member.added": s({
    object: MemberEvent,
    aggregate: "membership",
    producer: "identity",
    consumers: ["notify"],
    stage: 2,
  }),
  "evt.identity.member.removed": s({
    object: MemberEvent,
    aggregate: "membership",
    producer: "identity",
    consumers: ["notify"],
    stage: 2,
  }),
  "evt.identity.member.role_changed": s({
    object: MemberEvent,
    aggregate: "membership",
    producer: "identity",
    consumers: ["notify"],
    stage: 2,
  }),
  "evt.identity.settlement_destination.pending_approval": s({
    object: InternalSettlementDestination,
    aggregate: "settlement_destination",
    producer: "identity",
    consumers: ["notify"],
    stage: 2,
  }),
  "evt.compliance.kyb.submitted": s({
    object: KybSubmittedEvent,
    aggregate: "kyb_case",
    producer: "compliance",
    consumers: ["identity", "notify"],
    stage: 2,
  }),
  "evt.compliance.account.action_requested": s({
    object: OpsApproval,
    aggregate: "ops_approval",
    producer: "compliance",
    consumers: ["notify"],
    stage: 2,
  }),
  "evt.sentinel.kill_switch.release_requested": s({
    object: OpsApproval,
    aggregate: "ops_approval",
    producer: "sentinel",
    consumers: ["notify"],
    stage: 2,
  }),

  // stage 2 — contracts integration: operator actions for the unified audit trail (T-12)
  "evt.compliance.ops_action.recorded": s({
    object: OpsActionEvent,
    aggregate: "ops_action",
    producer: "compliance",
    consumers: ["identity"],
    stage: 2,
  }),
  "evt.sentinel.ops_action.recorded": s({
    object: OpsActionEvent,
    aggregate: "ops_action",
    producer: "sentinel",
    consumers: ["identity"],
    stage: 2,
  }),
  "evt.payments.ops_action.recorded": s({
    object: OpsActionEvent,
    aggregate: "ops_action",
    producer: "payments",
    consumers: ["identity"],
    stage: 2,
  }),
  "evt.rails.ops_action.recorded": s({
    object: OpsActionEvent,
    aggregate: "ops_action",
    producer: "rails",
    consumers: ["identity"],
    stage: 2,
  }),

  // spec 0.2.1 — stage 2 change requests
  "evt.identity.user.recovered": s({
    object: UserRecoveredEvent,
    aggregate: "user",
    producer: "identity",
    consumers: ["notify"],
    stage: 2,
  }),
  "evt.webhooks.endpoint.secret_rotated": s({
    object: EndpointSecretRotatedEvent,
    aggregate: "webhook_endpoint",
    producer: "webhooks",
    consumers: ["notify"],
    stage: 2,
  }),
} as const satisfies Record<string, SubjectDefinition>;

export type Subject = keyof typeof SUBJECTS;
export const SUBJECT_NAMES = Object.keys(SUBJECTS) as [Subject, ...Subject[]];
export const SUBJECT_RE = /^evt\.[a-z]+\.[a-z_]+\.[a-z_]+$/;

// ---------------------------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------------------------

const envelopeShape = {
  id: Uuid.describe("Event id (UUIDv7); also the NATS `Nats-Msg-Id` for de-duplication."),
  occurred_at: Timestamp.describe("When the state change committed."),
  account_id: Uuid.nullable().describe("Merchant account UUID (null for platform events)."),
  livemode: z.boolean().nullable().describe("Mode (null for platform events)."),
  aggregate: out({
    type: z.string().describe("Aggregate type."),
    id: z.string().describe("Aggregate id (prefixed)."),
    version: z.int().min(0).describe("Aggregate version after the change."),
  }).describe("The aggregate that changed."),
  request: out({
    id: RequestId.nullable().describe("API request that caused the change."),
    idempotency_key: z.string().nullable().describe("Its Idempotency-Key."),
  })
    .optional()
    .describe("Request context (copied into public events)."),
  trace: out({ traceparent: z.string().describe("W3C traceparent.") })
    .optional()
    .describe("Trace context."),
};

/** Envelope with a typed `data.object` for one subject. */
export function envelopeOf<S extends Subject>(subject: S) {
  return out({
    ...envelopeShape,
    subject: z.literal(subject).describe("Subject."),
    data: out({
      object: SUBJECTS[subject].object,
      previous: z.record(z.string(), z.unknown()).optional().describe("Changed fields with previous values."),
    }).describe("Payload."),
  }).describe(`Envelope of \`${subject}\`.`);
}

/** Envelope with an untyped payload (relays, dead letters, unknown subjects). */
export const EventEnvelope = out({
  ...envelopeShape,
  subject: z.string().regex(SUBJECT_RE).describe("Subject `evt.<domain>.<aggregate>.<event>`."),
  data: out({
    object: z.record(z.string(), z.unknown()).describe("Object snapshot."),
    previous: z.record(z.string(), z.unknown()).optional().describe("Previous values."),
  }).describe("Payload."),
}).meta({ id: "EventEnvelope", description: "Domain event envelope (foundations §8)." });
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/** Typed envelope union for every Stage-1 subject. */
export const DomainEvent = z
  .discriminatedUnion(
    "subject",
    SUBJECT_NAMES.map((n) => envelopeOf(n)) as unknown as [
      ReturnType<typeof envelopeOf>,
      ...ReturnType<typeof envelopeOf>[],
    ],
  )
  .meta({ id: "DomainEvent", description: "Any Stage-1 domain event." });

// ---------------------------------------------------------------------------------------------
// Streams and consumers
// ---------------------------------------------------------------------------------------------

export interface StreamDefinition {
  readonly name: string;
  readonly subjects: readonly string[];
  readonly storage: "file";
  readonly maxAgeSeconds: number;
  readonly duplicateWindowSeconds: number;
}

const stream = (domain: string): StreamDefinition => ({
  name: `EVT_${domain.toUpperCase()}`,
  subjects: [`evt.${domain}.>`],
  storage: "file",
  maxAgeSeconds: 7 * 24 * 3600,
  duplicateWindowSeconds: 120,
});

/** One stream per producing domain (foundations §8). */
export const STREAMS = {
  identity: stream("identity"),
  payments: stream("payments"),
  billing: stream("billing"),
  rails: stream("rails"),
  agentpay: stream("agentpay"),
  compliance: stream("compliance"),
  sentinel: stream("sentinel"),
  webhooks: stream("webhooks"),
} as const;

/** Consumer defaults (foundations §8). */
export const CONSUMER_DEFAULTS = {
  ackWaitSeconds: 30,
  maxDeliver: 20,
  backoffSeconds: [1, 5, 30, 120, 600],
} as const;

/** Durable consumer name `<consumer>--<STREAM>`. */
export function durableName(consumer: ServiceName, streamName: string): string {
  return `${consumer}--${streamName}`;
}

/** Filter subjects a service consumes from one stream (derived from the catalogue). */
export function consumerFilters(consumer: ServiceName): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [subject, def] of Object.entries(SUBJECTS) as [Subject, SubjectDefinition][]) {
    if (!def.consumers.includes(consumer)) continue;
    const domain = subject.split(".")[1] as keyof typeof STREAMS;
    const st = STREAMS[domain];
    out[st.name] = [...(out[st.name] ?? []), subject];
  }
  return out;
}

/** Stream of a subject. */
export function streamOf(subject: string): StreamDefinition {
  const domain = subject.split(".")[1] as keyof typeof STREAMS;
  const st = STREAMS[domain];
  if (!st) throw new Error(`no stream for ${subject}`);
  return st;
}

/** Closed list of aggregate kinds seen on the bus (documentation). */
export const AggregateType = closedEnum(
  [
    "account",
    "settlement_destination",
    "api_key",
    "checkout_session",
    "payment_intent",
    "execution",
    "agent_payment",
    "kyb_case",
    "case",
    "policy",
    "kill_switch",
    "audit_finding",
    "webhook_endpoint",
    // stage 2 — payments
    "refund",
    // stage 2 — contracts integration (aggregates used by stage 2 subjects)
    "membership",
    "ops_approval",
    "ops_action",
    // spec 0.2.1
    "user",
  ],
  "Aggregate type.",
);

// stage 2 — payments
// ---------------------------------------------------------------------------------------------
// Public rendering of compliance reviews (webhooks §4: `review.opened` / `review.closed`)
// ---------------------------------------------------------------------------------------------

/**
 * Renders a bus `Review` as the public `PublicReview` delivered to merchants. A review of a rails
 * execution becomes a review of its payment intent; without one (`payment_intent` absent) the review
 * is not public and the function returns null (webhooks does not deliver it).
 */
export function toPublicReview(review: z.output<typeof Review>, livemode: boolean): PublicReview | null {
  const unix = (t: string) => Math.floor(Date.parse(t) / 1000);
  let subject: PublicReview["subject"];
  if (review.subject.type === "execution") {
    if (!review.payment_intent) return null;
    subject = { type: "payment_intent", id: review.payment_intent };
  } else if (
    review.subject.type === "payment_intent" ||
    review.subject.type === "agent_payment" ||
    review.subject.type === "settlement_destination"
  ) {
    subject = { type: review.subject.type, id: review.subject.id };
  } else {
    return null;
  }
  return {
    id: review.id,
    object: "review",
    created: unix(review.opened_at),
    livemode,
    subject,
    reason: review.reason,
    status: review.status,
    closed_at: review.closed_at ? unix(review.closed_at) : null,
  };
}
