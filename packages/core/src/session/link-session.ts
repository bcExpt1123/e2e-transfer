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
import { createManualAnswer, createManualOffer, type ManualOffer } from '../transport/manual.ts';
import { type ConnectOptions, connect } from '../transport/peer.ts';
import type { RtcFactory } from '../transport/rtc.ts';
import { type ReceiveOutcome, Receiver, type ReceiverOptions, type ReceiverProgress } from './receiver.ts';
import { type PeerInfo, Sender, type SenderOptions, type SenderProgress } from './sender.ts';
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
  /** Receiver: device description shown to the sender on the Approve screen. */
  hint?: string;
  /** Sender: connect manually (offer in the link, reply pasted back) instead of via signaling. */
  manual?: boolean;
  /** Receiver: the offer code from a manual link. */
  offer?: string;
}

export type LinkEvents<P> = {
  phase: LinkPhase;
  progress: P;
  words: readonly string[];
  /** Manual mode: the code to hand to the other device (sender: the offer for the link; receiver: the reply). */
  code: string;
};

abstract class LinkSession<P> extends Emitter<LinkEvents<P>> {
  protected readonly opts: LinkOptions;
  readonly #abort = new AbortController();
  #engine: { cancel(): void } | undefined;
  #signal: SignalSession | undefined;
  /** What the other device said about itself in signaling (sender side only). */
  protected peerHint: string | undefined;
  protected manualOffer: ManualOffer | undefined;

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
    if (this.opts.manual || this.opts.offer) return { channel: await this.#connectManual(role, keys), keys };
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
      ...(this.opts.hint && { hint: this.opts.hint }),
      onConnecting: (peer) => {
        this.peerHint = peer.hint;
        this.emit('phase', 'connecting');
      },
    });
    // The DataChannel is up: nothing more to say on the relays.
    void this.#signal.close().catch(() => {});
    return { channel, keys };
  }

  async #connectManual(role: Role, keys: LinkKeys): Promise<MessageChannelLike> {
    const base = {
      rtc: this.opts.rtc,
      iceServers: this.opts.iceServers,
      signalKey: keys.signalKey,
      abort: this.#abort.signal,
      ...(this.opts.timeouts?.connectTimeoutMs && { connectTimeoutMs: this.opts.timeouts.connectTimeoutMs }),
    };
    if (role === 'sender') {
      const offer = await createManualOffer(base);
      this.manualOffer = offer;
      this.emit('code', offer.code);
      this.emit('phase', 'waiting');
      return offer.channel;
    }
    const answer = await createManualAnswer({ ...base, offerCode: this.opts.offer ?? '' });
    this.emit('code', answer.code);
    this.emit('phase', 'waiting');
    return answer.channel;
  }
}

export interface LinkSenderOptions extends LinkOptions {
  files: SenderOptions['files'];
  confirmPeer?: SenderOptions['confirmPeer'];
}

export class LinkSender extends LinkSession<SenderProgress> {
  #replied = false;
  readonly #files: SenderOptions['files'];
  readonly #confirmPeer: SenderOptions['confirmPeer'];

  constructor(opts: LinkSenderOptions) {
    super(opts);
    if (opts.files.length === 0) throw new RangeError('nothing to send');
    this.#files = opts.files;
    this.#confirmPeer = opts.confirmPeer;
  }

  /**
   * Manual mode: apply the receiver's reply code. Resolves false if the code is damaged
   * or belongs to another link (the user can paste again).
   */
  async acceptReply(code: string): Promise<boolean> {
    if (!this.manualOffer) return false;
    if (this.#replied) return true;
    try {
      await this.manualOffer.accept(code);
    } catch {
      return false;
    }
    this.#replied = true;
    this.emit('phase', 'connecting');
    return true;
  }

  /** Resolves when the receiver confirmed every file; rejects with a TransferError. */
  start(): Promise<void> {
    return this.run('sender', (channel, keys) => {
      const sender = new Sender(channel, {
        sessionIkm: keys.sessionIkm,
        files: this.#files,
        ...(this.opts.config && { config: this.opts.config }),
        ...(this.#confirmPeer && {
          confirmPeer: (peer: PeerInfo) =>
            this.#confirmPeer?.(this.peerHint ? { ...peer, hint: this.peerHint } : peer) ?? true,
        }),
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
      receiver.on('words', (w) => this.emit('words', w));
      return receiver;
    });
  }
}
