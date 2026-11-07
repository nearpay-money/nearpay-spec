/**
 * Console (ops) routes — stage 2, identity-console (lld/dashboard-and-console.md §2, OQ-T-02).
 *
 * Served by the owning service under `/ops/…`; the gateway routes them only on the console host
 * (`ops.<domain>/api/ops/*` → `/api` stripped → ForwardAuth). Identity's authz accepts only the
 * `__Host-np_ops` cookie there, requires an active `ops_operators` row and a hardware-backed
 * passkey session, and mints `ptype=ops` with `sub` = operator user id, `ops_role` and the
 * role's scopes (`OPS_ROLE_SCOPES`). CSRF (`X-CSRF-Token`) applies to unsafe methods as on the
 * dashboard. `@nearpay-internal/service` checks scope, `opsRoles` and step-up from these
 * definitions before the handler runs. Every write is audited by the owning service with the
 * operator id. Merchant principals (sessions, keys) never reach these routes.
 */
import {
  Account,
  AttemptStatus,
  AuditEvent,
  AuthenticationResponseJSON,
  ChainAddress,
  ChainId,
  CreationOptionsJSON,
  closedEnum,
  createdFilterShape,
  id,
  inp,
  KybProfile,
  KybStatus,
  listOf,
  listQueryShape,
  OpsRoleSchema,
  openEnum,
  out,
  Refund,
  RegistrationResponseJSON,
  RequestOptionsJSON,
  route,
  UnixTime,
  z,
} from "@nearpay/spec";
import { AuditFinding } from "../events/catalogue.js";
import { CaseKind, CaseResolution, CaseSeverity, CaseStatus, ComplianceCase } from "./cases.js";
import { OpsApproval } from "./ops-approval.js";
import { ReconciliationResolution, ReconciliationRun, ReconciliationStatus } from "./payments.js";
import { Execution, ExecutionKind, ObservationPageQuery, Provider, ProviderObservationPage } from "./rails.js";
import { createScreening, KillSwitchState } from "./services.js";

const ALL = ["ops", "ops_admin"] as const;
const ADMIN = ["ops_admin"] as const;
const Note = z.string().min(1).max(2000);
const Reason = z.string().min(1).max(500);

// =============================================================================================
// identity — console sign-in (hardware passkeys, ops allow-list)
// =============================================================================================

export const OpsSession = out({
  object: z.literal("ops_session").describe("Always `ops_session`."),
  operator: out({
    id: id("usr"),
    email: z.email().describe("Operator email."),
  }).describe("Signed-in operator."),
  role: OpsRoleSchema,
  csrf_token: z.string().min(32).describe("Send as `X-CSRF-Token` on every unsafe request."),
  step_up_until: UnixTime.nullable().describe("Step-up is fresh until this time (sign-in counts as a step-up)."),
  idle_expires_at: UnixTime.describe("Session ends without activity at this time (30 min idle)."),
  expires_at: UnixTime.describe("Absolute session expiry (12 h)."),
}).meta({
  id: "OpsSession",
  description:
    "A console session. Sign-in responses set the cookie `__Host-np_ops` (host-only on the console host; a dashboard cookie is never accepted there).",
});

const ops = { service: "identity", visibility: "ops", stage: 2 } as const;

export const opsEnrolmentVerify = route({
  ...ops,
  id: "opsEnrolmentVerify",
  method: "POST",
  path: "/ops/auth/enrolment/verify",
  summary: "Exchange an operator enrolment link for a registration token.",
  description:
    "`operator-add <email> ops|ops_admin` (identity ops CLI) emails a single-use enrolment link (24 h, `ops.enrolment` template) to `<console>/auth/enrol#token=…`. Unknown, used or expired tokens and revoked operators all answer the same errors.",
  auth: ["anonymous"],
  idempotent: false,
  body: inp({ token: z.string().min(16).max(256).describe("Token from the enrolment link.") }),
  response: out({
    object: z.literal("ops_registration").describe("Always `ops_registration`."),
    registration_token: z.string().min(32).describe("Single-use token for hardware-passkey registration (5 minutes)."),
    email: z.email().describe("Operator email."),
    expires_at: UnixTime.describe("Registration token expiry."),
  }).meta({ id: "OpsRegistration", description: "A verified operator ready to register a hardware passkey." }),
  status: 200,
  errors: ["link_expired", "link_used"],
});

export const opsPasskeyRegistrationOptions = route({
  ...ops,
  id: "opsPasskeyRegistrationOptions",
  method: "POST",
  path: "/ops/auth/passkeys/registration/options",
  summary: "WebAuthn creation options for an operator's hardware passkey.",
  description:
    "Options request `attestation: direct`, `authenticatorAttachment: cross-platform`, a discoverable credential and user verification; RP id is the console host's.",
  auth: ["anonymous"],
  idempotent: false,
  body: inp({ registration_token: z.string().min(32).describe("Token from `opsEnrolmentVerify`.") }),
  response: CreationOptionsJSON,
  status: 200,
  errors: ["link_expired"],
});

