/** Public compliance API (lld/compliance.md §5): KYB start/status for the dashboard. */
import { route } from "../common/route.js";
import { inp, openEnum, out, z } from "../common/schema.js";

export const KybStatus = openEnum(["not_started", "pending", "needs_info", "approved", "rejected"], "KYB case status.");

export const KybCase = out({
  object: z.literal("kyb_case").describe("Always `kyb_case`."),
  status: KybStatus,
  vendor_flow_url: z
    .url()
    .nullable()
    .describe("Vendor-hosted verification flow (Stage 2); null while KYB is decided manually."),
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
