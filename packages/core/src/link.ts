/**
 * Secret links (docs/PROTOCOL.md §1):
 *   `https://<app>/#v1.<b64u(secret)>`                 relay mode
 *   `https://<app>/#v1.<b64u(secret)>.<offer code>`    manual mode (offer embedded, §3.1)
 */
import { type Bytes, fromBase64Url, randomBytes, toBase64Url } from './bytes.ts';
import { ErrorCode, TransferError } from './errors.ts';
import { SECRET_BYTES } from './keys.ts';

const PREFIX = '#v1.';
const B64U = /^[A-Za-z0-9_-]+$/;

export const generateSecret = (): Bytes => randomBytes(SECRET_BYTES);

export const isLinkFragment = (hash: string): boolean => hash.startsWith(PREFIX);

export interface ParsedLink {
  secret: Bytes;
  /** Encrypted SDP offer for manual connect, if the link carries one. */
  offer?: string;
}

/** Build a share link for `base` (the app URL; any existing fragment is replaced). */
export function encodeLink(base: string, secret: Bytes, offer?: string): string {
  const url = new URL(base);
  url.hash = `${PREFIX.slice(1)}${toBase64Url(secret)}${offer ? `.${offer}` : ''}`;
  return url.toString();
}

/** Parse `location.hash`. Throws LINK_INVALID for anything malformed. */
export function parseLink(hash: string): ParsedLink {
  if (!isLinkFragment(hash)) throw new TransferError(ErrorCode.LinkInvalid, 'not a v1 link');
  const [secretPart = '', offer, ...extra] = hash.slice(PREFIX.length).split('.');
  if (extra.length > 0 || (offer !== undefined && !B64U.test(offer))) {
    throw new TransferError(ErrorCode.LinkInvalid, 'malformed link');
  }
  let secret: Bytes;
  try {
    secret = fromBase64Url(secretPart);
  } catch (cause) {
    throw new TransferError(ErrorCode.LinkInvalid, 'malformed secret', { cause });
  }
  if (secret.byteLength !== SECRET_BYTES)
    throw new TransferError(ErrorCode.LinkInvalid, 'wrong secret length');
  return offer === undefined ? { secret } : { secret, offer };
}

/** @deprecated use parseLink; kept for callers that only need the secret. */
export const parseLinkFragment = (hash: string): Bytes => parseLink(hash).secret;