export const opsPasskeyRegistrationVerify = route({
  ...ops,
  id: "opsPasskeyRegistrationVerify",
  method: "POST",
  path: "/ops/auth/passkeys/registration/verify",
  summary: "Register an operator's hardware passkey and sign in.",
  description:
    "The attestation must verify and its AAGUID must be on `NP_OPS_AAGUID_ALLOWLIST` (hardware security keys), else `403 authenticator_not_allowed`. Synced/platform passkeys are refused. Sets `__Host-np_ops`.",
  auth: ["anonymous"],
  idempotent: false,
  body: inp({
    registration_token: z.string().min(32).describe("Token from `opsEnrolmentVerify`."),
    credential: RegistrationResponseJSON,
    passkey_name: z.string().min(1).max(64).optional().describe("Label for the key."),
  }),
  response: OpsSession,
  status: 200,
  errors: ["webauthn_failed", "authenticator_not_allowed", "link_expired"],
});

export const opsPasskeyAuthenticationOptions = route({
  ...ops,
  id: "opsPasskeyAuthenticationOptions",
  method: "POST",
  path: "/ops/auth/passkeys/authentication/options",
  summary: "WebAuthn request options for console sign-in.",
  auth: ["anonymous"],
  idempotent: false,
  body: inp({}),
  response: RequestOptionsJSON,
  status: 200,
  errors: [],
});

export const opsPasskeyAuthenticationVerify = route({
  ...ops,
  id: "opsPasskeyAuthenticationVerify",
  method: "POST",
  path: "/ops/auth/passkeys/authentication/verify",
  summary: "Sign in to the console with a hardware passkey.",
  description:
    "Only credentials registered through operator enrolment are accepted (a dashboard passkey of the same user is not); the user must be an active operator. Every refusal is `401 webauthn_failed` (no enumeration). Sets `__Host-np_ops`; audited `ops.signed_in`.",
  auth: ["anonymous"],
  idempotent: false,
  body: inp({ credential: AuthenticationResponseJSON }),
  response: OpsSession,
  status: 200,
  errors: ["webauthn_failed"],
});

export const opsStepUpOptions = route({
  ...ops,
  id: "opsStepUpOptions",
  method: "POST",
  path: "/ops/auth/step_up/options",
  summary: "WebAuthn request options for an operator step-up.",
  auth: ["ops:console.session"],
  opsRoles: ALL,
  idempotent: false,
  body: inp({}),
  response: RequestOptionsJSON,
  status: 200,
  errors: [],
});

export const opsStepUpVerify = route({
  ...ops,
  id: "opsStepUpVerify",
  method: "POST",
  path: "/ops/auth/step_up/verify",
  summary: "Confirm a sensitive console action with the hardware passkey; fresh for 10 minutes.",
  auth: ["ops:console.session"],
  opsRoles: ALL,
  idempotent: false,
  body: inp({ credential: AuthenticationResponseJSON }),
  response: OpsSession,
  status: 200,
  errors: ["webauthn_failed"],
});

export const getOpsSession = route({
  ...ops,
  id: "getOpsSession",
  method: "GET",
  path: "/ops/auth/session",
  summary: "The current console session, including its CSRF token.",
  auth: ["ops:console.session"],
  opsRoles: ALL,
  idempotent: false,
  response: OpsSession,
  status: 200,
  errors: [],
});

export const opsLogout = route({
  ...ops,
  id: "opsLogout",
  method: "POST",
  path: "/ops/auth/logout",
  summary: "End the console session.",
  auth: ["ops:console.session"],
  opsRoles: ALL,
  idempotent: false,
  body: inp({}),
  response: null,
  status: 204,
  errors: [],
});

// =============================================================================================
// identity — merchants and audit log
// =============================================================================================

export const OpsMerchant = Account.extend({
  owners: z.array(out({ id: id("usr"), email: z.email().describe("Owner email.") })).describe("Owners of the account."),
  member_count: z.int().min(0).describe("Members of the account."),
  active_live_destinations: z.int().min(0).describe("Active live settlement destinations."),
  recovered_at: UnixTime.nullable().describe("Last account recovery (blocks destination changes for 48 h)."),
}).meta({ id: "OpsMerchant", description: "A merchant account as operators see it." });

export const listOpsMerchants = route({
  ...ops,
  id: "listOpsMerchants",
  method: "GET",
  path: "/ops/merchants",
  summary: "Search and list merchant accounts.",
  auth: ["ops:identity.merchants.read"],
  opsRoles: ALL,
  idempotent: false,
  query: inp({
    ...listQueryShape,
    ...createdFilterShape,
    q: z
      .string()
      .min(2)
      .max(200)
      .optional()
      .describe("Matches an `acct_` id exactly, a member email exactly, or display/legal name by prefix."),
    status: openEnum(["active", "suspended", "closed"], "Only accounts with this status.").optional(),
    kyb_status: KybStatus.optional().describe("Only accounts with this KYB status."),
    live_enabled: z.enum(["true", "false"]).optional().describe("Only accounts with (or without) live mode enabled."),
  }),
  response: listOf(OpsMerchant, "OpsMerchantList", "A page of merchant accounts."),
  status: 200,
  errors: [],
});

export const getOpsMerchant = route({
  ...ops,
  id: "getOpsMerchant",
  method: "GET",
  path: "/ops/merchants/{id}",
  summary: "Retrieve a merchant account.",
  auth: ["ops:identity.merchants.read"],
  opsRoles: ALL,
  idempotent: false,
  params: inp({ id: id("acct") }),
  response: OpsMerchant,
  status: 200,
  errors: [],
});

