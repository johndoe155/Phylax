/**
 * The browser half of a WebAuthn ceremony (passkeys), written by hand so the app stays dependency-free.
 *
 * WHY BY HAND. The server verifies assertions with `@simplewebauthn/server` v13, which speaks the "JSON" shape: every
 * binary field travels as a base64url string, both in the options it issues and in the response it verifies. The
 * browser's own API (`navigator.credentials.create` / `.get`) speaks `ArrayBuffer`. This module is the whole conversion
 * — decode the strings the server sent into the buffers the browser wants, then encode the buffer the browser produced
 * back into the strings the server expects — and it matches `@simplewebauthn/browser` v13 byte for byte, so either side
 * can be swapped for the library later without a contract change.
 *
 * EXACTLY WHAT THE SERVER ACCEPTS (phylax-backend/server/auth/webauthn.ts):
 *   registration  { id, rawId, type, response: { clientDataJSON, attestationObject, transports? },
 *                   clientExtensionResults, authenticatorAttachment? }
 *   assertion     { id, rawId, type, response: { clientDataJSON, authenticatorData, signature, userHandle? },
 *                   clientExtensionResults, authenticatorAttachment? }
 * and it reads `response.clientDataJSON` to find the challenge it issued, so the client data must be untouched.
 *
 * The prompt the person sees (Face ID, a fingerprint, a screen lock, a security key) is drawn by the browser and the
 * operating system; this module cannot and must not try to draw it. A cancelled prompt rejects with `NotAllowedError`,
 * which `describeCeremonyError` turns into something a person can read.
 */

export class CeremonyError extends Error {
  /** The DOMException name, kept so a caller can tell "cancelled" from "no authenticator". */
  readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = "CeremonyError";
    this.reason = reason;
  }
}

/** Whether this browser can do WebAuthn at all (the account page asks before offering to add a passkey). */
export function browserSupportsWebAuthn(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential !== "undefined" && !!navigator.credentials;
}

// ---- base64url <-> binary ---------------------------------------------------------------------------------------------

export function base64urlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---- the server's options -> the browser's options --------------------------------------------------------------------

type WireCredentialDescriptor = { id: string; type?: string; transports?: string[] };

/** The options `POST /auth/passkey/register/options` returns (and `/passkey/add/options`). */
type WireCreationOptions = {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams?: { type: string; alg: number }[];
  timeout?: number;
  attestation?: AttestationConveyancePreference;
  excludeCredentials?: WireCredentialDescriptor[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  extensions?: Record<string, unknown>;
};

/** A descriptor the browser can match: the id must be bytes, everything else is passed through. */
function descriptor(wire: WireCredentialDescriptor): PublicKeyCredentialDescriptor {
  return {
    id: base64urlToBytes(wire.id),
    type: (wire.type as PublicKeyCredentialType) ?? "public-key",
    ...(wire.transports ? { transports: wire.transports as AuthenticatorTransport[] } : {}),
  };
}

export function toCreationOptions(wire: WireCreationOptions): PublicKeyCredentialCreationOptions {
  return {
    challenge: base64urlToBytes(wire.challenge),
    rp: { id: wire.rp.id, name: wire.rp.name },
    user: {
      id: base64urlToBytes(wire.user.id),
      name: wire.user.name,
      displayName: wire.user.displayName,
    },
    pubKeyCredParams: (wire.pubKeyCredParams ?? [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }]) as PublicKeyCredentialParameters[],
    timeout: wire.timeout,
    attestation: wire.attestation,
    excludeCredentials: wire.excludeCredentials?.map(descriptor),
    authenticatorSelection: wire.authenticatorSelection,
    extensions: wire.extensions as AuthenticationExtensionsClientInputs | undefined,
  };
}

/** The options `POST /auth/passkey/options` returns (sign-in) and `/reauthenticate/passkey/options` (step-up). */
type WireRequestOptions = {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: WireCredentialDescriptor[];
  userVerification?: UserVerificationRequirement;
  extensions?: Record<string, unknown>;
};

export function toRequestOptions(wire: WireRequestOptions): PublicKeyCredentialRequestOptions {
  return {
    challenge: base64urlToBytes(wire.challenge),
    timeout: wire.timeout,
    rpId: wire.rpId,
    allowCredentials: wire.allowCredentials?.map(descriptor),
    userVerification: wire.userVerification,
    extensions: wire.extensions as AuthenticationExtensionsClientInputs | undefined,
  };
}

