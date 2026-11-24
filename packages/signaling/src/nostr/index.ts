/**
 * Default signaling adapter: ephemeral Nostr events on several public relays
 * (docs/ARCHITECTURE.md § Adapter interfaces). Publishes to every connected relay
 * and deduplicates on receipt, so one slow or dead relay does not break a session.
 *
 * Payloads are already encrypted and authenticated by core; we don't verify
 * Nostr signatures on receipt (relays do), since a forged event can't pass the envelope check anyway.
 */
import {
  ErrorCode,
  fromBase64Url,
  type Signaling,
  type SignalingRoom,
  TransferError,
  toBase64Url,
} from '@e2e-transfer/core';
import { type Identity, type NostrEvent, newIdentity, SIGNAL_KIND, signEvent } from './event.ts';

/** The WebSocket surface we need; the browser's WebSocket satisfies it. */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface NostrOptions {
  relays: readonly string[];
  /** Give up on a relay that hasn't connected within this time. */
  connectTimeoutMs?: number;
  /** Injectable for tests. */
  createSocket?: (url: string) => WebSocketLike;
}

export const DEFAULT_RELAYS: readonly string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.net',
];

const OPEN = 1;
const MAX_SEEN = 2048;

export function nostrSignaling(opts: NostrOptions): Signaling {
  if (opts.relays.length === 0) throw new RangeError('nostr: no relays configured');
  return {
    id: 'nostr',
    join: (topic) => joinRoom(topic, opts),
  };
}

async function joinRoom(topic: string, opts: NostrOptions): Promise<SignalingRoom> {
  const me: Identity = newIdentity();
  const subId = toBase64Url(crypto.getRandomValues(new Uint8Array(8)));
  const create = opts.createSocket ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
  const timeoutMs = opts.connectTimeoutMs ?? 6_000;
  const listeners = new Set<(payload: Uint8Array) => void>();
  const seen = new Set<string>();
  const sockets = new Set<WebSocketLike>();
  let left = false;

  const filter = { kinds: [SIGNAL_KIND], '#t': [topic], since: Math.floor(Date.now() / 1000) - 60 };

  const onEvent = (ev: unknown) => {
    if (!isEvent(ev) || ev.pubkey === me.pubkey || ev.kind !== SIGNAL_KIND) return;
    if (!ev.tags.some((t) => t[0] === 't' && t[1] === topic)) return;
    if (seen.has(ev.id)) return; // same event via another relay
    if (seen.size >= MAX_SEEN) seen.clear();
    seen.add(ev.id);
    let payload: Uint8Array;
    try {
      payload = fromBase64Url(ev.content);
    } catch {
      return;
    }
    for (const cb of [...listeners]) cb(payload);
  };

  const connectOne = (url: string) =>
    new Promise<WebSocketLike>((resolve, reject) => {
      let ws: WebSocketLike;
      try {
        ws = create(url);
      } catch (err) {
        reject(err);
        return;
      }
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`${url}: timeout`));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        if (left) {
          ws.close();
          reject(new Error('left'));
          return;
        }
        sockets.add(ws);
        ws.send(JSON.stringify(['REQ', subId, filter]));
        resolve(ws);
      };
      ws.onmessage = (e) => {
        let msg: unknown;
        try {
          msg = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (Array.isArray(msg) && msg[0] === 'EVENT' && msg[1] === subId) onEvent(msg[2]);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`${url}: error`));
      };
      ws.onclose = () => {
        clearTimeout(timer);
        sockets.delete(ws);
        reject(new Error(`${url}: closed`));
      };
    });

  // Ready as soon as one relay is up; the others join in the background.
  const attempts = opts.relays.map(connectOne);
  for (const a of attempts) a.catch(() => {});
  try {
    await Promise.any(attempts);
  } catch (cause) {
    throw new TransferError(ErrorCode.SignalingUnreachable, 'no Nostr relay reachable', { cause });
  }

  return {
    async send(payload) {
      if (left) return;
      const event = await signEvent(me, {
        kind: SIGNAL_KIND,
        tags: [['t', topic]],
        content: toBase64Url(payload as Uint8Array<ArrayBuffer>),
        created_at: Math.floor(Date.now() / 1000),
      });
      const frame = JSON.stringify(['EVENT', event]);
      let sent = 0;
      for (const ws of sockets) {
        if (ws.readyState !== OPEN) continue;
        ws.send(frame);
        sent++;
      }
      if (sent === 0)
        throw new TransferError(ErrorCode.SignalingUnreachable, 'all Nostr relays disconnected');
    },
    onMessage(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async leave() {
      if (left) return;
      left = true;
      listeners.clear();
      for (const ws of sockets) {
        if (ws.readyState === OPEN) ws.send(JSON.stringify(['CLOSE', subId]));
        ws.close();
      }
      sockets.clear();
    },
  };
}

function isEvent(v: unknown): v is NostrEvent {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.pubkey === 'string' &&
    typeof e.kind === 'number' &&
    typeof e.content === 'string' &&
    Array.isArray(e.tags) &&
    e.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))
  );
}