export const listOpsAuditEvents = route({
  ...ops,
  id: "listOpsAuditEvents",
  method: "GET",
  path: "/ops/audit_events",
  summary: "Platform audit log (merchant and operator actions), newest first.",
  auth: ["ops:identity.audit.read"],
  opsRoles: ALL,
  idempotent: false,
  query: inp({
    ...listQueryShape,
    ...createdFilterShape,
    account: id("acct").optional().describe("Only this account."),
    actor: z.string().max(64).optional().describe("Only this actor id (`usr_…`, `key_…`, service name)."),
    actor_type: openEnum(["user", "api_key", "operator", "service", "system"], "Only this actor type.").optional(),
    action: z.string().max(100).optional().describe("Only this action."),
    target: z.string().max(64).optional().describe("Only this target id."),
  }),
  response: listOf(AuditEvent, "OpsAuditEventList", "A page of audit events."),
  status: 200,
  errors: [],
});

// =============================================================================================
// compliance — KYB decisions queue
// =============================================================================================

const cmp = { service: "compliance", visibility: "ops", stage: 2 } as const;

export const OpsKybCase = out({
  object: z.literal("ops_kyb_case").describe("Always `ops_kyb_case`."),
  account_id: id("acct"),
  account_display_name: z.string().describe("Account display name (from identity, cached)."),
  status: KybStatus,
  profile: KybProfile,
  declared_by: id("usr").nullable().describe("Owner who submitted the declaration."),
  requested_info: z.string().nullable().describe("What was asked of the merchant (`needs_info`)."),
  decision_reason: z.string().nullable().describe("Internal reason of the last decision (never shown to merchants)."),
  decided_by: z.string().nullable().describe("Operator (`usr_…`) or CLI actor of the last decision."),
  created: UnixTime.describe("Case created."),
  submitted_at: UnixTime.nullable().describe("Last submission."),
  decided_at: UnixTime.nullable().describe("Last decision."),
  history: z
    .array(
      out({
        status: KybStatus,
        actor: z.string().describe("`usr_…` (owner or operator), `cli:<actor>` or `system`."),
        reason: z.string().nullable().describe("Reason or note."),
        at: UnixTime.describe("When."),
      }),
    )
    .describe("Transitions, oldest first."),
}).meta({ id: "OpsKybCase", description: "A KYB case with its self-declared details, for review." });

export const listOpsKybCases = route({
  ...cmp,
  id: "listOpsKybCases",
  method: "GET",
  path: "/ops/kyb_cases",
  summary: "KYB review queue (default: `pending`, oldest submission first).",
  auth: ["ops:compliance.read"],
  opsRoles: ALL,
  idempotent: false,
  query: inp({
    ...listQueryShape,
    status: KybStatus.optional().describe("Only cases with this status (default `pending`)."),
    account: id("acct").optional().describe("Only this account."),
  }),
  response: listOf(OpsKybCase, "OpsKybCaseList", "A page of KYB cases."),
  status: 200,
  errors: [],
});

export const getOpsKybCase = route({
  ...cmp,
  id: "getOpsKybCase",
  method: "GET",
  path: "/ops/kyb_cases/{id}",
  summary: "Retrieve an account's KYB case.",
  auth: ["ops:compliance.read"],
  opsRoles: ALL,
  idempotent: false,
  params: inp({ id: id("acct") }),
  response: OpsKybCase,
  status: 200,
  errors: [],
});

export const decideOpsKybCase = route({
  ...cmp,
  id: "decideOpsKybCase",
  method: "POST",
  path: "/ops/kyb_cases/{id}/decision",
  summary: "Approve, reject or ask for more information.",
  description:
    "Same use case and rules as the manual `decideKyb` (repeating the current decision is a no-op; a different decision transitions and emits `evt.compliance.kyb.<decision>`; identity recomputes live mode), plus: only `pending` cases may be approved, and `needs_info` needs `requested_info`, which the merchant sees. The actor is the operator id.",
  auth: ["ops:compliance.kyb.decide"],
  opsRoles: ALL,
  stepUp: true,
  idempotent: true,
  params: inp({ id: id("acct") }),
  body: inp({
    decision: closedEnum(["approved", "rejected", "needs_info"], "Decision."),
    reason: Reason.describe("Internal reason (audited; never shown to the merchant)."),
    requested_info: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe("Required for `needs_info`: what the merchant must add or correct (shown to them and emailed)."),
  }),
  response: OpsKybCase,
  status: 200,
  errors: ["state_conflict"],
});

// =============================================================================================
// compliance — cases
// =============================================================================================

// `CaseKind`, `CaseSeverity`, `CaseStatus`, `CaseResolution` and `ComplianceCase` live in `./cases.ts`
// (shared with the internal `createInternalCase` route).

const CaseParams = inp({ id: id("case") });

export const listOpsCases = route({
  ...cmp,
  id: "listOpsCases",
  method: "GET",
  path: "/ops/cases",
  summary: "List compliance cases (default: not closed, highest severity first, then oldest).",
  auth: ["ops:compliance.read"],
  opsRoles: ALL,
  idempotent: false,
  query: inp({
    ...listQueryShape,
    ...createdFilterShape,
    status: CaseStatus.optional().describe("Only this status (default: open and investigating)."),
    kind: CaseKind.optional().describe("Only this kind."),
    severity: CaseSeverity.optional().describe("Only this severity."),
    account: id("acct").optional().describe("Only this account."),
    assignee: id("usr").optional().describe("Only cases assigned to this operator."),
    livemode: z.enum(["true", "false"]).optional().describe("Only live or test cases."),
    // spec 0.2.1 — console CR
    subject: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        "Only cases about this object (exact `subject.id`: a prefixed id such as `ex_…`/`sd_…`, or an address). Spec 0.2.1.",
      ),
  }),
  response: listOf(ComplianceCase, "ComplianceCaseList", "A page of compliance cases."),
  status: 200,
  errors: [],
});

