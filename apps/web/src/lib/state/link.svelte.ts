/**
 * Reads a `#v1.<secret>` link once and removes the secret from the address bar
 * (docs/SECURITY.md § Implementation rules). The secret lives only in memory.
 */
import { type Bytes, isLinkFragment, parseLink } from '@e2e-transfer/core';

export type IncomingStatus = 'none' | 'ready' | 'invalid';

class IncomingLink {
  status = $state<IncomingStatus>('none');
  #secret: Bytes | undefined;
  #offer: string | undefined;

  /** Take the secret from `location.hash` (if any) and strip it from the URL and history entry. */
  takeFromLocation(): void {
    const { hash } = location;
    if (!isLinkFragment(hash)) return;
    history.replaceState(history.state, '', location.pathname + location.search);
    try {
      const link = parseLink(hash);
      this.#secret = link.secret;
      this.#offer = link.offer;
      this.status = 'ready';
    } catch {
      this.#secret = undefined;
      this.#offer = undefined;
      this.status = 'invalid';
    }
  }

  /** @internal for ReceiveController */
  get secret(): Bytes | undefined {
    return this.#secret;
  }

  /** @internal Manual links carry the sender's encrypted offer. */
  get offer(): string | undefined {
    return this.#offer;
  }

  /** Forget the link (e.g. "Send files instead"). */
  clear(): void {
    this.#secret = undefined;
    this.#offer = undefined;
    this.status = 'none';
  }
}

export const incoming = new IncomingLink();
