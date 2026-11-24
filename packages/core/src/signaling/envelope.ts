/**
 * Signaling envelope (docs/PROTOCOL.md §3): every message on any adapter is
 * AES-GCM encrypted with `signalKey`, so relays see only opaque bytes and the
 * SDP (with its DTLS fingerprint) is bound to the shared secret.
 */
import { concat, randomBytes, toBase64Url, utf8 } from '../bytes.ts';
import type { SignalingRoom } from '../ports/signaling.ts';

const IV_BYTES = 12;
const AAD = utf8('sig/v1');
const MAX_SEEN = 4096;

export type SignalType = 'join' | 'offer' | 'answer' | 'ice' | 'bye' | 'pake';

export interface SignalMessage {
  /** Per-tab random id of the author. */
  from: string;
  /** Recipient id; absent for broadcasts (`join`). */
  to?: string;
  t: SignalType;
  d: Record<string, unknown>;
}

interface Plaintext extends SignalMessage {
  seq: number;
  ts: number;
}

const TYPES = new Set<string>(['join', 'offer', 'answer', 'ice', 'bye', 'pake']);

export interface SignalSessionOptions {
  /** Drop messages whose timestamp differs from ours by more than this. */
  maxSkewMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * One participant in a signaling room. Handles encryption, authentication,
 * self-filtering, addressing and replay protection, so adapters only move bytes.
 */
export class SignalSession {
  readonly id = toBase64Url(randomBytes(8));
  readonly #room: SignalingRoom;
  readonly #key: CryptoKey;
  readonly #opts: SignalSessionOptions;
  readonly #now: () => number;
  readonly #seen = new Set<string>();
  readonly #listeners = new Set<(msg: SignalMessage) => void>();
  readonly #off: () => void;
  #seq = 0;
  #closed = false;

  constructor(room: SignalingRoom, signalKey: CryptoKey, opts: SignalSessionOptions) {
    this.#room = room;
    this.#key = signalKey;
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
    this.#off = room.onMessage((payload) => {
      void this.#receive(payload);
    });
  }

  async send(t: SignalType, d: Record<string, unknown> = {}, to?: string): Promise<void> {
    if (this.#closed) return;
    const plain: Plaintext = { from: this.id, seq: this.#seq++, ts: this.#now(), t, d };
    if (to !== undefined) plain.to = to;
    const iv = randomBytes(IV_BYTES);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: AAD },
      this.#key,
      utf8(JSON.stringify(plain)),
    );
    await this.#room.send(concat(iv, new Uint8Array(ct)));
  }

  /** Subscribe to authenticated messages addressed to us (or broadcast). Returns unsubscribe. */
  on(cb: (msg: SignalMessage) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#off();
    this.#listeners.clear();
    await this.#room.leave();
  }

  async #receive(payload: Uint8Array): Promise<void> {
    if (this.#closed || payload.byteLength <= IV_BYTES) return;
    let plain: Plaintext;
    try {
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: payload.slice(0, IV_BYTES), additionalData: AAD },
        this.#key,
        payload.slice(IV_BYTES),
      );
      plain = JSON.parse(new TextDecoder().decode(pt)) as Plaintext;
    } catch {
      return; // not for us (another room/secret) or tampered
    }
    if (!isPlaintext(plain) || plain.from === this.id) return;
    if (plain.to !== undefined && plain.to !== this.id) return;
    if (Math.abs(this.#now() - plain.ts) > this.#opts.maxSkewMs) return;

    const key = `${plain.from}:${plain.seq}`;
    if (this.#seen.has(key)) return;
    if (this.#seen.size >= MAX_SEEN) this.#seen.clear();
    this.#seen.add(key);

    const msg: SignalMessage = { from: plain.from, t: plain.t, d: plain.d };
    if (plain.to !== undefined) msg.to = plain.to;
    for (const cb of [...this.#listeners]) cb(msg);
  }
}

function isPlaintext(v: unknown): v is Plaintext {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.from === 'string' &&
    (p.to === undefined || typeof p.to === 'string') &&
    Number.isSafeInteger(p.seq) &&
    typeof p.ts === 'number' &&
    typeof p.t === 'string' &&
    TYPES.has(p.t) &&
    typeof p.d === 'object' &&
    p.d !== null &&
    !Array.isArray(p.d)
  );
}