export const getOpsCase = route({
  ...cmp,
  id: "getOpsCase",
  method: "GET",
  path: "/ops/cases/{id}",
  summary: "Retrieve a compliance case with its timeline.",
  auth: ["ops:compliance.read"],
  opsRoles: ALL,
  idempotent: false,
  params: CaseParams,
  response: ComplianceCase,
  status: 200,
  errors: [],
});

export const assignOpsCase = route({
  ...cmp,
  id: "assignOpsCase",
  method: "POST",
  path: "/ops/cases/{id}/assign",
  summary: "Assign a case to an operator (or unassign); an `open` case becomes `investigating`.",
  description:
    "The assignee must be an active operator: compliance checks it with identity `getInternalOpsOperator` (spec 0.2.1; an unknown or revoked operator is `400 invalid_request` on `assignee`; fail closed when identity cannot answer). Closed cases are `409 state_conflict`.",
  auth: ["ops:compliance.cases.write"],
  opsRoles: ALL,
  idempotent: true,
  params: CaseParams,
  body: inp({ assignee: id("usr").nullable().describe("Operator, or null to unassign.") }),
  response: ComplianceCase,
  status: 200,
  errors: ["state_conflict"],
});

export const commentOpsCase = route({
  ...cmp,
  id: "commentOpsCase",
  method: "POST",
  path: "/ops/cases/{id}/comments",
  summary: "Add a note to a case's timeline (envelope-encrypted at rest).",
  auth: ["ops:compliance.cases.write"],
  opsRoles: ALL,
  idempotent: true,
  params: CaseParams,
  body: inp({ note: Note.describe("Note.") }),
  response: ComplianceCase,
  status: 200,
  errors: [],
});

export const closeOpsCase = route({
  ...cmp,
  id: "closeOpsCase",
  method: "POST",
  path: "/ops/cases/{id}/close",
  summary: "Close a case with a resolution; a merchant-visible review emits `review.closed`.",
  description:
    "Closing records the decision only: suspension and blocklist actions are separate routes (suspension needs two operators). Already closed is `409 state_conflict`.",
  auth: ["ops:compliance.cases.write"],
  opsRoles: ALL,
  idempotent: true,
  params: CaseParams,
  body: inp({
    resolution: CaseResolution,
    note: Note.describe("Resolution note (internal)."),
  }),
  response: ComplianceCase,
  status: 200,
  errors: ["state_conflict"],
});

// =============================================================================================
// compliance — blocklist, screening, re-screening
// =============================================================================================

export const BlocklistEntry = out({
  id: id("bl"),
  object: z.literal("blocklist_entry").describe("Always `blocklist_entry`."),
  subject_type: openEnum(["address", "near_account"], "What is blocked."),
  chain: ChainId.nullable().describe("Chain of an address; null = every chain family the address form fits."),
  subject: z.string().describe("Normalised address or NEAR account."),
  reason: z.string().describe("Why (internal)."),
  created_by: z.string().describe("Operator (`usr_…`) or CLI actor."),
  created: UnixTime.describe("Added."),
}).meta({ id: "BlocklistEntry", description: "A NearPay blocklist entry (screened like a sanctions hit)." });

export const listOpsBlocklist = route({
  ...cmp,
  id: "listOpsBlocklist",
  method: "GET",
  path: "/ops/blocklist",
  summary: "List blocklist entries.",
  auth: ["ops:compliance.read"],
  opsRoles: ALL,
  idempotent: false,
  query: inp({
    ...listQueryShape,
    subject_type: openEnum(["address", "near_account"], "Only this subject type.").optional(),
    subject: z.string().max(256).optional().describe("Only this subject (normalised before matching)."),
  }),
  response: listOf(BlocklistEntry, "BlocklistEntryList", "A page of blocklist entries."),
  status: 200,
  errors: [],
});

export const addOpsBlocklistEntry = route({
  ...cmp,
  id: "addOpsBlocklistEntry",
  method: "POST",
  path: "/ops/blocklist",
  summary: "Block an address or NEAR account.",
  description:
    "Takes effect for new screenings at once (cached `allow` screenings of the subject are invalidated) and queues a re-screen of monitored destinations matching it. An existing entry is `409 state_conflict`.",
  auth: ["ops:compliance.blocklist.write"],
  opsRoles: ALL,
  stepUp: true,
  idempotent: true,
  body: inp({
    subject_type: closedEnum(["address", "near_account"], "What to block."),
    chain: ChainId.optional().describe("Chain of an address (omit to match every family the form fits)."),
    subject: ChainAddress.describe("Address or NEAR account."),
    reason: Reason.describe("Why (internal)."),
  }),
  response: BlocklistEntry,
  status: 201,
  errors: ["address_invalid", "state_conflict"],
});

