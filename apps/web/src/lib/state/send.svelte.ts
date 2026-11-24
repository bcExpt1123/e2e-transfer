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
  isTransferError,
  type LinkEvents,
  type LinkPhase,
  LinkSender,
  type RtcFactory,
  type SenderProgress,
} from '@e2e-transfer/core';
import type { CodeSender } from '@e2e-transfer/core/code';
import { createSignaling, iceServers } from './network.ts';
import { RateMeter, type RateSnapshot } from './rate.ts';

export interface SendItem {
  file: File;
  path: string;
}

export type SendPhase = 'idle' | LinkPhase;
export type ShareMode = 'relay' | 'manual' | 'code';
export const CODE_MAX_ATTEMPTS = 3;

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
  /** True while the user is asked to confirm the device that opened the link. */
  confirming = $state(false);
  /** Who is asking: verification words and the device hint (while confirming). */
  peer = $state<{ words: readonly string[]; hint?: string } | null>(null);
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
  #confirm: ((ok: boolean) => void) | undefined;
  readonly #meter = new RateMeter();

  constructor(deps: Partial<SendDeps> = {}) {
    this.#deps = { ...defaultDeps, ...deps };
  }

  /** Something is in progress that closing the tab would break. */
  get busy(): boolean {
    return !['idle', 'done', 'failed', 'cancelled', 'declined'].includes(this.phase);
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

  /** Answer the "A device opened your link" question. */
  approve(): void {
    this.#answer(true);
  }

  decline(): void {
    this.#answer(false);
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
    this.code = null;
    this.wrongCodes = 0;
    this.phase = 'idle';
    this.error = null;
    this.confirming = false;
  }

  #answer(ok: boolean) {
    const resolve = this.#confirm;
    this.#confirm = undefined;
    this.confirming = false;
    this.peer = null;
    resolve?.(ok);
  }

  async #attempt() {
    const secret = this.#secret;
    if (!secret) return;
    this.#session?.cancel();
    this.error = null;
    this.done = 0;
    this.total = this.#items.reduce((n, i) => n + i.file.size, 0);
    this.#meter.reset();
    this.rate = { bytesPerSecond: 0, secondsLeft: null };
    this.phase = 'joining';
    if (this.mode === 'manual') this.link = null;

    let declinedByUs = false;
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
              confirmPeer: (peer) =>
                new Promise<boolean>((resolve) => {
                  this.peer = peer;
                  this.confirming = true;
                  this.#confirm = (ok) => {
                    declinedByUs = !ok;
                    resolve(ok);
                  };
                }),
            });
    } catch (err) {
      this.#fail(err);
      return;
    }
    if (secret !== this.#secret) return; // reset while loading the signaling adapter
    this.#session = session;
    // Both session kinds emit the link events; CodeSender adds `wrongCode`.
    const events: Pick<Emitter<LinkEvents<SenderProgress>>, 'on'> = session;
    events.on('phase', (p) => {
      if (this.#session === session) this.phase = p;
    });
    if (session instanceof LinkSender) {
      session.on('code', (offer) => {
        if (this.#session === session) this.link = encodeLink(this.#deps.baseUrl(), secret, offer);
      });
    } else {
      session.on('wrongCode', (n) => {
        if (this.#session === session) this.wrongCodes = n;
      });
    }
    events.on('progress', ({ acked, total }) => {
      if (this.#session !== session) return;
      this.done = acked;
      this.total = total;
      this.rate = this.#meter.sample(acked, total, this.#deps.now());
    });

    try {
      await session.start();
    } catch (err) {
      if (this.#session !== session) return; // superseded by retry/reset
      // We turned an unexpected device away: keep the link open for the right one.
      if (declinedByUs) {
        this.#attempt();
        return;
      }
      this.#fail(err);
    } finally {
      if (this.#session === session) this.confirming = false;
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
