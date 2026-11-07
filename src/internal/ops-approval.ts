/**
 * Two-person approvals of console actions (stage 2 — identity-console; lld/dashboard-and-console.md
 * §2, architecture/security.md T-12, sentinel §8 "two-person release").
 *
 * The owning service (compliance for account suspension, sentinel for the kill-switch release)
 * stores the request and executes the action in the transaction that records the approval.
 * Server-side rules, checked on the verified ops principal (`sub` = operator user id) and never
 * on anything the client sends:
 * - the approver holds `ops_admin` and is a **different operator** (`sub`) than the requester,
 *   else `403 approver_conflict` (a second session or passkey of the same operator does not count);
 * - requester and approver both have a fresh step-up (≤ 10 min);
 * - at most one `pending` request per target (`409 state_conflict`); the target must still allow
 *   the action when approved (else the request becomes `expired` and the call is `409 state_conflict`);
 * - pending requests expire (`expires_at`: kill-switch release 1 h, account actions 24 h);
 * - rejecting executes nothing, so any `ops_admin` (the requester included, to withdraw) may reject.
 */
import { id, OpsRoleSchema, openEnum, out, UnixTime, z } from "@nearpay/spec";

export const OpsApprovalAction = openEnum(
  ["account.suspend", "account.reinstate", "kill_switch.release"],
  "Action that needs a second approver.",
);

export const OpsApproval = out({
  id: id("opa"),
  object: z.literal("ops_approval").describe("Always `ops_approval`."),
  action: OpsApprovalAction,
  target: out({
    type: openEnum(["account", "kill_switch"], "Target type."),
    id: z.string().describe("`acct_…` or `ks_…`."),
  }).describe("What the action applies to."),
  reason: z.string().describe("Requester's reason (audited; never shown to merchants)."),
  status: openEnum(
    ["pending", "approved", "rejected", "expired"],
    "`approved` means the action was executed in the same transaction.",
  ),
  requested_by: out({
    id: id("usr"),
    role: OpsRoleSchema,
  }).describe("Requesting operator."),
  requested_at: UnixTime.describe("When it was requested."),
  decided_by: out({
    id: id("usr"),
    role: OpsRoleSchema,
  })
    .nullable()
    .describe("Approving or rejecting operator."),
  decided_at: UnixTime.nullable().describe("When it was decided."),
  decision_note: z.string().nullable().describe("Note of the deciding operator."),
  expires_at: UnixTime.describe("A pending request expires at this time."),
}).meta({ id: "OpsApproval", description: "A console action waiting for (or decided by) a second operator." });
export type OpsApproval = z.infer<typeof OpsApproval>;
