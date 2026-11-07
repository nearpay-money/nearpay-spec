/**
 * Emits the generated contract artifacts from the zod sources (lld/00-foundations.md §3):
 *
 *   openapi/public.yaml               public REST (+ webhooks section)
 *   openapi/internal/<service>.yaml   internal REST per owning service
 *   asyncapi/events.yaml              domain events (AsyncAPI 3.0)
 *   schemas/{events,webhooks,x402,intents}/*.json   JSON Schemas (draft 2020-12)
 *   errors/catalogue.yaml             the error catalogue
 *
 * Usage: tsx codegen/emit.ts            write files
 *        tsx codegen/emit.ts --check    fail if committed files are stale
 *        tsx codegen/emit.ts --compat-out <dir>   write the compat documents (events/webhooks as
 *                                       GET responses, so oasdiff applies response rules) to <dir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDocument } from "zod-openapi";
import { envelopeOf, INTERNAL_ROUTES, STREAMS, SUBJECT_NAMES, SUBJECTS, streamOf } from "../src/internal-entry.js";
import {
  type AnyRoute,
  ERROR_CODES,
  ERRORS,
  type ErrorCode,
  ErrorEnvelope,
  Event,
  errorDocUrl,
  GENERIC_ERROR_CODES,
  HEADERS,
  hasMetadataFilter,
  IntentMessage,
  IntentsRequirement,
  MultiPayload,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  PUBLIC_ROUTES,
  type RouteAuth,
  SettleResponse,
  SPEC_VERSION,
  SupportedResponse,
  VerifyRequest,
  VerifyResponse,
  WEBHOOK_TYPE_NAMES,
  z,
} from "../src/public-entry.js";
import { type Output, rewriteOpenEnums, sortKeys, toJson, toYaml, writeOutputs } from "./lib.js";

type Doc = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// OpenAPI
// ---------------------------------------------------------------------------------------------

function securityFor(auth: readonly RouteAuth[]): Record<string, string[]>[] {
  const reqs = new Map<string, Record<string, string[]>>();
  for (const a of auth) {
    if (a === "anonymous") reqs.set("anonymous", {});
    else if (a === "secret_key" || a === "publishable_key" || a.startsWith("restricted_key:"))
      reqs.set("apiKey", { apiKey: [] });
    else if (a === "client_secret") reqs.set("clientSecret", { clientSecret: [] });
    else if (a === "session") reqs.set("session", { session: [] });
    else if (a.startsWith("service:") || a.startsWith("ops:") || a === "internal")
      reqs.set("internalToken", { internalToken: [] });
    else if (a === "service_client") reqs.set("serviceClient", { serviceClient: [] });
    else if (a === "gateway") reqs.set("gateway", {});
  }
  return [...reqs.values()];
}

function errorResponses(r: AnyRoute): Record<string, unknown> {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of r.errors) {
    const st = ERRORS[code].status;
    byStatus.set(st, [...(byStatus.get(st) ?? []), code]);
  }
  const res: Record<string, unknown> = {};
  for (const [status, codes] of [...byStatus.entries()].sort((a, b) => a[0] - b[0])) {
    res[String(status)] = {
      description: `Error: ${codes.map((c) => `\`${c}\``).join(", ")}.`,
      content: { "application/json": { schema: ErrorEnvelope } },
      "x-error-codes": codes,
    };
  }
  res.default = {
    description: `Generic errors that apply to every route: ${GENERIC_ERROR_CODES.map((c) => `\`${c}\``).join(", ")}.`,
    content: { "application/json": { schema: ErrorEnvelope } },
  };
  return res;
}

function headerParams(r: AnyRoute, visibility: "public" | "internal"): z.ZodObject | undefined {
  const shape: Record<string, z.ZodType> = {};
  if (r.headers instanceof z.ZodObject) Object.assign(shape, r.headers.shape);
  if (r.idempotent) {
    shape[HEADERS.idempotencyKey] = z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe("Makes the request safe to retry for 24 h (same key + same body = same result).");
  }
  if (visibility === "public" && r.service !== "agentpay" && !r.path.startsWith("/x402/")) {
    shape[HEADERS.apiVersion] = z.string().optional().describe("API version (default: the account's pinned version).");
  }
  return Object.keys(shape).length ? z.object(shape) : undefined;
}

function operationFor(r: AnyRoute, visibility: "public" | "internal"): Doc {
  const success: Record<string, unknown> = { description: r.summary };
  if (r.stream) {
    success.content = {
      "text/event-stream": {
        schema: z
          .union(Object.values(r.stream.events) as [z.ZodType, z.ZodType, ...z.ZodType[]])
          .describe("`data:` payload of each event; the `event:` name selects the schema."),
      },
    };
    success["x-sse-events"] = Object.keys(r.stream.events);
  } else if (r.response) {
    success.content = { "application/json": { schema: r.response } };
  }
  if (r.responseHeaders) success.headers = r.responseHeaders;
  const requestParams: Record<string, unknown> = {};
  if (r.params) requestParams.path = r.params;
  if (r.query) requestParams.query = r.query;
  const headers = headerParams(r, visibility);
  if (headers) requestParams.header = headers;
  const op: Doc = {
    operationId: r.id,
    summary: r.summary,
    tags: [r.service],
    security: securityFor(r.auth),
    responses: { [String(r.status)]: success, ...errorResponses(r) },
    "x-nearpay": {
      auth: r.auth,
      ...(r.roles ? { roles: r.roles } : {}),
      ...(r.stepUp ? { step_up: true } : {}),
      idempotent: r.idempotent,
      ...(r.testModeOnly ? { test_mode_only: true } : {}),
      stage: r.stage,
      service: r.service,
    },
  };
  if (r.description) op.description = r.description;
  if (Object.keys(requestParams).length) op.requestParams = requestParams;
  // stage 2 — payments: `metadata[key]=value` filters (ADR-0018) as one deepObject parameter
  if (r.query && hasMetadataFilter(r.query)) {
    op.parameters = [
      {
        in: "query",
        name: "metadata",
        style: "deepObject",
        explode: true,
        required: false,
        description:
          "Exact-match metadata filters `metadata[key]=value` (key 1–40 chars, value ≤ 500 chars, up to 10).",
        schema: { type: "object", additionalProperties: { type: "string", maxLength: 500 }, maxProperties: 10 },
      },
    ];
  }
  if (r.body) op.requestBody = { required: true, content: { "application/json": { schema: r.body } } };
  return op;
}

function pathsFor(routes: readonly AnyRoute[], visibility: "public" | "internal"): Doc {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const item = paths[r.path] ?? {};
    item[r.method.toLowerCase()] = operationFor(r, visibility);
    paths[r.path] = item;
  }
  return Object.fromEntries(
    Object.keys(paths)
      .sort()
      .map((k) => [k, paths[k]]),
  );
}

const PUBLIC_SECURITY = {
  apiKey: {
    type: "http",
    scheme: "bearer",
    description: "Secret (`sk_`), restricted (`rk_`) or publishable (`pk_`) key.",
  },
  clientSecret: {
    type: "apiKey",
    in: "header",
    name: HEADERS.clientSecret,
    description: "Checkout session client secret (payer API).",
  },
  session: {
    type: "apiKey",
    in: "cookie",
    name: "__Host-np_session",
    description: "Dashboard session (+ `X-CSRF-Token` on unsafe methods).",
  },
};
const INTERNAL_SECURITY = {
  internalToken: {
    type: "apiKey",
    in: "header",
    name: HEADERS.token,
    description: "Internal Ed25519 JWT: request token or service token.",
  },
  serviceClient: {
    type: "http",
    scheme: "basic",
    description: "Service client credentials (`client_id` + secret file).",
  },
};

function openapiDoc(
  routes: readonly AnyRoute[],
  visibility: "public" | "internal",
  title: string,
  server: string,
): Doc {
  const doc = createDocument({
    openapi: "3.1.0",
    info: {
      title,
      version: SPEC_VERSION,
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
      description:
        visibility === "public"
          ? "NearPay public API. Generated from `nearpay-spec` (zod sources); do not edit by hand."
          : "NearPay internal service API. Generated from `nearpay-spec`; do not edit by hand.",
    },
    servers: [{ url: server }],
    paths: pathsFor(routes, visibility) as never,
    components: {
      securitySchemes: (visibility === "public" ? PUBLIC_SECURITY : INTERNAL_SECURITY) as never,
      schemas: { Error: ErrorEnvelope },
    },
  });
  return sortKeys(rewriteOpenEnums(doc)) as Doc;
}

// ---------------------------------------------------------------------------------------------
// AsyncAPI and JSON Schemas
// ---------------------------------------------------------------------------------------------

function jsonSchema(schema: z.ZodType, target: "draft-2020-12" | "draft-7" = "draft-2020-12"): Doc {
  return sortKeys(rewriteOpenEnums(z.toJSONSchema(schema, { target, io: "output", unrepresentable: "any" }))) as Doc;
}

function channelKey(subject: string): string {
  return subject.replace(/\./g, "_");
}

function rewriteRefs(node: unknown, from: string, to: string): unknown {
  if (Array.isArray(node)) return node.map((n) => rewriteRefs(n, from, to));
  if (node === null || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node as Record<string, unknown>).map(([k, v]) => [
      k,
      k === "$ref" && typeof v === "string" && v.startsWith(from)
        ? to + v.slice(from.length)
        : rewriteRefs(v, from, to),
    ]),
  );
}

function asyncapiDoc(): Doc {
  const channels: Doc = {};
  const operations: Doc = {};
  const messages: Doc = {};
  const schemas: Record<string, unknown> = {};
  for (const subject of SUBJECT_NAMES) {
    const key = channelKey(subject);
    const def = SUBJECTS[subject];
    const js = jsonSchema(envelopeOf(subject), "draft-7");
    const { definitions, $schema: _schema, ...payload } = js as Doc & { definitions?: Record<string, unknown> };
    for (const [name, d] of Object.entries(definitions ?? {})) {
      const rewritten = rewriteRefs(d, "#/definitions/", "#/components/schemas/");
      if (name in schemas && JSON.stringify(schemas[name]) !== JSON.stringify(rewritten)) {
        throw new Error(`asyncapi: two different schemas named ${name}`);
      }
      schemas[name] = rewritten;
    }
    messages[key] = {
      name: subject,
      title: subject,
      contentType: "application/json",
      headers: {
        type: "object",
        properties: { "Nats-Msg-Id": { type: "string", description: "Event id (de-duplication window 120 s)." } },
        required: ["Nats-Msg-Id"],
      },
      payload: rewriteRefs(payload, "#/definitions/", "#/components/schemas/"),
    };
    channels[key] = {
      address: subject,
      messages: { [key]: { $ref: `#/components/messages/${key}` } },
      description: `Stream \`${streamOf(subject).name}\`. Producer: ${def.producer}. Consumers: ${def.consumers.join(", ")}.`,
    };
    operations[`${key}_send`] = {
      action: "send",
      channel: { $ref: `#/channels/${key}` },
      summary: `${def.producer} publishes ${subject}`,
      "x-producer": def.producer,
      "x-consumers": def.consumers,
      "x-stage": def.stage,
    };
  }
  return sortKeys({
    asyncapi: "3.0.0",
    info: {
      title: "NearPay domain events",
      version: SPEC_VERSION,
      description:
        "NATS JetStream subjects `evt.<domain>.<aggregate>.<event>`. Generated from `nearpay-spec`; do not edit by hand.",
      license: { name: "Apache-2.0" },
    },
    defaultContentType: "application/json",
    servers: { local: { host: "nats:4222", protocol: "nats", description: "Compose stack" } },
    channels,
    operations,
    components: { messages, schemas },
    "x-streams": STREAMS,
  }) as Doc;
}

// ---------------------------------------------------------------------------------------------
// Compat documents: events and webhook payloads as GET responses (consumer = response rules)
// ---------------------------------------------------------------------------------------------

function compatDoc(title: string, entries: [string, z.ZodType][]): Doc {
  const paths: Doc = {};
  for (const [name, schema] of entries) {
    paths[`/${name}`] = {
      get: {
        operationId: name.replace(/[^A-Za-z0-9]/g, "_"),
        responses: { "200": { description: name, content: { "application/json": { schema } } } },
      },
    };
  }
  const doc = createDocument({ openapi: "3.1.0", info: { title, version: SPEC_VERSION }, paths: paths as never });
  return sortKeys(rewriteOpenEnums(doc)) as Doc;
}

export function compatDocs(): Record<string, Doc> {
  const variants = (Event as unknown as { options: z.ZodType[] }).options;
  return {
    "events.yaml": compatDoc(
      "events (compat)",
      SUBJECT_NAMES.map((s) => [s, envelopeOf(s)]),
    ),
    "webhooks.yaml": compatDoc(
      "webhooks (compat)",
      WEBHOOK_TYPE_NAMES.map((t, i) => [t, variants[i] as z.ZodType]),
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------------------------

export function outputs(): Output[] {
  const outs: Output[] = [];
  outs.push({
    path: "openapi/public.yaml",
    content: toYaml(openapiDoc(PUBLIC_ROUTES, "public", "NearPay API", "https://api.nearpay.money")),
  });

  const byService = new Map<string, AnyRoute[]>();
  for (const r of INTERNAL_ROUTES) byService.set(r.service, [...(byService.get(r.service) ?? []), r]);
  for (const [svc, routes] of [...byService.entries()].sort()) {
    outs.push({
      path: `openapi/internal/${svc}.yaml`,
      content: toYaml(openapiDoc(routes, "internal", `nearpay-${svc} internal API`, `http://${svc}-api:8080`)),
    });
  }

  outs.push({ path: "asyncapi/events.yaml", content: toYaml(asyncapiDoc()) });

  for (const s of SUBJECT_NAMES)
    outs.push({ path: `schemas/events/${s}.json`, content: toJson(jsonSchema(envelopeOf(s))) });
  const variants = (Event as unknown as { options: z.ZodType[] }).options;
  WEBHOOK_TYPE_NAMES.forEach((t, i) => {
    outs.push({ path: `schemas/webhooks/${t}.json`, content: toJson(jsonSchema(variants[i] as z.ZodType)) });
  });
  const x402: [string, z.ZodType][] = [
    ["payment-required", PaymentRequired],
    ["payment-requirements", PaymentRequirements],
    ["payment-payload", PaymentPayload],
    ["verify-request", VerifyRequest],
    ["verify-response", VerifyResponse],
    ["settle-response", SettleResponse],
    ["supported-response", SupportedResponse],
  ];
  for (const [n, sc] of x402) outs.push({ path: `schemas/x402/${n}.json`, content: toJson(jsonSchema(sc)) });
  const intents: [string, z.ZodType][] = [
    ["multipayload", MultiPayload],
    ["intent-message", IntentMessage],
    ["intents-requirement", IntentsRequirement],
  ];
  for (const [n, sc] of intents) outs.push({ path: `schemas/intents/${n}.json`, content: toJson(jsonSchema(sc)) });

  outs.push({
    path: "errors/catalogue.yaml",
    content: toYaml({
      version: SPEC_VERSION,
      errors: ERROR_CODES.map((code) => ({
        code,
        status: ERRORS[code].status,
        type: ERRORS[code].type,
        retryable: ERRORS[code].retryable,
        generic: "generic" in ERRORS[code],
        message: ERRORS[code].message,
        example: ERRORS[code].example,
        doc_url: errorDocUrl(code),
        since: ERRORS[code].since,
      })),
    }),
  });

  return outs;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  const compatIdx = args.indexOf("--compat-out");
  if (compatIdx >= 0) {
    const dir = args[compatIdx + 1];
    if (!dir) throw new Error("--compat-out needs a directory");
    mkdirSync(dir, { recursive: true });
    for (const [name, doc] of Object.entries(compatDocs())) writeFileSync(join(dir, name), toYaml(doc));
  } else {
    const check = args.includes("--check");
    const stale = writeOutputs(outputs(), check);
    if (check && stale.length) {
      console.error(`generated files are stale (run pnpm emit):\n  ${stale.join("\n  ")}`);
      process.exit(1);
    }
    console.log(check ? "generated files are up to date" : "generated files written");
  }
}
