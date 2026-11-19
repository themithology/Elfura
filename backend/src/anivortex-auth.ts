/**
 * Elfura Backend — AniVortex installation authentication (Part 2, server-side only)
 * ===============================================================================
 * AniVortex (api.anivortex.in) gates every catalogue and playback route behind a
 * *signed installation*: an EC P-256 keypair registered once via
 * `/api/v1/install/challenge` + `/api/v1/install/register`, after which every
 * request must carry an ECDSA-signed canonical request header set.
 *
 * The protocol below was reconstructed from the public CloudStream plugin
 * (`moviesallwatchdowanload-web/Anivortex-scrapper`, `MyAniVortex.cs3` v10) and
 * its decompiled sources in `DiwasKhatri07/NepaliStream-CNC-Repo`. No code was
 * copied: only the wire format is reproduced, in Elfura's own style. See
 * `research/anivortex-audit.md`.
 *
 * Never leaks to the player: installation ids, key ids, private keys and
 * upstream base URLs stay inside the backend (RULES.md §1).
 */

import { readDotEnvOverlay } from './config.js';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as signWithKey,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';

export const ANIVORTEX_API_BASE = 'https://api.anivortex.in';
/** Identity the upstream API expects; it rejects generic browser UAs on signed routes. */
export const ANIVORTEX_CLIENT_UA = 'Dart/3.10 (dart:io)';
export const ANIVORTEX_REGISTER_PREFIX = 'ANIVORTEX-INSTALL-REGISTER-V1';
export const ANIVORTEX_SIGNED_PREFIX = 'ANIVORTEX-SIGNED-REQUEST-V1';
export const ANIVORTEX_EMPTY_BODY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
/** App identity declared in the install-challenge payload. */
const CLIENT_PROPS = {
  platform: 'android',
  package_name: 'app.anivortex.mobile',
  version_name: '5.0.1',
  version_code: 503,
} as const;

const MAX_CHALLENGE_BYTES = 4096;
const MAX_BODY_BYTES = 2048;

export interface AnivortexCredentials {
  installationId: string;
  keyId: string;
  /** Base64 (standard, padded) PKCS#8 EC private key, as exported by the mobile client. */
  privateKeyB64: string;
}

export interface AnivortexRequestInput {
  method: 'GET' | 'POST';
  /** Route path WITHOUT query string, e.g. `/api/v1/catalog/home`. */
  path: string;
  query?: Record<string, string>;
  body?: Buffer | null;
  /** Overridable for deterministic tests. */
  timestamp?: number;
  requestId?: string;
}

/* ------------------------------------------------------------------ */
/* Encoding primitives (mirror the client's canonicalization exactly)  */
/* ------------------------------------------------------------------ */

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Base64 URL-safe, no padding (Java `Base64.encodeToString(bytes, 11)`). */
export function b64UrlNoPad(data: Buffer): string {
  return data.toString('base64url');
}

/**
 * Java `URLEncoder.encode(value, "UTF-8")` with `+` normalized to `%20`:
 * unreserved set is A–Z a–z 0–9 . - _ * (space becomes %20 here).
 */
