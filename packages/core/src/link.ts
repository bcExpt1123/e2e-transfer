/** Secret links: `https://<app>/#v1.<b64u(secret)>` (docs/PROTOCOL.md §1). */
import { type Bytes, fromBase64Url, randomBytes, toBase64Url } from './bytes.ts';
import { ErrorCode, TransferError } from './errors.ts';
import { SECRET_BYTES } from './keys.ts';

const PREFIX = '#v1.';

export const generateSecret = (): Bytes => randomBytes(SECRET_BYTES);

export const isLinkFragment = (hash: string): boolean => hash.startsWith(PREFIX);

/** Build a share link for `base` (the app URL; any existing fragment is replaced). */
export function encodeLink(base: string, secret: Bytes): string {
  const url = new URL(base);
  url.hash = `${PREFIX.slice(1)}${toBase64Url(secret)}`;
  return url.toString();
}

/** Parse `location.hash`. Throws LINK_INVALID for anything malformed. */
export function parseLinkFragment(hash: string): Bytes {
  if (!isLinkFragment(hash)) throw new TransferError(ErrorCode.LinkInvalid, 'not a v1 link');
  let secret: Bytes;
  try {
    secret = fromBase64Url(hash.slice(PREFIX.length));
  } catch (cause) {
    throw new TransferError(ErrorCode.LinkInvalid, 'malformed secret', { cause });
  }
  if (secret.byteLength !== SECRET_BYTES)
    throw new TransferError(ErrorCode.LinkInvalid, 'wrong secret length');
  return secret;
}