export const removeOpsBlocklistEntry = route({
  ...cmp,
  id: "removeOpsBlocklistEntry",
  method: "POST",
  path: "/ops/blocklist/{id}/remove",
  summary: "Remove a blocklist entry (ops_admin).",
  description:
    "Does not unblock destinations already disabled by a hit; sanctions-list entries cannot be removed here.",
  auth: ["ops:compliance.blocklist.write"],
  opsRoles: ADMIN,
  stepUp: true,
  idempotent: true,
  params: inp({ id: id("bl") }),
  body: inp({ reason: Reason.describe("Why (audited).") }),
  response: null,
  status: 204,
  errors: [],
});

export const createOpsScreening = route({
  ...cmp,
  id: "createOpsScreening",
  method: "POST",
  path: "/ops/screenings",
  summary: "Screen a subject now, bypassing the cache (console lookup).",
  description:
    "Runs the vendor-neutral screening interface (v1: local OFAC digital-currency list + blocklist, provider `local`); the result is stored like any screening but never served from or written to the cache.",
  auth: ["ops:compliance.screen"],
  opsRoles: ALL,
  idempotent: true,
  body: inp({
    subject_type: closedEnum(["address", "near_account"], "What is screened."),
    chain: ChainId.optional().describe("Chain of an address."),
    subject: ChainAddress.describe("Address or account."),
    livemode: z.boolean().describe("Mode (test mode uses the sandbox magic rule)."),
  }),
  response: createScreening.response,
  status: 200,
  errors: ["screening_unavailable"],
});

export const createOpsRescreen = route({
  ...cmp,
  id: "createOpsRescreen",
  method: "POST",
  path: "/ops/rescreens",
  summary: "Queue a re-screen of active destinations (one account, or all).",
  description:
    "Same job as the daily `destinations.rescreen`; hits disable the destination (`evt.compliance.destination.blocked`) and open a case.",
  auth: ["ops:compliance.screen"],
  opsRoles: ALL,
  idempotent: true,
  body: inp({ account: id("acct").optional().describe("Only this account's destinations (default: all).") }),
  response: out({
    job_id: id("job"),
    destinations: z.int().min(0).describe("Destinations queued."),
  }).meta({ id: "RescreenQueued", description: "A queued re-screening job." }),
  status: 202,
  errors: [],
});

// =============================================================================================
// compliance — merchant suspension (two-person rule)
// =============================================================================================

export const MerchantSuspension = out({
  object: z.literal("merchant_suspension").describe("Always `merchant_suspension`."),
  account_id: id("acct"),
  suspended: z.boolean().describe("Whether the account is suspended (identity sets `status: suspended`)."),
  reason: z.string().nullable().describe("Reason of the last change (internal)."),
  actor: z.string().nullable().describe("Who made the last change (`usr_…` pair `a+b`, or a CLI actor)."),
  updated_at: UnixTime.nullable().describe("Last change."),
  pending_request: OpsApproval.nullable().describe("Suspend/reinstate request waiting for a second operator."),
}).meta({ id: "MerchantSuspension", description: "Suspension state of a merchant account." });

const SuspensionParams = inp({ id: id("acct") });
const RequestParams = inp({ id: id("acct"), request: id("opa") });

export const getOpsMerchantSuspension = route({
  ...cmp,
  id: "getOpsMerchantSuspension",
  method: "GET",
  path: "/ops/merchants/{id}/suspension",
  summary: "Suspension state of a merchant, with any pending request.",
  auth: ["ops:compliance.read"],
  opsRoles: ALL,
  idempotent: false,
  params: SuspensionParams,
  response: MerchantSuspension,
  status: 200,
  errors: [],
});

export const createOpsSuspensionRequest = route({
  ...cmp,
  id: "createOpsSuspensionRequest",
  method: "POST",
  path: "/ops/merchants/{id}/suspension_requests",
  summary: "Request suspending or reinstating a merchant; a second operator must approve.",
  description:
    "Nothing changes until an `ops_admin` other than the requester approves (24 h expiry). A pending request for the account, or an action that matches the current state, is `409 state_conflict`. Emits `evt.compliance.account.action_requested` (notify alerts the security contacts).",
  auth: ["ops:compliance.accounts.write"],
  opsRoles: ALL,
  stepUp: true,
  idempotent: true,
  params: SuspensionParams,
  body: inp({
    action: closedEnum(["suspend", "reinstate"], "Requested action."),
    reason: Reason.describe("Why (internal; audited)."),
  }),
  response: OpsApproval,
  status: 201,
  errors: ["state_conflict"],
});

export const approveOpsSuspensionRequest = route({
  ...cmp,
  id: "approveOpsSuspensionRequest",
  method: "POST",
  path: "/ops/merchants/{id}/suspension_requests/{request}/approve",
  summary: "Approve a suspend/reinstate request as the second operator; executes it.",
  description:
    "Server-side two-person rule (see `OpsApproval`): an `ops_admin` whose operator id differs from the requester's, else `403 approver_conflict`. In one transaction: request `approved`, `account_flags` updated, outbox `evt.compliance.account.suspended|reinstated` (identity sets the account status; notify mails the owners). Returns the new state.",
  auth: ["ops:compliance.accounts.write"],
  opsRoles: ADMIN,
  stepUp: true,
  idempotent: true,
  params: RequestParams,
  body: inp({ note: z.string().max(500).optional().describe("Approver's note (audited).") }),
  response: MerchantSuspension,
  status: 200,
  errors: ["approver_conflict", "state_conflict"],
});

