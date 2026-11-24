/**
 * Send flow state (docs/UX.md: Pick → Share → Approve → Transfer → Done).
 * Wraps core's LinkSender (link and manual modes) or CodeSender (short codes).
 * A link stays valid across retries until reset().
 */
import {
  type Bytes,
  blobSource,
  browserRtc,
  type Emitter,
  type ErrorCode,
  encodeLink,
  generateSecret,
  isTerminalPhase,
  isTransferError,
  type LinkEvents,
  type LinkPhase,
  LinkSender,
  type PeerInfo,
  type ReceiverInfo,
  type RtcFactory,
  type SenderProgress,
} from '@e2e-transfer/core';
import type { CodeSender } from '@e2e-transfer/core/code';
import { createSignaling, iceServers } from './network.ts';

const ACTIVE = new Set<LinkPhase>([
  'connecting',
  'reconnecting',
  'handshaking',
  'connected',
  'awaiting-accept',
  'transferring',
  'finishing',
]);

import { RateMeter, type RateSnapshot } from './rate.ts';

export interface SendItem {
  file: File;
  path: string;
}

export type SendPhase = 'idle' | LinkPhase;
export type ShareMode = 'relay' | 'manual' | 'code';
export const CODE_MAX_ATTEMPTS = 3;
export { isTerminalPhase, type ReceiverInfo };
/** "Let several devices download": how many at the same time (docs/ROADMAP.md phase 6). */
export const MAX_RECEIVERS = 5;

/** A device waiting for the user's yes/no (Approve screen). */
export interface PendingPeer {
  key: number;
  words: readonly string[];
  hint?: string;
}

export interface SendDeps {
  createSignaling: typeof createSignaling;
  rtc: RtcFactory;
  now: () => number;
  /** Base URL that links point at (the app itself). */
  baseUrl: () => string;
}

const defaultDeps: SendDeps = {
  createSignaling,
  rtc: browserRtc,
  now: () => performance.now(),
  baseUrl: () => location.href,
};

export class SendController {
  phase = $state<SendPhase>('idle');
  link = $state<string | null>(null);
  /** Devices that opened the link and wait for the user's approval, oldest first. */
  pending = $state<PendingPeer[]>([]);
  /** Relay mode: let up to MAX_RECEIVERS devices download from the same link. */
  multi = $state(false);
  /** Everyone who connected through the link (shown as a list when `multi`). */
  receivers = $state<ReceiverInfo[]>([]);
  done = $state(0);
  total = $state(0);
  rate = $state<RateSnapshot>({ bytesPerSecond: 0, secondsLeft: null });
  error = $state<ErrorCode | null>(null);
  fileCount = $state(0);
  /** `manual`: offer inside the link, reply pasted back; no relays involved. */
  mode = $state<ShareMode>('relay');
  /** Code mode: the short code to read out, e.g. "7-guitar-ocean". */
  code = $state<string | null>(null);
  /** Code mode: wrong codes entered so far for the current code. */
  wrongCodes = $state(0);

  readonly #deps: SendDeps;
  #items: SendItem[] = [];
  #secret: Bytes | undefined;
  #session: LinkSender | CodeSender | undefined;
  readonly #answers = new Map<number, (ok: boolean) => void>();
  #attempts = 0;
  readonly #meter = new RateMeter();

  constructor(deps: Partial<SendDeps> = {}) {
    this.#deps = { ...defaultDeps, ...deps };
  }

  /** Something is in progress that closing the tab would break. */
  get busy(): boolean {
    if (this.multi && this.phase === 'waiting') return this.receivers.some((r) => ACTIVE.has(r.phase));
    return !['idle', 'done', 'failed', 'cancelled', 'declined'].includes(this.phase);
  }

  /** True while the user is asked to confirm a device. */
  get confirming(): boolean {
    return this.pending.length > 0;
  }

  /** The device the Approve screen is about (the oldest pending one). */
  get peer(): PendingPeer | null {
    return this.pending[0] ?? null;
  }

  get percent(): number {
    return this.total > 0 ? Math.floor((this.done / this.total) * 100) : 0;
  }

  /** Create the secret link and start waiting for the receiver. */
  share(items: SendItem[], mode: ShareMode = 'relay'): void {
    if (items.length === 0) return;
    this.#items = items;
    this.fileCount = items.length;
    this.#secret = generateSecret();
    this.#setMode(mode);
  }

