/**
 * Compliance cases (lld/compliance.md §4 `cases`) — stage 2, contracts integration.
 *
 * The case object is read and driven by operators through the console routes in `./ops.ts`
 * (`/ops/cases…`). Services open cases through `createInternalCase`: in Stage 2 payments opens a
 * `reconciliation_diff` case for every reconciliation run that ends in `diff` or `error` (RB-05),
 * so reconciliation differences land in the same queue as screening hits and audit findings.
 */
import { closedEnum, id, inp, openEnum, out, route, UnixTime, z } from "@nearpay/spec";

export const CaseKind = openEnum(
  ["screening_hit", "post_screen_hit", "held_execution", "audit_mismatch", "merchant_report", "reconciliation_diff"],
  "Why the case was opened.",
);
export const CaseSeverity = openEnum(["low", "medium", "high", "critical"], "Severity.");
export const CaseStatus = openEnum(["open", "investigating", "closed"], "Case status.");
export const CaseResolution = openEnum(
  ["no_action", "false_positive", "merchant_contacted", "destination_blocked", "account_suspended", "other"],
  "How the case was resolved.",
);

export const ComplianceCase = out({
  id: id("case"),
  object: z.literal("compliance_case").describe("Always `compliance_case`."),
  account_id: id("acct").nullable().describe("Account concerned, if any."),
  livemode: z.boolean().describe("Mode."),
  kind: CaseKind,
  subject: out({
    type: z.string().describe("Object type, e.g. `execution`, `settlement_destination`, `address`."),
    id: z.string().describe("Object id or address."),
  }).describe("What the case is about."),
  severity: CaseSeverity,
  status: CaseStatus,
  assignee: id("usr").nullable().describe("Operator working on the case."),
  resolution: CaseResolution.nullable(),
  review: z.boolean().describe("Whether the merchant sees it as a review (`review.opened` was emitted)."),
  created: UnixTime.describe("Opened."),
  closed_at: UnixTime.nullable().describe("Closed."),
  // spec 0.2.1 — console CR
  account_display_name: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Display name of `account_id` (kept current from `evt.identity.account.*`); null for platform cases or when unknown (spec 0.2.1).",
    ),
  events: z
    .array(
      out({
        actor: z.string().describe("`usr_…` (operator), `cli:<actor>` or `system`."),
        action: openEnum(["opened", "assigned", "unassigned", "commented", "closed"], "What happened."),
        note: z.string().nullable().describe("Comment or resolution note."),
        at: UnixTime.describe("When."),
      }),
    )
    .optional()
    .describe("Timeline, oldest first; present on retrieve and on write responses, absent in lists."),
}).meta({ id: "ComplianceCase", description: "A compliance case (screening hit, held execution, audit finding, …)." });

// stage 2 — contracts integration: services open cases (payments → compliance)
export const createInternalCase = route({
  id: "createInternalCase",
  method: "POST",
  path: "/internal/cases",
  service: "compliance",
  visibility: "internal",
  summary: "Open a compliance case on behalf of a service (payments: `reconciliation_diff`).",
  description:
    "Payments calls it when a reconciliation run ends in `diff` or `error` (subject `reconciliation_run` / `rcn_…`), with `Idempotency-Key: rcn:<run id>` so a retried call opens one case. The case is never a merchant review (`review: false`, no `review.opened`). Only ids and operator-facing text: no personal data.",
  auth: ["service:compliance.cases.write"],
  idempotent: true,
  body: inp({
    kind: closedEnum(
      ["reconciliation_diff"],
      "Case kind a service may open (stage 2: payments' reconciliation diffs).",
    ),
    account_id: id("acct"),
    livemode: z.boolean().describe("Mode of the object concerned."),
    subject: inp({
      type: closedEnum(["reconciliation_run"], "Object type."),
      id: id("rcn", "Reconciliation run with diffs."),
    }).describe("What the case is about."),
    severity: CaseSeverity.optional().describe("Default `high` (any reconciliation diff pages ops)."),
    note: z
      .string()
      .min(1)
      .max(2000)
      .describe(
        "Opening note for operators, e.g. `2 diffs: missing_evidence ×1, amount_mismatch ×1` (no personal data).",
      ),
  }),
  response: ComplianceCase,
  status: 201,
  errors: [],
  stage: 2,
});