export const rejectOpsSuspensionRequest = route({
  ...cmp,
  id: "rejectOpsSuspensionRequest",
  method: "POST",
  path: "/ops/merchants/{id}/suspension_requests/{request}/reject",
  summary: "Reject (or, as the requester, withdraw) a pending suspend/reinstate request.",
  auth: ["ops:compliance.accounts.write"],
  opsRoles: ADMIN,
  idempotent: true,
  params: RequestParams,
  body: inp({ note: z.string().min(1).max(500).describe("Why (audited).") }),
  response: OpsApproval,
  status: 200,
  errors: ["state_conflict"],
});

// =============================================================================================
// sentinel — kill switch (engage alone; two-person release) and audit findings
// =============================================================================================

const snt = { service: "sentinel", visibility: "ops", stage: 2 } as const;

export const OpsKillSwitch = KillSwitchState.extend({
  version: z.int().min(0).describe("Version of the switch row (orders events)."),
  pending_release: OpsApproval.nullable().describe("Release request waiting for a second operator."),
}).meta({ id: "OpsKillSwitch", description: "Kill-switch state with any pending release request." });

export const getOpsKillSwitch = route({
  ...snt,
  id: "getOpsKillSwitch",
  method: "GET",
  path: "/ops/kill_switch",
  summary: "Kill-switch state.",
  auth: ["ops:sentinel.read"],
  opsRoles: ALL,
  idempotent: false,
  response: OpsKillSwitch,
  status: 200,
  errors: [],
});

export const engageOpsKillSwitch = route({
  ...snt,
  id: "engageOpsKillSwitch",
  method: "POST",
  path: "/ops/kill_switch/engage",
  summary: "Stop live quoting now (one operator; no step-up so an emergency is never delayed).",
  description:
    "Engaging an engaged switch is a no-op (no event). Emits `evt.sentinel.kill_switch.engaged`; a pending release request becomes `expired`.",
  auth: ["ops:sentinel.killswitch"],
  opsRoles: ALL,
  idempotent: true,
  body: inp({ reason: Reason.describe("Why (audited; sent to security contacts).") }),
  response: OpsKillSwitch,
  status: 200,
  errors: [],
});

export const requestOpsKillSwitchRelease = route({
  ...snt,
  id: "requestOpsKillSwitchRelease",
  method: "POST",
  path: "/ops/kill_switch/release_requests",
  summary: "Request releasing the kill switch; a second operator must approve.",
  description:
    "Only while engaged and with no pending request (`409 state_conflict`); expires after 1 h. Emits `evt.sentinel.kill_switch.release_requested` (notify alerts the security contacts).",
  auth: ["ops:sentinel.killswitch"],
  opsRoles: ALL,
  stepUp: true,
  idempotent: true,
  body: inp({ reason: Reason.describe("Why it is safe to resume (audited).") }),
  response: OpsApproval,
  status: 201,
  errors: ["state_conflict"],
});

const ReleaseParams = inp({ id: id("opa") });

export const approveOpsKillSwitchRelease = route({
  ...snt,
  id: "approveOpsKillSwitchRelease",
  method: "POST",
  path: "/ops/kill_switch/release_requests/{id}/approve",
  summary: "Approve a release request as the second operator; releases the switch.",
  description:
    "Server-side two-person rule (see `OpsApproval`): an `ops_admin` whose operator id differs from the requester's, else `403 approver_conflict`. In one transaction: request `approved`, `kill_switch` row released (version + 1), `kill_switch_log` row with both operator ids, outbox `evt.sentinel.kill_switch.released` (actor `<requester>+<approver>`).",
  auth: ["ops:sentinel.killswitch"],
  opsRoles: ADMIN,
  stepUp: true,
  idempotent: true,
  params: ReleaseParams,
  body: inp({ note: z.string().max(500).optional().describe("Approver's note (audited).") }),
  response: OpsKillSwitch,
  status: 200,
  errors: ["approver_conflict", "state_conflict"],
});

export const rejectOpsKillSwitchRelease = route({
  ...snt,
  id: "rejectOpsKillSwitchRelease",
  method: "POST",
  path: "/ops/kill_switch/release_requests/{id}/reject",
  summary: "Reject (or, as the requester, withdraw) a pending release request.",
  auth: ["ops:sentinel.killswitch"],
  opsRoles: ADMIN,
  idempotent: true,
  params: ReleaseParams,
  body: inp({ note: z.string().min(1).max(500).describe("Why (audited).") }),
  response: OpsApproval,
  status: 200,
  errors: ["state_conflict"],
});

export const KillSwitchLogEntry = out({
  engaged: z.boolean().describe("Engaged or released."),
  reason: z.string().describe("Reason."),
  actor: z.string().describe("`sentinel`, an operator id, `<requester>+<approver>` for releases, or a CLI actor."),
  version: z.int().min(0).describe("Switch version after the change."),
  created_at: UnixTime.describe("When."),
}).meta({ id: "KillSwitchLogEntry", description: "One change of the kill switch (append-only log)." });

