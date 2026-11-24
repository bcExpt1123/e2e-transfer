/**
 * Send flow state (docs/UX.md: Pick → Share → Approve → Transfer → Done).
 * Wraps core's LinkSender; one link stays valid across retries until reset().
 */
import {
  type Bytes,
  blobSource,
  browserRtc,
  type ErrorCode,
  encodeLink,
  generateSecret,
  isTransferError,
  type LinkPhase,
  LinkSender,
  type RtcFactory,
} from '@e2e-transfer/core';
import { createSignaling, iceServers } from './network.ts';
import { RateMeter, type RateSnapshot } from './rate.ts';

export interface SendItem {
  file: File;
  path: string;
}

export type SendPhase = 'idle' | LinkPhase;

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
  done = $state(0);
  total = $state(0);
  rate = $state<RateSnapshot>({ bytesPerSecond: 0, secondsLeft: null });
  error = $state<ErrorCode | null>(null);
  fileCount = $state(0);

  readonly #deps: SendDeps;
  #items: SendItem[] = [];
  #secret: Bytes | undefined;
  #session: LinkSender | undefined;
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
  share(items: SendItem[]): void {
    if (items.length === 0) return;
    this.#items = items;
    this.fileCount = items.length;
    this.#secret = generateSecret();
    this.link = encodeLink(this.#deps.baseUrl(), this.#secret);
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
    this.phase = 'idle';
    this.error = null;
    this.confirming = false;
  }

  #answer(ok: boolean) {
    const resolve = this.#confirm;
    this.#confirm = undefined;
    this.confirming = false;
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

    let declinedByUs = false;
    let session: LinkSender;
    try {
      session = new LinkSender({
        secret,
        signaling: await this.#deps.createSignaling(),
        rtc: this.#deps.rtc,
        iceServers: iceServers(),
        files: this.#items.map((i) => blobSource(i.file, i.path)),
        confirmPeer: () =>
          new Promise<boolean>((resolve) => {
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
    session.on('phase', (p) => {
      if (this.#session === session) this.phase = p;
    });
    session.on('progress', ({ acked, total }) => {
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

  #fail(err: unknown) {
    this.error = isTransferError(err) ? err.code : 'PROTOCOL_ERROR';
    if (this.phase !== 'cancelled' && this.phase !== 'declined') this.phase = 'failed';
  }
}