export function encodeQueryValue(value: string): string {
  let out = '';
  for (const char of Buffer.from(value, 'utf8').toString('latin1')) {
    const code = char.charCodeAt(0);
    const isUnreserved =
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x61 && code <= 0x7a) || // a-z
      (code >= 0x30 && code <= 0x39) || // 0-9
      char === '.' || char === '-' || char === '_' || char === '*';
    if (isUnreserved) {
      out += char;
    } else if (code === 0x20) {
      out += '%20';
    } else {
      out += `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/** Sorted `key=value&key=value` as used inside the signed canonical string. */
export function canonicalQuery(query: Record<string, string> = {}): string {
  return Object.keys(query)
    .sort()
    .map((key) => `${key}=${encodeQueryValue(query[key])}`)
    .join('&');
}

/* ------------------------------------------------------------------ */
/* Signed request canonicalization                                    */
/* ------------------------------------------------------------------ */

export function buildSignedHeaders(
  credentials: AnivortexCredentials,
  input: AnivortexRequestInput,
): { query: string; headers: Record<string, string> } {
  const privateKey = loadPrivateKey(credentials.privateKeyB64);
  const query = canonicalQuery(input.query);
  const requestId = input.requestId ?? randomUUID();
  const timestamp = String(input.timestamp ?? Math.floor(Date.now() / 1000));
  const bodyHash = input.body && input.body.length > 0 ? sha256Hex(input.body) : ANIVORTEX_EMPTY_BODY_SHA256;
  const canonical = [
    ANIVORTEX_SIGNED_PREFIX,
    credentials.installationId,
    credentials.keyId,
    timestamp,
    requestId,
    input.method.toUpperCase(),
    input.path,
    query,
    bodyHash,
  ].join('\n');
  const signature = b64UrlNoPad(signWithKey('sha256', Buffer.from(canonical, 'utf8'), privateKey));
  return {
    query,
    headers: {
      'user-agent': ANIVORTEX_CLIENT_UA,
      'x-anivortex-installation-id': credentials.installationId,
      'x-anivortex-key-id': credentials.keyId,
      'x-anivortex-request-id': requestId,
      'x-anivortex-timestamp': timestamp,
      'x-anivortex-signature': signature,
    },
  };
}

/**
 * Issue a signed request. Only route paths are accepted — callers cannot smuggle
 * a full URL, and the response body is always read through a bounded reader.
 */
export async function anivortexRequest(
  credentials: AnivortexCredentials,
  input: AnivortexRequestInput,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch; base?: string } = {},
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const base = options.base ?? ANIVORTEX_API_BASE;
  const { query, headers } = buildSignedHeaders(credentials, input);
  if (!input.path.startsWith('/api/v1/')) return { ok: false, status: 0, json: null };
  const url = `${base}${input.path}${query ? `?${query}` : ''}`;
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: input.method,
    headers: {
      ...headers,
      accept: 'application/json',
      ...(input.body ? { 'content-type': 'application/json' } : {}),
    },
    body: input.body ?? undefined,
    redirect: 'error',
    signal: options.signal,
  });
  const json = await readBoundedJson(response);
  return { ok: response.ok, status: response.status, json };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES * 1024) {
    await response.body.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES * 1024) return null;
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Minimal DER encoder for the self-signed installation certificate    */
/* ------------------------------------------------------------------ */

function derLength(length: number): Buffer {
  if (length < 128) return Buffer.from([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTagged(tag: number, content: Buffer, constructed = true): Buffer {
  return Buffer.concat([Buffer.from([constructed ? tag | 0x20 : tag]), derLength(content.length), content]);
}

const derSequence = (...parts: Buffer[]): Buffer => derTagged(0x10, Buffer.concat(parts));
const derSet = (content: Buffer): Buffer => derTagged(0x11, content);
const derInteger = (value: Buffer): Buffer => {
  const trimmed = value[0] & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value;
  return derTagged(0x02, trimmed, false);
};
const derOid = (oid: number[]): Buffer => derTagged(0x06, Buffer.from(oid), false);
const derUtf8 = (value: string): Buffer => derTagged(0x0c, Buffer.from(value, 'utf8'), false);
const derUtcTime = (value: string): Buffer => derTagged(0x17, Buffer.from(value, 'ascii'), false);
const derBitString = (content: Buffer): Buffer => derTagged(0x03, Buffer.concat([Buffer.from([0]), content]), false);
const derExplicitZero = (content: Buffer): Buffer => derTagged(0xa0, content, true);

const OID_ECDSA_WITH_SHA256 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]; // 1.2.840.10045.4.3.2
const OID_EC_PUBLIC_KEY = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]; // 1.2.840.10045.2.1
const OID_PRIME256V1 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]; // 1.2.840.10045.3.1.7
const OID_COMMON_NAME = [0x55, 0x04, 0x03]; // 2.5.4.3
/** Subject/issuer CN used by the reference client for software installs. */
export const ANIVORTEX_CERT_CN = 'Android Keystore Key';

function utcTime(epochMs: number): string {
  const iso = new Date(epochMs).toISOString();
  return `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

function ecPublicPoint(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string; y?: string };
  if (!jwk.x || !jwk.y) throw new Error('AniVortex key is not a P-256 public key');
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  if (x.length !== 32 || y.length !== 32) throw new Error('AniVortex key is not a P-256 public key');
  return Buffer.concat([Buffer.from([0x04]), x, y]);
}

/**
 * Build the self-signed leaf certificate used by the *software* (non-Keystore)
 * install path. The reference client emits this so an installation can register
 * without hardware attestation.
 */
export function buildSelfSignedCertificate(privateKey: KeyObject, publicKey: KeyObject, nowMs = Date.now()): Buffer {
  const serial = randomBytes(20);
  serial[0] &= 0x7f;
  if (serial.every((byte) => byte === 0)) serial[0] = 1;

  const algorithm = derSequence(derOid(OID_ECDSA_WITH_SHA256));
  const name = derSequence(derSet(derSequence(derOid(OID_COMMON_NAME), derUtf8(ANIVORTEX_CERT_CN))));
  const tbs = derSequence(
    derExplicitZero(derInteger(Buffer.from([0x02]))),
    derInteger(serial),
    algorithm,
    name,
    derSequence(derUtcTime(utcTime(nowMs - 86_400_000)), derUtcTime(utcTime(nowMs + 31_536_000_000))),
    name,
    derSequence(derSequence(derOid(OID_EC_PUBLIC_KEY), derOid(OID_PRIME256V1)), derBitString(ecPublicPoint(publicKey))),
  );
  const signature = signWithKey('sha256', tbs, privateKey);
  return derSequence(tbs, algorithm, derBitString(signature));
}

/* ------------------------------------------------------------------ */
/* One-time installation registration                                  */
/* ------------------------------------------------------------------ */

export interface AnivortexRegistrationResult {
  credentials: AnivortexCredentials;
  /** Base64 of the DER leaf certificate that was presented (for operator logs only). */
  certificateB64: string;
}

export interface AnivortexRegistrationOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  base?: string;
  /** Injected for deterministic tests. */
  keyPair?: { privateKey: KeyObject; publicKey: KeyObject };
  nowMs?: number;
}