export const listOpsKillSwitchLog = route({
  ...snt,
  id: "listOpsKillSwitchLog",
  method: "GET",
  path: "/ops/kill_switch/log",
  summary: "Kill-switch history, newest first.",
  auth: ["ops:sentinel.read"],
  opsRoles: ALL,
  idempotent: false,
  query: inp({
    limit: listQueryShape.limit,
    before_version: z.coerce.number().int().min(1).optional().describe("Cursor: only entries below this version."),
  }),
  response: out({
    object: z.literal("list").describe("Always `list`."),
    data: z.array(KillSwitchLogEntry).describe("Entries on this page."),
    has_more: z.boolean().describe("Whether older entries exist."),
    url: z.string().describe("Path of this list endpoint."),
  }).meta({ id: "KillSwitchLog", description: "A page of kill-switch history." }),
  status: 200,
  errors: [],
});

export const OpsAuditFinding = AuditFinding.extend({
  object: z.literal("audit_finding").describe("Always `audit_finding`."),
  created: UnixTime.describe("Recorded."),
  tx_chain: ChainId.nullable().describe("Chain of the settlement transaction checked."),
  tx_hash: z.string().nullable().describe("Settlement transaction checked."),
  acknowledged_at: UnixTime.nullable().describe("When an operator acknowledged it."),
  acknowledged_by: z.string().nullable().describe("Operator (`usr_…`) or CLI actor."),
  acknowledgement_note: z.string().nullable().describe("Acknowledgement note."),
  // spec 0.2.1 — console CR
  account_display_name: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Display name of `account_id` (sentinel keeps it from `evt.identity.account.*`); null when unknown (spec 0.2.1).",
    ),
}).meta({ id: "OpsAuditFinding", description: "A sentinel audit finding as operators see it." });

const FindingParams = inp({ id: id("fnd") });

export const listOpsFindings = route({
  ...snt,
  id: "listOpsFindings",
  method: "GET",
  path: "/ops/findings",
  summary: "Audit findings (default: not `pass` and not acknowledged).",
  auth: ["ops:sentinel.read"],
  opsRoles: ALL,
  idempotent: false,
  query: inp({
    ...listQueryShape,
    ...createdFilterShape,
    result: openEnum(["pass", "mismatch", "unverifiable"], "Only this result.").optional(),
    acknowledged: z.enum(["true", "false"]).optional().describe("Only acknowledged (or open) findings."),
    account: id("acct").optional().describe("Only this account."),
    execution: id("ex").optional().describe("Only this execution."),
    livemode: z.enum(["true", "false"]).optional().describe("Only live or test findings."),
  }),
  response: listOf(OpsAuditFinding, "OpsAuditFindingList", "A page of audit findings."),
  status: 200,
  errors: [],
});

export const getOpsFinding = route({
  ...snt,
  id: "getOpsFinding",
  method: "GET",
  path: "/ops/findings/{id}",
  summary: "Retrieve an audit finding.",
  auth: ["ops:sentinel.read"],
  opsRoles: ALL,
  idempotent: false,
  params: FindingParams,
  response: OpsAuditFinding,
  status: 200,
  errors: [],
});

export const acknowledgeOpsFinding = route({
  ...snt,
  id: "acknowledgeOpsFinding",
  method: "POST",
  path: "/ops/findings/{id}/acknowledge",
  summary: "Acknowledge a finding (the compliance case is worked separately).",
  description: "Already acknowledged is `409 state_conflict`; `pass` findings need no acknowledgement (`409`).",
  auth: ["ops:sentinel.findings.write"],
  opsRoles: ALL,
  idempotent: true,
  params: FindingParams,
  body: inp({ note: Note.describe("Note (audited).") }),
  response: OpsAuditFinding,
  status: 200,
  errors: ["state_conflict"],
});

// =============================================================================================
// rails — executions explorer and Verifier holds (shapes owned by rails: `Execution`)
// =============================================================================================

const rls = { service: "rails", visibility: "ops", stage: 2 } as const;

export const listOpsExecutions = route({
  ...rls,
  id: "listOpsExecutions",
  method: "GET",
  path: "/ops/executions",
  summary: "Executions explorer; Verifier holds are `state=held`.",
  auth: ["ops:rails.read"],
  opsRoles: ALL,
  idempotent: false,
  query: inp({
    ...listQueryShape,
    ...createdFilterShape,
    account: id("acct").optional().describe("Only this account."),
    livemode: z
      .enum(["true", "false"])
      .describe("Live or test executions; required — the explorer never mixes modes (INV-8)."),
    state: AttemptStatus.optional().describe("Only this state (e.g. `held` for Verifier holds)."),
    held_reason: openEnum(
      ["evidence_mismatch", "evidence_timeout", "failed_after_deposit", "unknown_status"],
      "Only holds with this reason.",
    ).optional(),
    kind: ExecutionKind.optional().describe("Only payments or refunds."),
    provider: Provider.optional().describe("Only this provider."),
    deposit_address: ChainAddress.optional().describe("Only the execution with this deposit address."),
  }),
  response: listOf(Execution, "OpsExecutionList", "A page of executions."),
  status: 200,
  errors: [],
});

export const getOpsExecution = route({
  ...rls,
  id: "getOpsExecution",
  method: "GET",
  path: "/ops/executions/{id}",
  summary: "Retrieve an execution with its evidence.",
  auth: ["ops:rails.read"],
  opsRoles: ALL,
  idempotent: false,
  params: inp({ id: id("ex") }),
  response: Execution,
  status: 200,
  errors: [],
});

