/**
 * Key tree from docs/PROTOCOL.md §2.
 *
 * WebCrypto's HKDF performs Extract+Expand in one call, so
 *   HKDF-Expand(HKDF-Extract(salt, IKM), info, L) == deriveBits({salt, info}, IKM, L)
 */
import { type Bytes, concat, toHex, utf8 } from './bytes.ts';
import { ErrorCode, TransferError } from './errors.ts';

export const SECRET_BYTES = 32;
export const HELLO_NONCE_BYTES = 16;
const TREE_SALT = utf8('e2e-transfer/v1');

export interface LinkKeys {
  /** Public signaling topic (hex, 32 chars). */
  roomTopic: string;
  /** AES-256-GCM key for the signaling envelope (PROTOCOL §3). */
  signalKey: CryptoKey;
  /** HKDF base key for per-session frame keys (PROTOCOL §2). */
  sessionIkm: CryptoKey;
}

export interface SessionKeys {
  /** sender → receiver frames */
  s2r: CryptoKey;
  /** receiver → sender frames */
  r2s: CryptoKey;
}

export async function hkdf(
  ikm: Bytes | CryptoKey,
  salt: Bytes,
  info: Bytes | string,
  length: number,
): Promise<Bytes> {
  const key =
    ikm instanceof Uint8Array
      ? await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
      : ikm;
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: typeof info === 'string' ? utf8(info) : info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

const importAesGcm = (raw: Bytes) =>
  crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

/** @internal Raw link key material, exposed for test vectors only. */
export async function linkKeyMaterial(secret: Bytes) {
  if (secret.byteLength !== SECRET_BYTES) {
    throw new TransferError(ErrorCode.LinkInvalid, `secret must be ${SECRET_BYTES} bytes`);
  }
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const [room, signal, session] = await Promise.all([
    hkdf(base, TREE_SALT, 'room', 16),
    hkdf(base, TREE_SALT, 'signal', 32),
    hkdf(base, TREE_SALT, 'session', 32),
  ]);
  return { room, signal, session };
}

export async function deriveLinkKeys(secret: Bytes): Promise<LinkKeys> {
  const { room, signal, session } = await linkKeyMaterial(secret);
  const [signalKey, sessionIkm] = await Promise.all([
    importAesGcm(signal),
    crypto.subtle.importKey('raw', session, 'HKDF', false, ['deriveBits']),
  ]);
  signal.fill(0);
  session.fill(0);
  return { roomTopic: toHex(room), signalKey, sessionIkm };
}

/** @internal Raw session key material, exposed for test vectors only. */
export async function sessionKeyMaterial(sessionIkm: CryptoKey, nonceS: Bytes, nonceR: Bytes) {
  if (nonceS.byteLength !== HELLO_NONCE_BYTES || nonceR.byteLength !== HELLO_NONCE_BYTES) {
    throw new TransferError(ErrorCode.ProtocolError, 'HELLO nonce must be 16 bytes');
  }
  const salt = concat(nonceS, nonceR);
  const [s2r, r2s] = await Promise.all([
    hkdf(sessionIkm, salt, 's2r', 32),
    hkdf(sessionIkm, salt, 'r2s', 32),
  ]);
  return { s2r, r2s };
}

export async function deriveSessionKeys(
  sessionIkm: CryptoKey,
  nonceS: Bytes,
  nonceR: Bytes,
): Promise<SessionKeys> {
  const raw = await sessionKeyMaterial(sessionIkm, nonceS, nonceR);
  const [s2r, r2s] = await Promise.all([importAesGcm(raw.s2r), importAesGcm(raw.r2s)]);
  raw.s2r.fill(0);
  raw.r2s.fill(0);
  return { s2r, r2s };
}