  /** Switch the current share between relay and manual mode (a new link either way). */
  switchMode(mode: ShareMode): void {
    if (!this.#secret) return;
    this.#secret = generateSecret();
    this.#setMode(mode);
  }

  /** Turn "several devices" on or off while waiting. The link stays the same. */
  setMulti(on: boolean): void {
    if (this.multi === on) return;
    this.multi = on;
    if (this.#secret && this.mode === 'relay') this.#attempt();
  }

  /** Several devices: stop the transfer to one of them. */
  cancelReceiver(key: number): void {
    const s = this.#session;
    if (s instanceof LinkSender) s.cancelReceiver(key);
  }

  /** Manual mode: the reply code pasted from the receiver. False if it doesn't fit. */
  async submitReply(code: string): Promise<boolean> {
    const s = this.#session;
    return s instanceof LinkSender ? s.acceptReply(code) : false;
  }

  #setMode(mode: ShareMode) {
    const secret = this.#secret;
    if (!secret) return;
    this.mode = mode;
    this.code = null;
    // In manual mode the link needs the offer, which takes a moment to prepare; code mode has no link.
    this.link = mode === 'relay' ? encodeLink(this.#deps.baseUrl(), secret) : null;
    this.#attempt();
  }

  /** Answer the "A device opened your link" question (default: the oldest pending device). */
  approve(key = this.peer?.key): void {
    this.#answer(key, true);
  }

  decline(key = this.peer?.key): void {
    this.#answer(key, false);
  }

  cancel(): void {
    this.#session?.cancel();
  }

  /** Try again with the same link (the receiver can reload their page). */
  retry(): void {
    if (this.#secret) this.#attempt();
  }

  /** Forget the link and files: back to picking. */
  reset(): void {
    this.#session?.cancel();
    this.#session = undefined;
    this.#secret = undefined;
    this.#items = [];
    this.link = null;
    this.mode = 'relay';
    this.multi = false;
    this.code = null;
    this.wrongCodes = 0;
    this.phase = 'idle';
    this.error = null;
    this.#clearPending();
  }

  #answer(key: number | undefined, ok: boolean) {
    if (key === undefined) return;
    const resolve = this.#answers.get(key);
    this.#answers.delete(key);
    this.pending = this.pending.filter((p) => p.key !== key);
    resolve?.(ok);
  }

  #ask(peer: PeerInfo): Promise<boolean> {
    const key = peer.key ?? 0;
    return new Promise<boolean>((resolve) => {
      this.#answers.set(key, resolve);
      this.pending = [...this.pending, { key, words: peer.words, ...(peer.hint && { hint: peer.hint }) }];
    });
  }

  #clearPending() {
    // Superseded sessions are cancelled; their questions just go away.
    this.#answers.clear();
    this.pending = [];
  }

  async #attempt() {
    const secret = this.#secret;
    if (!secret) return;
    const attempt = ++this.#attempts;
    this.#session?.cancel();
    this.#session = undefined;
    this.#clearPending();
    this.error = null;
    this.done = 0;
    this.total = this.#items.reduce((n, i) => n + i.file.size, 0);
    this.receivers = [];
    this.#meter.reset();
    this.rate = { bytesPerSecond: 0, secondsLeft: null };
    this.phase = 'joining';
    if (this.mode === 'manual') this.link = null;

    let session: LinkSender | CodeSender;
    try {
      session =
        this.mode === 'code'
          ? await this.#codeSender()
          : new LinkSender({
              secret,
              signaling: await this.#deps.createSignaling(),
              rtc: this.#deps.rtc,
              iceServers: iceServers(),
              files: this.#items.map((i) => blobSource(i.file, i.path)),
              manual: this.mode === 'manual',
              maxReceivers: this.multi && this.mode === 'relay' ? MAX_RECEIVERS : 1,
              // A declined device is turned away inside LinkSender; the link stays open.
              confirmPeer: (peer) => this.#ask(peer),
            });
    } catch (err) {
      if (attempt === this.#attempts) this.#fail(err);
      return;
    }
    if (attempt !== this.#attempts || secret !== this.#secret) {
      session.cancel(); // superseded (reset, retry or mode switch) while loading
      return;
    }
    this.#session = session;
    // Both session kinds emit the link events; CodeSender adds `wrongCode`.
    const events: Pick<Emitter<LinkEvents<SenderProgress>>, 'on'> = session;
    const current = () => this.#session === session;
    events.on('phase', (p) => {
      if (!current()) return;
      if (p === 'reconnecting') this.#meter.reset();
      this.phase = p;
    });
    if (session instanceof LinkSender) {
      session.on('code', (offer) => {
        if (current()) this.link = encodeLink(this.#deps.baseUrl(), secret, offer);
      });
      session.on('receivers', (list) => {
        if (!current()) return;
        this.receivers = [...list];
        // A device that left (cancelled, lost) can't be approved any more.
        const asking = new Set(list.filter((r) => r.phase === 'connected').map((r) => r.key));
        for (const p of this.pending) if (!asking.has(p.key)) this.#answer(p.key, false);
      });
    } else {
      session.on('wrongCode', (n) => {
        if (current()) this.wrongCodes = n;
      });
    }
    events.on('progress', ({ acked, total }) => {
      if (!current()) return;
      this.done = acked;
      this.total = total;
      this.rate = this.#meter.sample(acked, total, this.#deps.now());
    });

    try {
      await session.start();
    } catch (err) {
      if (current()) this.#fail(err);
    } finally {
      if (current()) this.#clearPending();
    }
  }

  /** Short-code mode: a fresh code per attempt (a closed code must never be reused). */
  async #codeSender(): Promise<CodeSender> {
    const [{ CodeSender, generateCode, formatCode }, signaling] = await Promise.all([
      import('@e2e-transfer/core/code'),
      this.#deps.createSignaling(),
    ]);
    const code = generateCode();
    this.code = formatCode(code);
    this.wrongCodes = 0;
    return new CodeSender({
      code,
      signaling,
      rtc: this.#deps.rtc,
      iceServers: iceServers(),
      files: this.#items.map((i) => blobSource(i.file, i.path)),
      maxAttempts: CODE_MAX_ATTEMPTS,
    });
  }

  #fail(err: unknown) {
    this.error = isTransferError(err) ? err.code : 'PROTOCOL_ERROR';
    if (this.phase !== 'cancelled' && this.phase !== 'declined') this.phase = 'failed';
  }
}