// ---- the browser's answer -> the server's JSON ------------------------------------------------------------------------

/** The transport list the authenticator reported, which the server stores so a later prompt can hint at it. */
function transportsOf(response: AuthenticatorResponse): string[] | undefined {
  const list = (response as AuthenticatorAttestationResponse).getTransports?.();
  return list && list.length ? [...list] : undefined;
}

export function toRegistrationJSON(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: bytesToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bytesToBase64url(response.clientDataJSON),
      attestationObject: bytesToBase64url(response.attestationObject),
      transports: transportsOf(response),
    },
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  };
}

export function toAssertionJSON(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bytesToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bytesToBase64url(response.clientDataJSON),
      authenticatorData: bytesToBase64url(response.authenticatorData),
      signature: bytesToBase64url(response.signature),
      userHandle: response.userHandle ? bytesToBase64url(response.userHandle) : undefined,
    },
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  };
}

// ---- the two ceremonies ------------------------------------------------------------------------------------------------

/** A cancelled prompt is the person's choice, not an error worth alarming them about; anything else is worth a sentence. */
export function describeCeremonyError(error: unknown): CeremonyError {
  if (error instanceof CeremonyError) return error;
  const name = error instanceof DOMException ? error.name : error instanceof Error ? error.name : "UnknownError";
  switch (name) {
    case "NotAllowedError":
      return new CeremonyError("The passkey prompt was cancelled or timed out. Try again when you're ready.", name);
    case "InvalidStateError":
      return new CeremonyError("This device already has a passkey for Phylax. Sign in with it instead.", name);
    case "NotSupportedError":
      return new CeremonyError("This browser can't create passkeys. Try another browser or device.", name);
    case "SecurityError":
      return new CeremonyError("Passkeys need the site to be served over https from the same address the API uses.", name);
    case "AbortError":
      return new CeremonyError("The passkey prompt was closed.", name);
    default:
      return new CeremonyError("That passkey step didn't finish. Try again.", name);
  }
}

/**
 * Run the registration ceremony and return the credential JSON the server verifies.
 * `signal` is honoured by the browsers that support it (Chrome, Edge, Safari 17.4+); elsewhere the prompt itself is the
 * only way out, which is why the page shows its own "cancel" affordance around it.
 */
export async function createPasskey(
  wire: WireCreationOptions,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!browserSupportsWebAuthn()) throw new CeremonyError("This browser can't create passkeys. Try another browser or device.", "NotSupportedError");
  try {
    const credential = (await navigator.credentials.create({
      publicKey: toCreationOptions(wire),
      ...(signal ? { signal } : {}),
    })) as PublicKeyCredential | null;
    if (!credential) throw new CeremonyError("No passkey was created.", "NotAllowedError");
    return toRegistrationJSON(credential);
  } catch (error) {
    throw describeCeremonyError(error);
  }
}

/** Run the sign-in / step-up ceremony and return the assertion JSON the server verifies. */
export async function getPasskey(
  wire: WireRequestOptions,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!browserSupportsWebAuthn()) throw new CeremonyError("This browser can't use passkeys. Try another browser or device.", "NotSupportedError");
  try {
    const credential = (await navigator.credentials.get({
      publicKey: toRequestOptions(wire),
      ...(signal ? { signal } : {}),
    })) as PublicKeyCredential | null;
    if (!credential) throw new CeremonyError("No passkey was offered.", "NotAllowedError");
    return toAssertionJSON(credential);
  } catch (error) {
    throw describeCeremonyError(error);
  }
}

/**
 * Whether a conditional (autofill) passkey prompt is worth attempting.
 *
 * The server issues options with `userVerification: "required"` and, for a sign-in, no `allowCredentials` — that is a
 * discoverable-credential request, so the browser can find the passkey itself. This reports whether the *browser* supports
 * the silent/conditional form; the sign-in page uses the ordinary prompt either way, so it is currently only used to
 * decide whether to keep the button enabled.
 */
export async function supportsConditionalMediation(): Promise<boolean> {
  if (!browserSupportsWebAuthn()) return false;
  try {
    return (await (window as unknown as { PublicKeyCredential?: { isConditionalMediationAvailable?: () => Promise<boolean> } }).PublicKeyCredential?.isConditionalMediationAvailable?.()) === true;
  } catch {
    return false;
  }
}
