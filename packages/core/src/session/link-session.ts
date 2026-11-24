/**
 * One complete connection attempt over a secret link: join the signaling room,
 * set up WebRTC, then run the Sender or Receiver engine on the DataChannel
 * (docs/ARCHITECTURE.md § Session lifecycle). A retry is a new instance.
 */
import type { Bytes } from '../bytes.ts';
import { resolveConfig, type TransferConfig } from '../config.ts';
import { Emitter } from '../emitter.ts';
import { ErrorCode, isTransferError, TransferError, toTransferError } from '../errors.ts';
import { deriveLinkKeys, type LinkKeys } from '../keys.ts';
import type { Signaling } from '../ports/signaling.ts';
import type { Role } from '../protocol/frames.ts';
import { SignalSession } from '../signaling/envelope.ts';
import type { MessageChannelLike } from '../transport/channel.ts';
import { type ConnectOptions, connect } from '../transport/peer.ts';
import type { RtcFactory } from '../transport/rtc.ts';
import { type ReceiveOutcome, Receiver, type ReceiverOptions, type ReceiverProgress } from './receiver.ts';
import { Sender, type SenderOptions, type SenderProgress } from './sender.ts';
import { phaseForError, type TransferPhase } from './types.ts';

/** Phases before the engine takes over, then the engine's own phases. */
export type LinkPhase = 'joining' | 'waiting' | 'connecting' | TransferPhase;

export interface LinkOptions {
  secret: Bytes;
  signaling: Signaling;
  rtc: RtcFactory;
  iceServers: RTCIceServer[];
  timeouts?: Partial<Pick<ConnectOptions, 'peerTimeoutMs' | 'connectTimeoutMs' | 'joinIntervalMs'>>;
  config?: Partial<TransferConfig>;
}

abstract class LinkSession<P> extends Emitter<{ phase: LinkPhase; progress: P }> {
  protected readonly opts: LinkOptions;
  readonly #abort = new AbortController();
  #engine: { cancel(): void } | undefined;
  #signal: SignalSession | undefined;

  constructor(opts: LinkOptions) {
    super();
    this.opts = opts;
  }

  /** Stop the attempt at whatever stage it is in. `start()` rejects with CANCELLED. */
  cancel(): void {
    if (this.#engine) this.#engine.cancel();
    else this.#abort.abort();
  }

  protected async run<T>(
    role: Role,
    engine: (channel: MessageChannelLike, keys: LinkKeys) => { cancel(): void; start(): Promise<T> },
  ): Promise<T> {
    let engineStarted = false;
    try {
      const { channel, keys } = await this.#connect(role);
      const e = engine(channel, keys);
      this.#engine = e;
      if (this.#abort.signal.aborted) e.cancel();
      engineStarted = true;
      return await e.start();
    } catch (err) {
      const error = toTransferError(err);
      // The engine reports its own terminal phase; before that, we do.
      if (!engineStarted) this.emit('phase', phaseForError(error));
      throw error;
    } finally {
      void this.#signal?.close().catch(() => {});
    }
  }

  async #connect(role: Role): Promise<{ channel: MessageChannelLike; keys: LinkKeys }> {
    const { secret, signaling, rtc, iceServers, timeouts } = this.opts;
    const cfg = resolveConfig(this.opts.config);
    this.emit('phase', 'joining');
    const keys = await deriveLinkKeys(secret);
    const room = await signaling.join(keys.roomTopic).catch((cause: unknown) => {
      throw isTransferError(cause)
        ? cause
        : new TransferError(ErrorCode.SignalingUnreachable, `${signaling.id}: join failed`, { cause });
    });
    this.#signal = new SignalSession(room, keys.signalKey, { maxSkewMs: cfg.signalingMaxSkewMs });
    if (this.#abort.signal.aborted) throw new TransferError(ErrorCode.Cancelled);

    this.emit('phase', 'waiting');
    const channel = await connect({
      role,
      signal: this.#signal,
      rtc,
      iceServers,
      ...timeouts,
      abort: this.#abort.signal,
      onConnecting: () => this.emit('phase', 'connecting'),
    });
    // The DataChannel is up: nothing more to say on the relays.
    void this.#signal.close().catch(() => {});
    return { channel, keys };
  }
}

export interface LinkSenderOptions extends LinkOptions {
  files: SenderOptions['files'];
  confirmPeer?: SenderOptions['confirmPeer'];
}

export class LinkSender extends LinkSession<SenderProgress> {
  readonly #files: SenderOptions['files'];
  readonly #confirmPeer: SenderOptions['confirmPeer'];

  constructor(opts: LinkSenderOptions) {
    super(opts);
    if (opts.files.length === 0) throw new RangeError('nothing to send');
    this.#files = opts.files;
    this.#confirmPeer = opts.confirmPeer;
  }

  /** Resolves when the receiver confirmed every file; rejects with a TransferError. */
  start(): Promise<void> {
    return this.run('sender', (channel, keys) => {
      const sender = new Sender(channel, {
        sessionIkm: keys.sessionIkm,
        files: this.#files,
        ...(this.opts.config && { config: this.opts.config }),
        ...(this.#confirmPeer && { confirmPeer: this.#confirmPeer }),
      });
      sender.on('phase', (p) => this.emit('phase', p));
      sender.on('progress', (p) => this.emit('progress', p));
      return sender;
    });
  }
}

export interface LinkReceiverOptions extends LinkOptions {
  onManifest: ReceiverOptions['onManifest'];
}

export class LinkReceiver extends LinkSession<ReceiverProgress> {
  readonly #onManifest: ReceiverOptions['onManifest'];

  constructor(opts: LinkReceiverOptions) {
    super(opts);
    this.#onManifest = opts.onManifest;
  }

  start(): Promise<ReceiveOutcome> {
    return this.run('receiver', (channel, keys) => {
      const receiver = new Receiver(channel, {
        sessionIkm: keys.sessionIkm,
        onManifest: this.#onManifest,
        ...(this.opts.config && { config: this.opts.config }),
      });
      receiver.on('phase', (p) => this.emit('phase', p));
      receiver.on('progress', (p) => this.emit('progress', p));
      return receiver;
    });
  }
}
