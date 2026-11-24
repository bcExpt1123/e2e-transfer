import { toHex, utf8 } from '@e2e-transfer/core';
import { schnorr } from '@noble/curves/secp256k1.js';
import type { NostrEvent } from '../src/nostr/event.ts';
import type { WebSocketLike } from '../src/nostr/index.ts';

type Filter = { kinds?: number[]; '#t'?: string[] };

/**
 * In-memory Nostr relay implementing the NIP-01 subset we use. Like real relays it
 * verifies ids and signatures, and echoes events back to their author's subscriptions.
 */
export class FakeRelay {
  readonly sockets = new Set<FakeSocket>();
  readonly events: NostrEvent[] = [];
  rejected = 0;

  constructor(
    readonly url: string,
    readonly mode: 'ok' | 'refuse' | 'silent' = 'ok',
  ) {}

  async receive(from: FakeSocket, msg: unknown[]) {
    if (msg[0] === 'REQ') from.subs.set(String(msg[1]), msg[2] as Filter);
    else if (msg[0] === 'CLOSE') from.subs.delete(String(msg[1]));
    else if (msg[0] === 'EVENT') {
      const ev = msg[1] as NostrEvent;
      if (!(await valid(ev))) {
        this.rejected++;
        from.deliver(['OK', ev.id, false, 'invalid: bad signature']);
        return;
      }
      this.events.push(ev);
      from.deliver(['OK', ev.id, true, '']);
      for (const s of this.sockets) {
        for (const [id, f] of s.subs) if (matches(f, ev)) s.deliver(['EVENT', id, ev]);
      }
    }
  }
}

async function valid(ev: NostrEvent) {
  const serialized = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
  const id = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(serialized)));
  if (toHex(id) !== ev.id) return false;
  return schnorr.verify(hexBytes(ev.sig), id, hexBytes(ev.pubkey));
}

const hexBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

function matches(f: Filter, ev: NostrEvent) {
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  const t = f['#t'];
  if (t && !ev.tags.some((tag) => tag[0] === 't' && t.includes(tag[1] ?? ''))) return false;
  return true;
}

export class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  readonly subs = new Map<string, Filter>();

  constructor(readonly relay: FakeRelay) {
    setTimeout(() => {
      if (relay.mode === 'refuse') {
        this.readyState = 3;
        this.onerror?.(new Event('error'));
        this.onclose?.(new Event('close') as CloseEvent);
      } else if (relay.mode === 'ok') {
        this.readyState = 1;
        relay.sockets.add(this);
        this.onopen?.(new Event('open'));
      } // silent: never opens
    }, 0);
  }

  send(data: string) {
    if (this.readyState !== 1) throw new Error('not open');
    void this.relay.receive(this, JSON.parse(data));
  }

  deliver(msg: unknown[]) {
    if (this.readyState !== 1) return;
    const data = JSON.stringify(msg);
    setTimeout(() => this.onmessage?.(new MessageEvent('message', { data })), 0);
  }

  /** Simulate the relay dropping the connection. */
  drop() {
    this.readyState = 3;
    this.relay.sockets.delete(this);
    this.onclose?.(new Event('close') as CloseEvent);
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.relay.sockets.delete(this);
    setTimeout(() => this.onclose?.(new Event('close') as CloseEvent), 0);
  }
}

export function fakeNetwork(...relays: FakeRelay[]) {
  const byUrl = new Map(relays.map((r) => [r.url, r]));
  return {
    relays: relays.map((r) => r.url),
    createSocket: (url: string) => {
      const relay = byUrl.get(url);
      if (!relay) throw new Error(`unknown relay ${url}`);
      return new FakeSocket(relay);
    },
  };
}