// stage 2 — contracts integration (rails-fx follow-ups: observations, reverify; rails §6)
const ExecutionParams = inp({ id: id("ex") });

export const listOpsExecutionObservations = route({
  ...rls,
  id: "listOpsExecutionObservations",
  method: "GET",
  path: "/ops/executions/{id}/observations",
  summary: "Raw provider/tracker observations of an execution, oldest first (evidence trail).",
  auth: ["ops:rails.read"],
  opsRoles: ALL,
  idempotent: false,
  params: ExecutionParams,
  query: ObservationPageQuery,
  response: ProviderObservationPage,
  status: 200,
  errors: [],
});

export const reverifyOpsExecution = route({
  ...rls,
  id: "reverifyOpsExecution",
  method: "POST",
  path: "/ops/executions/{id}/reverify",
  summary: "Ask the Verifier to re-check a `held` or `verifying` execution now.",
  description:
    "Sets `verify_at = now()` and records an `operator` observation; the Verifier then applies its normal rules. It never forces a state: only evidence moves an execution to `succeeded` (INV-2). Other states answer `state_conflict`. Audited with the operator id.",
  auth: ["ops:rails.verify"],
  opsRoles: ALL,
  stepUp: true,
  idempotent: true,
  params: ExecutionParams,
  body: inp({ note: Note.describe("Why (audited).") }),
  response: Execution,
  status: 202,
  errors: ["state_conflict"],
});

// =============================================================================================
// payments — reconciliation runs and refund reads (payments §9, RB-05; shapes owned by payments)
// =============================================================================================

const pay = { service: "payments", visibility: "ops", stage: 2 } as const;
const Day = z.iso.date().describe("UTC day `YYYY-MM-DD`.");
const RunParams = inp({ id: id("rcn") });

export const listOpsReconciliationRuns = route({
  ...pay,
  id: "listOpsReconciliationRuns",
  method: "GET",
  path: "/ops/reconciliation_runs",
  summary: "List reconciliation runs, newest first.",
  auth: ["ops:payments.read"],
  opsRoles: ALL,
  idempotent: false,
  query: inp({
    ...listQueryShape,
    account: id("acct").optional().describe("Only runs of this account."),
    livemode: z.enum(["true", "false"]).optional().describe("Only live or test runs."),
    status: ReconciliationStatus.optional().describe("Only runs in this status."),
    day: Day.optional().describe("Only runs of this day."),
    "day[gte]": Day.optional().describe("Only runs of this day or later."),
    "day[lte]": Day.optional().describe("Only runs of this day or earlier."),
    unresolved: z.enum(["true", "false"]).optional().describe("`true`: only `diff`/`error` runs without a resolution."),
  }),
  response: listOf(ReconciliationRun, "ReconciliationRunList", "A page of reconciliation runs."),
  status: 200,
  errors: [],
});

export const getOpsReconciliationRun = route({
  ...pay,
  id: "getOpsReconciliationRun",
  method: "GET",
  path: "/ops/reconciliation_runs/{id}",
  summary: "Retrieve a reconciliation run with its totals and diffs.",
  auth: ["ops:payments.read"],
  opsRoles: ALL,
  idempotent: false,
  params: RunParams,
  response: ReconciliationRun,
  status: 200,
  errors: [],
});

export const createOpsReconciliationRun = route({
  ...pay,
  id: "createOpsReconciliationRun",
  method: "POST",
  path: "/ops/reconciliation_runs",
  summary: "Run (or re-run) the reconciliation of a completed UTC day.",
  description:
    "Asynchronous: returns the new run in `running`. A re-run never edits an earlier run (INV-9); it records `rerun_of`. One run per account, mode and day may be running at a time (`state_conflict`).",
  auth: ["ops:payments.reconcile"],
  opsRoles: ALL,
  idempotent: true,
  body: inp({ account_id: id("acct"), livemode: z.boolean().describe("Mode."), day: Day }),
  response: ReconciliationRun,
  status: 202,
  errors: ["reconciliation_day_open", "state_conflict"],
});

export const resolveOpsReconciliationRun = route({
  ...pay,
  id: "resolveOpsReconciliationRun",
  method: "POST",
  path: "/ops/reconciliation_runs/{id}/resolution",
  summary: "Record how a `diff`/`error` run was explained (RB-05).",
  description:
    "Closes the run's question, not the books: corrections are new statement lines (`fee_adjustment`, backfills), never edits (INV-9). The `reconciliation_diff` compliance case is closed separately (`closeOpsCase`).",
  auth: ["ops:payments.reconcile"],
  opsRoles: ALL,
  stepUp: true,
  idempotent: true,
  params: RunParams,
  body: inp({
    classification: ReconciliationResolution.shape.classification,
    note: Note.describe("What was found and done (audited)."),
  }),
  response: ReconciliationRun,
  status: 200,
  errors: ["state_conflict"],
});

export const getOpsRefund = route({
  ...pay,
  id: "getOpsRefund",
  method: "GET",
  path: "/ops/refunds/{id}",
  summary: "Retrieve a refund with its legs (console payment view).",
  auth: ["ops:payments.read"],
  opsRoles: ALL,
  idempotent: false,
  params: inp({ id: id("re") }),
  response: Refund,
  status: 200,
  errors: [],
});
