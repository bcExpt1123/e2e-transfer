/**
 * Transfers set up with a short code: CPace on the nameplate topic yields the
 * shared secret, then everything runs exactly as in link mode (LinkSender/LinkReceiver).
 */
import { resolveConfig } from '../config.ts';
import { Emitter } from '../emitter.ts';
import { ErrorCode, isTransferError, TransferError, toTransferError } from '../errors.ts';
import {
  type LinkEvents,
  type LinkOptions,
  type LinkPhase,
  LinkReceiver,
  LinkSender,
} from '../session/link-session.ts';
import type { ReceiveOutcome, ReceiverOptions, ReceiverProgress } from '../session/receiver.ts';
import type { SenderOptions, SenderProgress } from '../session/sender.ts';
import { SignalSession } from '../signaling/envelope.ts';
import { codePassword, nameplateKeys, type ShortCode } from './code.ts';
import { pakeAsReceiver, pakeAsSender } from './pake.ts';

type BaseOptions = Omit<LinkOptions, 'secret' | 'manual' | 'offer'> & { code: ShortCode };

abstract class CodeSession<P> extends Emitter<LinkEvents<P> & { wrongCode: number }> {
  protected readonly opts: BaseOptions;
  protected readonly abort = new AbortController();
  #inner: { cancel(): void } | undefined;
  #lastPhase: LinkPhase | undefined;

  constructor(opts: BaseOptions) {
    super();
    this.opts = opts;
  }

  cancel(): void {
    if (this.#inner) this.#inner.cancel();
    else this.abort.abort();
  }

  protected phase(p: LinkPhase) {
    if (p !== this.#lastPhase) this.emit('phase', p);
    this.#lastPhase = p;
  }

  /** Join the nameplate, run the PAKE, then hand over to a link session with the derived secret. */
  protected async run<T, S extends { cancel(): void; start(): Promise<T> }>(
    pake: (signal: SignalSession) => Promise<Uint8Array<ArrayBuffer>>,
    link: (secret: Uint8Array<ArrayBuffer>) => S & Emitter<LinkEvents<P>>,
  ): Promise<T> {
    const { signaling, code } = this.opts;
    let signal: SignalSession | undefined;
    let handedOver = false;
    try {
      this.phase('joining');
      const { topic, envelopeKey } = await nameplateKeys(code.nameplate);
      const room = await signaling.join(topic).catch((cause: unknown) => {
        throw isTransferError(cause)
          ? cause
          : new TransferError(ErrorCode.SignalingUnreachable, `${signaling.id}: join failed`, { cause });
      });
      signal = new SignalSession(room, envelopeKey, {
        maxSkewMs: resolveConfig(this.opts.config).signalingMaxSkewMs,
      });
      this.phase('waiting');
      const secret = await pake(signal);
      void signal.close().catch(() => {});
      this.phase('connecting');

      const inner = link(secret);
      this.#inner = inner;
      // The link session's own joining/waiting are part of "connecting" here.
      inner.on('phase', (p) => this.phase(p === 'joining' || p === 'waiting' ? 'connecting' : p));
      inner.on('progress', (p) => this.emit('progress', p));
      inner.on('words', (w) => this.emit('words', w));
      if (this.abort.signal.aborted) inner.cancel();
      handedOver = true;
      return await inner.start();
    } catch (err) {
      const error = toTransferError(err);
      if (!handedOver) {
        this.phase(error.code === ErrorCode.Cancelled ? 'cancelled' : 'failed');
      }
      throw error;
    } finally {
      void signal?.close().catch(() => {});
    }
  }

  protected linkOptions(secret: Uint8Array<ArrayBuffer>): LinkOptions {
    const { code: _code, ...rest } = this.opts;
    return { ...rest, secret };
  }
}

export interface CodeSenderOptions extends BaseOptions {
  files: SenderOptions['files'];
  maxAttempts?: number;
}

export class CodeSender extends CodeSession<SenderProgress> {
  readonly #files: SenderOptions['files'];
  readonly #maxAttempts: number;

  constructor(opts: CodeSenderOptions) {
    super(opts);
    if (opts.files.length === 0) throw new RangeError('nothing to send');
    this.#files = opts.files;
    this.#maxAttempts = opts.maxAttempts ?? 3;
  }

  start(): Promise<void> {
    return this.run(
      (signal) =>
        pakeAsSender({
          signal,
          password: codePassword(this.opts.code),
          maxAttempts: this.#maxAttempts,
          abort: this.abort.signal,
          onWrongCode: (n) => this.emit('wrongCode', n),
        }),
      // Knowing the code already proves who the receiver is: no Approve step.
      (secret) => new LinkSender({ ...this.linkOptions(secret), files: this.#files }),
    );
  }
}

export interface CodeReceiverOptions extends BaseOptions {
  onManifest: ReceiverOptions['onManifest'];
}

export class CodeReceiver extends CodeSession<ReceiverProgress> {
  readonly #onManifest: ReceiverOptions['onManifest'];

  constructor(opts: CodeReceiverOptions) {
    super(opts);
    this.#onManifest = opts.onManifest;
  }

  start(): Promise<ReceiveOutcome> {
    return this.run(
      (signal) =>
        pakeAsReceiver({
          signal,
          password: codePassword(this.opts.code),
          abort: this.abort.signal,
          ...(this.opts.timeouts?.peerTimeoutMs && { timeoutMs: this.opts.timeouts.peerTimeoutMs }),
        }),
      (secret) => new LinkReceiver({ ...this.linkOptions(secret), onManifest: this.#onManifest }),
    );
  }
}
