/** Public compliance API (lld/compliance.md §5): KYB start/status for the dashboard. */
import { CountryCode, UnixTime, Url } from "../common/primitives.js";
import { route } from "../common/route.js";
import { inp, openEnum, out, z } from "../common/schema.js";

export const KybStatus = openEnum(["not_started", "pending", "needs_info", "approved", "rejected"], "KYB case status.");

// stage 2 — identity-console: self-declared KYB profile (owner decision 2026-11-07, ADR-0020)

export const BusinessType = openEnum(
  ["sole_proprietorship", "partnership", "company", "non_profit", "other"],
  "Legal form of the business.",
);

export const MonthlyVolumeBand = openEnum(
  ["under_10k", "10k_to_100k", "100k_to_1m", "over_1m"],
  "Expected monthly payment volume in USD.",
);

const addressShape = {
  line1: z.string().min(1).max(200).describe("Street and number."),
  line2: z.string().max(200).nullable().describe("Additional address line."),
  city: z.string().min(1).max(100).describe("City."),
  postal_code: z.string().max(20).nullable().describe("Postal code (if the country uses one)."),
  region: z.string().max(100).nullable().describe("State, province or region."),
  country: CountryCode.describe("Country of the address."),
};

export const BusinessAddress = out(addressShape).meta({
  id: "BusinessAddress",
  description: "Registered business address.",
});

/**
 * Minimum business details, self-declared by the owner (no vendor, no documents). Every field is
 * nullable while the case is a draft; `submitKyb` requires all of them except `website` and
 * `registration_number` (optional since ADR-0024, open onboarding).
 */
export const KybProfile = out({
  legal_name: z.string().nullable().describe("Registered legal name (or the owner's full name for a sole proprietor)."),
  country_of_incorporation: CountryCode.nullable().describe("Country where the business is registered."),
  registration_number: z
    .string()
    .nullable()
    .describe("Company or trade register number, or a tax id. Optional: may stay null at submission (ADR-0024)."),
  business_type: BusinessType.nullable(),
  website: Url.nullable().describe("Public website or store front, if any."),
  business_address: BusinessAddress.nullable().describe("Registered address."),
  representative: out({
    name: z.string().describe("Full name of the person declaring the details."),
    title: z.string().describe("Their role, e.g. `Director`, `Founder`."),
  })
    .nullable()
    .describe("Who declares the details on behalf of the business."),
  expected_monthly_volume: MonthlyVolumeBand.nullable(),
}).meta({ id: "KybProfile", description: "Self-declared minimum business details (KYB)." });

/** Partial update of a draft profile; `null` clears a field. */
export const KybProfileUpdate = inp({
  legal_name: z.string().min(1).max(200).nullable().optional().describe("Registered legal name."),
  country_of_incorporation: CountryCode.nullable().optional().describe("Country of incorporation."),
  registration_number: z.string().min(1).max(64).nullable().optional().describe("Register number."),
  business_type: BusinessType.nullable().optional(),
  website: Url.nullable().optional().describe("Website (https)."),
  business_address: inp({
    line1: addressShape.line1,
    line2: addressShape.line2.optional(),
    city: addressShape.city,
    postal_code: addressShape.postal_code.optional(),
    region: addressShape.region.optional(),
    country: addressShape.country,
  })
    .nullable()
    .optional()
    .describe("Registered address (replaces the stored one)."),
  representative: inp({
    name: z.string().min(1).max(200).describe("Full name."),
    title: z.string().min(1).max(100).describe("Role in the business."),
  })
    .nullable()
    .optional()
    .describe("Declaring representative."),
  expected_monthly_volume: MonthlyVolumeBand.nullable().optional(),
}).meta({ id: "KybProfileUpdate", description: "Changes to the draft business details." });

export const KybCase = out({
  object: z.literal("kyb_case").describe("Always `kyb_case`."),
  status: KybStatus,
  vendor_flow_url: z
    .url()
    .nullable()
    .describe(
      "Always null: KYB is self-declared and decided automatically on submission (ADR-0024; ops only with manual review on); there is no vendor flow (ADR-0020).",
    ),
  // stage 2 — identity-console (absent from Stage 1 servers)
  profile: KybProfile.optional().describe("Declared business details (all null before the first update)."),
  editable: z
    .boolean()
    .optional()
    .describe("Whether the profile can be updated and submitted now (`not_started` or `needs_info`)."),
  requested_info: z
    .string()
    .nullable()
    .optional()
    .describe("What ops asked for (`needs_info` only). Internal decision reasons are never shown."),
  submitted_at: UnixTime.nullable().optional().describe("Last submission."),
  decided_at: UnixTime.nullable().optional().describe("Last decision (automatic on submission, or by ops)."),
}).meta({ id: "KybCase", description: "The account's KYB case." });

export const startKyb = route({
  id: "startKyb",
  method: "POST",
  path: "/v1/account/kyb",
  service: "compliance",
  visibility: "public",
  summary: "Start KYB (or return the current case).",
  auth: ["session"],
  roles: ["owner"],
  idempotent: true,
  body: inp({}),
  response: KybCase,
  status: 200,
  errors: [],
  stage: 1,
});

// stage 2 — identity-console: KYB profile routes

export const getKyb = route({
  id: "getKyb",
  method: "GET",
  path: "/v1/account/kyb",
  service: "compliance",
  visibility: "public",
  summary: "Retrieve the KYB case with the declared business details.",
  auth: ["session"],
  roles: ["owner", "admin"],
  idempotent: false,
  response: KybCase,
  status: 200,
  errors: [],
  stage: 2,
});

export const updateKybProfile = route({
  id: "updateKybProfile",
  method: "PATCH",
  path: "/v1/account/kyb",
  service: "compliance",
  visibility: "public",
  summary: "Update the draft business details.",
  description:
    "Allowed while the case is `not_started` or `needs_info` (`409 state_conflict` otherwise; after a decision only ops can reopen the case by asking for information). Creates the case if missing.",
  auth: ["session"],
  roles: ["owner"],
  idempotent: true,
  body: KybProfileUpdate,
  response: KybCase,
  status: 200,
  errors: ["state_conflict"],
  stage: 2,
});

export const submitKyb = route({
  id: "submitKyb",
  method: "POST",
  path: "/v1/account/kyb/submit",
  service: "compliance",
  visibility: "public",
  summary: "Submit the business details; decided at once in open onboarding (ADR-0024).",
  description:
    "The owner declares the details true and complete. Missing required fields are `400 kyb_profile_incomplete` (`website` and `registration_number` are optional); a case not in `not_started`/`needs_info` is `409 state_conflict`. Emits `evt.compliance.kyb.submitted`; with compliance's default `NP_KYB_MODE=auto` the same request records the system's decision (`approved`, or `rejected` on a geo-policy hit) and emits `evt.compliance.kyb.approved|rejected`, so the response is already decided and identity turns live mode on within seconds. With `NP_KYB_MODE=manual` the case stays `pending` for an ops decision.",
  auth: ["session"],
  roles: ["owner"],
  stepUp: true,
  idempotent: true,
  body: inp({
    declaration: z
      .literal(true)
      .describe("The owner confirms the details are true and complete (self-declaration, recorded with the user id)."),
  }),
  response: KybCase,
  status: 200,
  errors: ["kyb_profile_incomplete", "state_conflict"],
  stage: 2,
});
