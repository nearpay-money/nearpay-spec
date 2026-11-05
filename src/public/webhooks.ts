/** Public webhooks API (lld/webhooks.md §5, Stage 1 subset). */
import { ApiVersion } from "../common/auth.js";
import { id } from "../common/ids.js";
import { createdFilterShape, listOf, listQueryShape } from "../common/pagination.js";
import { Base64Url, Livemode, UnixTime } from "../common/primitives.js";
import { route } from "../common/route.js";
import { inp, openEnum, out, z } from "../common/schema.js";
import { Event, WebhookTypeSchema } from "../webhooks/events.js";

const EnabledEvents = z
  .array(z.union([z.literal("*"), WebhookTypeSchema]))
  .min(1)
  .max(100)
  .describe('Event types to deliver, or `["*"]` for all.');

const EndpointUrl = z
  .url()
  .max(2048)
  .describe("HTTPS URL that receives events (http only for test mode and localhost).");

export const WebhookEndpoint = out({
  id: id("we"),
  object: z.literal("webhook_endpoint").describe("Always `webhook_endpoint`."),
  created: UnixTime,
  livemode: Livemode,
  url: z.url().describe("Delivery URL."),
  enabled_events: z.array(z.string()).describe("Event types delivered (`*` = all)."),
  api_version: ApiVersion.describe("Payloads are rendered in this API version."),
  description: z.string().nullable().describe("Description."),
  status: openEnum(["enabled", "disabled"], "Whether deliveries are made."),
  disabled_reason: openEnum(["merchant", "failing"], "Why the endpoint is disabled.").nullable(),
  secret: z
    .string()
    .regex(/^whsec_[0-9A-Za-z]{32,64}$/)
    .optional()
    .describe("Signing secret; returned only when the endpoint is created."),
}).meta({ id: "WebhookEndpoint", description: "A URL that receives signed events." });

const EndpointParams = inp({ id: id("we") });
const WRITE = ["secret_key", "restricted_key:webhook_endpoints.write", "session"] as const;
const READ = ["secret_key", "restricted_key:webhook_endpoints.read", "session"] as const;
const DEV_ROLES = ["owner", "admin", "developer"] as const;

export const createWebhookEndpoint = route({
  id: "createWebhookEndpoint",
  method: "POST",
  path: "/v1/webhook_endpoints",
  service: "webhooks",
  visibility: "public",
  summary: "Create a webhook endpoint; the signing secret is returned once.",
  auth: WRITE,
  roles: DEV_ROLES,
  idempotent: true,
  body: inp({
    url: EndpointUrl,
    enabled_events: EnabledEvents,
    api_version: ApiVersion.optional(),
    description: z.string().max(500).optional().describe("Description."),
  }),
  response: WebhookEndpoint,
  status: 201,
  errors: ["url_invalid", "event_type_unknown"],
  stage: 1,
});

export const listWebhookEndpoints = route({
  id: "listWebhookEndpoints",
  method: "GET",
  path: "/v1/webhook_endpoints",
  service: "webhooks",
  visibility: "public",
  summary: "List webhook endpoints.",
  auth: READ,
  roles: DEV_ROLES,
  idempotent: false,
  query: inp(listQueryShape),
  response: listOf(WebhookEndpoint, "WebhookEndpointList", "A page of webhook endpoints."),
  status: 200,
  errors: [],
  stage: 1,
});

export const getWebhookEndpoint = route({
  id: "getWebhookEndpoint",
  method: "GET",
  path: "/v1/webhook_endpoints/{id}",
  service: "webhooks",
  visibility: "public",
  summary: "Retrieve a webhook endpoint.",
  auth: READ,
  roles: DEV_ROLES,
  idempotent: false,
  params: EndpointParams,
  response: WebhookEndpoint,
  status: 200,
  errors: [],
  stage: 1,
});

export const updateWebhookEndpoint = route({
  id: "updateWebhookEndpoint",
  method: "PATCH",
  path: "/v1/webhook_endpoints/{id}",
  service: "webhooks",
  visibility: "public",
  summary: "Update a webhook endpoint (URL changes are re-validated).",
  auth: WRITE,
  roles: DEV_ROLES,
  idempotent: true,
  params: EndpointParams,
  body: inp({
    url: EndpointUrl.optional(),
    enabled_events: EnabledEvents.optional(),
    description: z.string().max(500).nullable().optional().describe("Description."),
    disabled: z.boolean().optional().describe("Disable (`true`) or re-enable (`false`) the endpoint."),
  }),
  response: WebhookEndpoint,
  status: 200,
  errors: ["url_invalid", "event_type_unknown"],
  stage: 1,
});

export const deleteWebhookEndpoint = route({
  id: "deleteWebhookEndpoint",
  method: "DELETE",
  path: "/v1/webhook_endpoints/{id}",
  service: "webhooks",
  visibility: "public",
  summary: "Delete a webhook endpoint.",
  auth: WRITE,
  roles: DEV_ROLES,
  idempotent: false,
  params: EndpointParams,
  response: null,
  status: 204,
  errors: [],
  stage: 1,
});

export const testWebhookEndpoint = route({
  id: "testWebhookEndpoint",
  method: "POST",
  path: "/v1/webhook_endpoints/{id}/test",
  service: "webhooks",
  visibility: "public",
  summary: "Send a `ping` event to the endpoint.",
  auth: WRITE,
  roles: DEV_ROLES,
  idempotent: true,
  params: EndpointParams,
  body: inp({}),
  response: Event,
  status: 202,
  errors: ["state_conflict"],
  stage: 1,
});

export const listEvents = route({
  id: "listEvents",
  method: "GET",
  path: "/v1/events",
  service: "webhooks",
  visibility: "public",
  summary: "List events of the last 30 days.",
  auth: ["secret_key", "restricted_key:events.read", "session"],
  idempotent: false,
  query: inp({
    ...listQueryShape,
    ...createdFilterShape,
    type: z.string().max(100).optional().describe("Only this type."),
  }),
  response: listOf(Event, "EventList", "A page of events."),
  status: 200,
  errors: [],
  stage: 1,
});

export const getEvent = route({
  id: "getEvent",
  method: "GET",
  path: "/v1/events/{id}",
  service: "webhooks",
  visibility: "public",
  summary: "Retrieve an event.",
  auth: ["secret_key", "restricted_key:events.read", "session"],
  idempotent: false,
  params: inp({ id: id("evt") }),
  response: Event,
  status: 200,
  errors: [],
  stage: 1,
});

export const WebhookSigningJwk = out({
  kty: z.literal("OKP").describe("Key type."),
  crv: z.literal("Ed25519").describe("Curve."),
  x: Base64Url.describe("Public key, base64url."),
  kid: z.string().describe("Key id (matches `kid=` in the signature header)."),
  alg: z.literal("EdDSA").describe("Algorithm."),
  use: z.literal("sig").describe("Use."),
}).meta({ id: "WebhookSigningJwk", description: "An Ed25519 webhook signing key." });

export const listWebhookSigningKeys = route({
  id: "listWebhookSigningKeys",
  method: "GET",
  path: "/v1/webhook_signing_keys",
  service: "webhooks",
  visibility: "public",
  summary: "Ed25519 public keys for `v1a` webhook signatures (JWKS).",
  auth: ["anonymous"],
  idempotent: false,
  response: out({ keys: z.array(WebhookSigningJwk).describe("Signing keys.") }).meta({
    id: "WebhookSigningKeys",
    description: "JWKS of webhook signing keys.",
  }),
  status: 200,
  errors: [],
  stage: 1,
});