/**
 * Register a fresh installation with the upstream API.
 *
 * This performs the two POST calls that carry no signature yet:
 *   POST /api/v1/install/challenge → { challenge_id, challenge, ... }
 *   POST /api/v1/install/register  → { installation_id, key_id, ... }
 *
 * Returns null on any failure; the caller decides whether to retry later. The
 * private key is returned to the caller only — it is never written to disk by
 * this module (RULES.md §3 zero-disk rule).
 */
export async function registerAnivortexInstallation(
  options: AnivortexRegistrationOptions = {},
): Promise<AnivortexRegistrationResult | null> {
  const base = options.base ?? ANIVORTEX_API_BASE;
  const doFetch = options.fetchImpl ?? fetch;
  const signal = options.signal ?? AbortSignal.timeout(12_000);

  let keyPair = options.keyPair;
  if (!keyPair) {
    const generated = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    keyPair = { privateKey: generated.privateKey, publicKey: generated.publicKey };
  }

  const challengeResponse = await doFetch(`${base}/api/v1/install/challenge`, {
    method: 'POST',
    headers: {
      'user-agent': ANIVORTEX_CLIENT_UA,
      'content-type': 'application/json; charset=utf-8',
      accept: 'application/json',
    },
    body: JSON.stringify(CLIENT_PROPS),
    redirect: 'error',
    signal,
  }).catch(() => null);
  if (!challengeResponse?.ok) return null;

  const challengePayload = await readBoundedJson(challengeResponse);
  const challengeId = typeof (challengePayload as any)?.challenge_id === 'string' ? (challengePayload as any).challenge_id : '';
  const challengeRaw = typeof (challengePayload as any)?.challenge === 'string' ? (challengePayload as any).challenge : '';
  if (!challengeId || !challengeRaw || challengeRaw.length > MAX_CHALLENGE_BYTES) return null;

  const challengeBytes = Buffer.from(challengeRaw, 'base64url');
  if (challengeBytes.length === 0) return null;

  const certificate = buildSelfSignedCertificate(keyPair.privateKey, keyPair.publicKey, options.nowMs);
  const certificateB64 = certificate.toString('base64');
  const proofCanonical = [
    ANIVORTEX_REGISTER_PREFIX,
    challengeId,
    b64UrlNoPad(createHash('sha256').update(challengeBytes).digest()),
  ].join('\n');
  const proofSignature = b64UrlNoPad(signWithKey('sha256', Buffer.from(proofCanonical, 'utf8'), keyPair.privateKey));
  const registerBody = JSON.stringify({
    challenge_id: challengeId,
    certificate_chain: [certificateB64, certificateB64],
    proof_signature: proofSignature,
  });

  const registerResponse = await doFetch(`${base}/api/v1/install/register`, {
    method: 'POST',
    headers: {
      'user-agent': ANIVORTEX_CLIENT_UA,
      'content-type': 'application/json; charset=utf-8',
      accept: 'application/json',
    },
    body: registerBody,
    redirect: 'error',
    signal,
  }).catch(() => null);
  if (!registerResponse?.ok) return null;

  const registerPayload = await readBoundedJson(registerResponse);
  const installationId = String((registerPayload as any)?.installation_id ?? '');
  const keyId = String((registerPayload as any)?.key_id ?? '');
  if (!installationId || !keyId || installationId.length > 128 || keyId.length > 128) return null;

  return {
    credentials: {
      installationId,
      keyId,
      privateKeyB64: keyPair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    },
    certificateB64,
  };
}

