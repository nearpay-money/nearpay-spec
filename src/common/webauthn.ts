/**
 * WebAuthn Level 3 JSON serialisations (PublicKeyCredential*JSON) exchanged with the dashboard.
 * Field names follow the W3C spec so browser `toJSON()` / `parse*OptionsFromJSON()` work unchanged.
 */
import { Base64Url } from "./primitives.js";
import { out, z } from "./schema.js";

const Descriptor = out({
  id: Base64Url.describe("Credential id, base64url."),
  type: z.literal("public-key").describe("Credential type."),
  transports: z.array(z.string()).optional().describe("Authenticator transports hint."),
}).describe("Credential descriptor.");

export const CreationOptionsJSON = out({
  challenge: Base64Url.describe("Server challenge, base64url."),
  rp: out({
    id: z.string().describe("Relying party id (`nearpay.money` / `nearpay.localhost`)."),
    name: z.string().describe("Relying party name."),
  }).describe("Relying party."),
  user: out({
    id: Base64Url.describe("User handle, base64url."),
    name: z.string().describe("User name (email)."),
    displayName: z.string().describe("Display name."),
  }).describe("User entity."),
  pubKeyCredParams: z
    .array(out({ type: z.literal("public-key").describe("Type."), alg: z.int().describe("COSE algorithm id.") }))
    .describe("Accepted algorithms (-8 Ed25519, -7 ES256, -257 RS256)."),
  timeout: z.int().optional().describe("Timeout in milliseconds."),
  excludeCredentials: z.array(Descriptor).optional().describe("Credentials already registered."),
  authenticatorSelection: out({
    residentKey: z.string().optional().describe("Resident key requirement."),
    userVerification: z.string().optional().describe("User verification requirement."),
    authenticatorAttachment: z.string().optional().describe("Platform or cross-platform."),
  })
    .optional()
    .describe("Authenticator selection criteria."),
  attestation: z.string().optional().describe("Attestation conveyance preference."),
}).meta({ id: "WebAuthnCreationOptions", description: "PublicKeyCredentialCreationOptionsJSON." });

export const RequestOptionsJSON = out({
  challenge: Base64Url.describe("Server challenge, base64url."),
  rpId: z.string().optional().describe("Relying party id."),
  timeout: z.int().optional().describe("Timeout in milliseconds."),
  allowCredentials: z.array(Descriptor).optional().describe("Allowed credentials (empty = discoverable)."),
  userVerification: z.string().optional().describe("User verification requirement."),
}).meta({ id: "WebAuthnRequestOptions", description: "PublicKeyCredentialRequestOptionsJSON." });

export const RegistrationResponseJSON = out({
  id: Base64Url.describe("Credential id."),
  rawId: Base64Url.describe("Raw credential id."),
  type: z.literal("public-key").describe("Credential type."),
  response: out({
    clientDataJSON: Base64Url.describe("Client data, base64url."),
    attestationObject: Base64Url.describe("Attestation object, base64url."),
    transports: z.array(z.string()).optional().describe("Transports."),
  }).describe("Attestation response."),
  authenticatorAttachment: z.string().nullable().optional().describe("Attachment."),
  clientExtensionResults: z.record(z.string(), z.unknown()).describe("Extension results."),
}).meta({
  id: "WebAuthnRegistrationResponse",
  description: "RegistrationResponseJSON from `navigator.credentials.create()`.",
});

export const AuthenticationResponseJSON = out({
  id: Base64Url.describe("Credential id."),
  rawId: Base64Url.describe("Raw credential id."),
  type: z.literal("public-key").describe("Credential type."),
  response: out({
    clientDataJSON: Base64Url.describe("Client data, base64url."),
    authenticatorData: Base64Url.describe("Authenticator data, base64url."),
    signature: Base64Url.describe("Assertion signature, base64url."),
    userHandle: Base64Url.nullable().optional().describe("User handle."),
  }).describe("Assertion response."),
  authenticatorAttachment: z.string().nullable().optional().describe("Attachment."),
  clientExtensionResults: z.record(z.string(), z.unknown()).describe("Extension results."),
}).meta({
  id: "WebAuthnAuthenticationResponse",
  description: "AuthenticationResponseJSON from `navigator.credentials.get()`.",
});
