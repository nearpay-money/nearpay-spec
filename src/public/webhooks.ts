/** Public webhooks API (lld/webhooks.md §5, Stage 1 subset). */
import { ApiVersion } from "../common/auth.js";
import { id } from "../common/ids.js";
import { createdFilterShape, listOf, listQueryShape } from "../common/pagination.js";
import { Base64Url, Livemode, UnixTime } from "../common/primitives.js";
import { route } from "../common/route.js";
import { inp, openEnum, out, z } from "../common/schema.js";
import { Event, WebhookTypeSchema } from "../webhooks/events.js";

/**
 * Request items accept any type string (spec 0.1.5) so the service, not request validation, rejects
 * an unknown type with `event_type_unknown`. The `*` and typed alternatives stay first in the union
 * (they document the known types; removing them would be a breaking change for the compat gate).
 * Responses list the stored types (`WebhookEndpoint`).
 */
const EnabledEvents = z
  .array(
    z
      .union([
        z.literal("*"),
        WebhookTypeSchema,
        z.string().min(1).max(100).describe("Any other type string; the service answers `event_type_unknown`."),
      ])
      .describe("A webhook event type, or `*` for all types."),
  )
  .min(1)
  .max(100)
  .describe(
    'Event types to deliver, or `["*"]` for all. A type that is not a webhook type is rejected with `event_type_unknown`.',
  );

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
    .describe("Signing secret; returned only when the endpoint is created or its secret is rotated."),
  // stage 2 — identity-console: secret rotation (webhooks §5)
  previous_secret_expires_at: UnixTime.nullable()
    .optional()
    .describe(
      "While a rotated-out secret is still used: until when deliveries carry a second `v1=` signature made with it. Absent from Stage 1 servers.",
    ),
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

export const WebhookDelivery = out({
  id: id("whd"),
  object: z.literal("webhook_delivery").describe("Always `webhook_delivery`."),
  created: UnixTime,
  livemode: Livemode,
  webhook_endpoint: id("we"),
  event: id("evt"),
  event_type: WebhookTypeSchema,
  status: openEnum(
    ["pending", "succeeded", "failed", "abandoned"],
    "`pending`: not attempted yet. `failed`: the last attempt failed and a retry is scheduled. `succeeded`: an attempt got a 2xx. `abandoned`: no more attempts (72 h passed or the endpoint was deleted).",
  ),
  attempts: z.int().min(0).describe("Attempts made so far, including a successful one."),
  last_status_code: z
    .int()
    .min(100)
    .max(599)
    .nullable()
    .describe("HTTP status of the last attempt; null before the first attempt or when it got no response."),
  last_error: z
    .string()
    .nullable()
    .describe("Why the last attempt failed (timeout, connection refused, non-2xx, egress policy); null if none."),
  next_attempt_at: UnixTime.nullable().describe(
    "When the next attempt is due; null once the delivery is `succeeded` or `abandoned`.",
  ),
  succeeded_at: UnixTime.nullable().describe("When an attempt succeeded."),
}).meta({
  id: "WebhookDelivery",
  description: "One event's delivery to one endpoint, with a summary of its attempts.",
});

export const listWebhookEndpointDeliveries = route({
  id: "listWebhookEndpointDeliveries",
  method: "GET",
  path: "/v1/webhook_endpoints/{id}/deliveries",
  service: "webhooks",
  visibility: "public",
  summary: "List an endpoint's deliveries of the last 30 days, newest first.",
  auth: READ,
  roles: DEV_ROLES,
  idempotent: false,
  params: EndpointParams,
  query: inp(listQueryShape),
  response: listOf(WebhookDelivery, "WebhookDeliveryList", "A page of webhook deliveries."),
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

// =============================================================================================
// stage 2 — identity-console: secret rotation and resend (lld/webhooks.md §5, §12)
// =============================================================================================

export const rotateWebhookEndpointSecret = route({
  id: "rotateWebhookEndpointSecret",
  method: "POST",
  path: "/v1/webhook_endpoints/{id}/rotate_secret",
  service: "webhooks",
  visibility: "public",
  summary: "Replace the signing secret; the old one keeps signing during an overlap window.",
  description:
    "Returns the endpoint with the new `secret` (shown once) and `previous_secret_expires_at`. During the overlap every delivery carries two `v1=` signatures (new and previous secret); `expire_previous_in_seconds: 0` drops the previous secret at once. Rotating again during an overlap replaces the previous secret with the current one. The idempotent response (it carries the secret) is stored encrypted.",
  auth: WRITE,
  roles: DEV_ROLES,
  idempotent: true,
  params: EndpointParams,
  body: inp({
    expire_previous_in_seconds: z
      .int()
      .min(0)
      .max(86_400)
      .default(86_400)
      .describe("Overlap during which the previous secret still signs (0–86 400 s, default 24 h)."),
  }),
  response: WebhookEndpoint,
  status: 200,
  errors: [],
  stage: 2,
});

export const EventResend = out({
  object: z.literal("event_resend").describe("Always `event_resend`."),
  event: id("evt"),
  deliveries: z.array(WebhookDelivery).describe("New deliveries, one per endpoint (status `pending`)."),
}).meta({ id: "EventResend", description: "Deliveries queued by a resend." });

export const resendEvent = route({
  id: "resendEvent",
  method: "POST",
  path: "/v1/events/{id}/resend",
  service: "webhooks",
  visibility: "public",
  summary: "Deliver an event again, to one endpoint or to every enabled endpoint subscribed to its type.",
  description:
    "Creates a new delivery per endpoint (fresh retry schedule; the event keeps its id, so receivers dedupe on `NearPay-Event-Id`). With `endpoint`, the endpoint must be the caller's, in the event's mode and enabled (`409 state_conflict` if disabled); subscriptions are ignored (like `test`). Events older than 30 days are `404`.",
  auth: WRITE,
  roles: DEV_ROLES,
  idempotent: true,
  params: inp({ id: id("evt") }),
  body: inp({ endpoint: id("we").optional() }),
  response: EventResend,
  status: 202,
  errors: ["state_conflict"],
  stage: 2,
});