/* ------------------------------------------------------------------ */
/* Credential handling                                                 */
/* ------------------------------------------------------------------ */

export function loadPrivateKey(privateKeyB64: string): KeyObject {
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ec') throw new Error('AniVortex private key must be EC');
  return key;
}

export function publicKeyFor(privateKeyB64: string): KeyObject {
  return createPublicKey(loadPrivateKey(privateKeyB64));
}

/**
 * Effective environment: `/home/container/.env` (the Pterodactyl layout) overlaid
 * by the process environment, matching `loadBackendConfig`. Credentials live in
 * `.env` on the panel, so raw `process.env` alone would never see them.
 */
export function anivortexEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...readDotEnvOverlay(), ...env };
}

/** Parse installation credentials from the environment (never from a separate file). */
export function readAnivortexCredentials(
  env: NodeJS.ProcessEnv = process.env,
): AnivortexCredentials | null {
  const merged = anivortexEnv(env);
  const installationId = (merged.ELFURA_ANIVORTEX_INSTALL_ID || '').trim();
  const keyId = (merged.ELFURA_ANIVORTEX_KEY_ID || '').trim();
  const privateKeyB64 = (merged.ELFURA_ANIVORTEX_PRIVATE_KEY || '').trim();
  if (!installationId || !keyId || !privateKeyB64) return null;
  if (installationId.length > 128 || keyId.length > 128 || privateKeyB64.length > 4096) return null;
  try {
    loadPrivateKey(privateKeyB64);
  } catch {
    return null;
  }
  return { installationId, keyId, privateKeyB64 };
}

/** Explain credential state for diagnostics without ever echoing a value. */
export function describeAnivortexCredentials(env: NodeJS.ProcessEnv = process.env): string {
  const merged = anivortexEnv(env);
  const installationId = (merged.ELFURA_ANIVORTEX_INSTALL_ID || '').trim();
  const keyId = (merged.ELFURA_ANIVORTEX_KEY_ID || '').trim();
  const privateKeyB64 = (merged.ELFURA_ANIVORTEX_PRIVATE_KEY || '').trim();
  const present = [installationId, keyId, privateKeyB64].filter(Boolean).length;
  if (present === 0) {
    return 'no installation credentials (run scripts/anivortex-register.mjs, then set ELFURA_ANIVORTEX_INSTALL_ID / _KEY_ID / _PRIVATE_KEY in /home/container/.env)';
  }
  if (present < 3) return 'incomplete installation credentials (one of INSTALL_ID / KEY_ID / PRIVATE_KEY is empty)';
  try {
    loadPrivateKey(privateKeyB64);
  } catch {
    return 'invalid installation private key (expected base64 PKCS#8 EC P-256)';
  }
  return 'ok';
}

/** Constant-time comparison helper for installation ids used in diagnostics. */
export function sameInstallationId(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
