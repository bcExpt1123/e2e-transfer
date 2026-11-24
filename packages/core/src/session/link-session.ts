/**
 * Transfers over a secret link (docs/ARCHITECTURE.md § Session lifecycle).
 *
 * - LinkReceiver joins the signaling room, connects and runs the Receiver engine. After a lost
 *   connection it reconnects and resumes the transfer (PROTOCOL §4.6).
 * - LinkSender stays in the room and gives every receiver that joins its own slot: connection,
 *   session keys, Sender engine and resume. Up to `maxReceivers` slots run at once. With the
 *   default of 1 it is a single transfer and `start()` settles when that transfer does.
 * - Manual mode (offer in the link, reply pasted back) is one connection without resume.
 */
import type { Bytes } from '../bytes.ts';
import { resolveConfig, type TransferConfig } from '../config.ts';
import { Emitter } from '../emitter.ts';
import {
  ErrorCode,
  type ErrorCode as ErrorCodeType,
  isTransferError,
  TransferError,
  toTransferError,
} from '../errors.ts';
import { deriveLinkKeys, type LinkKeys } from '../keys.ts';
import type { Signaling, SignalingRoom } from '../ports/signaling.ts';
import { type SignalMessage, SignalSession } from '../signaling/envelope.ts';
import type { MessageChannelLike } from '../transport/channel.ts';
import { createManualAnswer, createManualOffer, type ManualOffer } from '../transport/manual.ts';
import { CONNECT_DEFAULTS, type ConnectOptions, connect, type SignalPort } from '../transport/peer.ts';
import type { RtcFactory } from '../transport/rtc.ts';
import {
  discardResume,
  type ReceiveOutcome,
  Receiver,
  type ReceiverOptions,
  type ReceiverProgress,
  type ReceiverResume,
} from './receiver.ts';
import { RESUME_DEFAULTS } from './resume.ts';
import {
  type PeerInfo,
  Sender,
  type SenderOptions,
  type SenderProgress,
  type SenderResume,
} from './sender.ts';
import { phaseForError, type TransferPhase } from './types.ts';

/** Phases before the engine takes over, then the engine's own phases. */
export type LinkPhase = 'joining' | 'waiting' | 'connecting' | 'reconnecting' | TransferPhase;

const TERMINAL: ReadonlySet<LinkPhase> = new Set<LinkPhase>(['done', 'declined', 'cancelled', 'failed']);
export const isTerminalPhase = (p: LinkPhase): boolean => TERMINAL.has(p);

export interface LinkTimeouts
  extends Pick<ConnectOptions, 'peerTimeoutMs' | 'connectTimeoutMs' | 'joinIntervalMs'> {
  /** After a lost connection, give up when no new one is up within this time. */
  resumeTimeoutMs?: number;
}

export interface LinkOptions {
  secret: Bytes;
  signaling: Signaling;
  rtc: RtcFactory;
  iceServers: RTCIceServer[];
  timeouts?: LinkTimeouts;
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

const cancelled = () => new TransferError(ErrorCode.Cancelled);

function joinRoom(signaling: Signaling, topic: string): Promise<SignalingRoom> {
  return signaling.join(topic).catch((cause: unknown) => {
    throw isTransferError(cause)
      ? cause
      : new TransferError(ErrorCode.SignalingUnreachable, `${signaling.id}: join failed`, { cause });
  });
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

/** Time limit for one resume; calls `onExpire` when it passes. */
class Deadline {
  expired = false;
  readonly #timer: ReturnType<typeof setTimeout>;
  constructor(ms: number, onExpire: () => void) {
    this.#timer = setTimeout(() => {
      this.expired = true;
      onExpire();
    }, ms);
  }
  stop() {
    clearTimeout(this.#timer);
  }
}

const resumeTimeout = (o: LinkOptions) => o.timeouts?.resumeTimeoutMs ?? RESUME_DEFAULTS.resumeTimeoutMs;

// ── Receiver ────────────────────────────────────────────────────────────────

export interface LinkReceiverOptions extends LinkOptions {
  onManifest: ReceiverOptions['onManifest'];
}

export class LinkReceiver extends Emitter<LinkEvents<ReceiverProgress>> {
  readonly #opts: LinkReceiverOptions;
  readonly #abort = new AbortController();
  #attempt: AbortController | undefined;
  #engine: Receiver | undefined;
  #lastPhase: LinkPhase | undefined;
  #resuming = false;

  constructor(opts: LinkReceiverOptions) {
    super();
    this.#opts = opts;
  }

  /** Stop at whatever stage. `start()` rejects with CANCELLED. */
  cancel(): void {
    this.#abort.abort();
    this.#attempt?.abort();
    this.#engine?.cancel();
  }

  async start(): Promise<ReceiveOutcome> {
    const o = this.#opts;
    const manual = o.offer !== undefined || o.manual === true;
    let resume: ReceiverResume | undefined;
    let deadline: Deadline | undefined;
    let lost: TransferError | undefined;
    try {
      this.#phase('joining');
      const keys = await deriveLinkKeys(o.secret);
      for (let tries = 0; ; tries++) {
        // The first reconnect is immediate; later ones are spaced out.
        if (tries > 1)
          await pause(o.timeouts?.joinIntervalMs ?? CONNECT_DEFAULTS.joinIntervalMs, this.#abort.signal);
        const attempt = new AbortController();
        this.#attempt = attempt;
        if (this.#abort.signal.aborted) attempt.abort();
        let engine: Receiver | undefined;
        try {
          if (attempt.signal.aborted) throw cancelled();
          const channel = manual
            ? await this.#connectManual(keys, attempt.signal)
            : await this.#connectRelay(keys, attempt.signal, resume?.ticket.id);
          engine = new Receiver(channel, {
            sessionIkm: keys.sessionIkm,
            onManifest: o.onManifest,
            resumable: !manual,
            ...(o.config && { config: o.config }),
            ...(resume && { resume }),
          });
          this.#engine = engine;
          if (this.#abort.signal.aborted) engine.cancel();
          engine.on('phase', (p) => {
            if (p === 'transferring') {
              this.#resuming = false;
              deadline?.stop();
              deadline = undefined;
              lost = undefined;
            }
            if (!TERMINAL.has(p)) this.#phase(p);
          });
          engine.on('progress', (p) => this.emit('progress', p));
          engine.on('words', (w) => this.emit('words', w));
          const outcome = await engine.start();
          this.#phase(outcome === 'declined' ? 'declined' : 'done');
          return outcome;
        } catch (err) {
          this.#engine = undefined;
          // A failed connect keeps the previous resume state; a failed engine says whether it can go on.
          const next = this.#abort.signal.aborted ? undefined : engine ? engine.resumeState() : resume;
          if (next && !deadline?.expired) {
            lost ??= toTransferError(err);
            deadline ??= new Deadline(resumeTimeout(o), () => this.#attempt?.abort());
            resume = next;
            this.#resuming = true;
            this.#phase('reconnecting');
            continue;
          }
          await discardResume(engine ? next : resume);
          throw deadline?.expired && lost ? lost : err;
        }
      }
    } catch (err) {
      deadline?.stop();
      const error = toTransferError(err);
      this.#phase(phaseForError(error));
      throw error;
    }
  }

  #phase(p: LinkPhase) {
    // While resuming, everything before the transfer continues is one "reconnecting" step.
    const shown = this.#resuming && !TERMINAL.has(p) && p !== 'transferring' ? 'reconnecting' : p;
    if (shown === this.#lastPhase) return;
    this.#lastPhase = shown;
    this.emit('phase', shown);
  }

  async #connectRelay(keys: LinkKeys, abort: AbortSignal, resumeId?: string): Promise<MessageChannelLike> {
    const o = this.#opts;
    const room = await joinRoom(o.signaling, keys.roomTopic);
    const signal = new SignalSession(room, keys.signalKey, {
      maxSkewMs: resolveConfig(o.config).signalingMaxSkewMs,
    });
    try {
      if (abort.aborted) throw cancelled();
      this.#phase('waiting');
      return await connect({
        role: 'receiver',
        signal,
        rtc: o.rtc,
        iceServers: o.iceServers,
        ...o.timeouts,
        abort,
        ...(o.hint && { hint: o.hint }),
        ...(resumeId && { resumeId }),
        onConnecting: () => this.#phase('connecting'),
      });
    } finally {
      // The DataChannel is up (or this attempt is over): nothing more to say on the relays.
      void signal.close().catch(() => {});
    }
  }

  async #connectManual(keys: LinkKeys, abort: AbortSignal): Promise<MessageChannelLike> {
    const o = this.#opts;
    const connectTimeoutMs = o.timeouts?.connectTimeoutMs;
    const answer = await createManualAnswer({
      rtc: o.rtc,
      iceServers: o.iceServers,
      signalKey: keys.signalKey,
      abort,
      offerCode: o.offer ?? '',
      ...(connectTimeoutMs && { connectTimeoutMs }),
    });
    this.emit('code', answer.code);
    this.#phase('waiting');
    return answer.channel;
  }
}

// ── Sender ──────────────────────────────────────────────────────────────────

/** One device that connected through the link (LinkSender `receivers` event). */
export interface ReceiverInfo {
  /** Stable id of this receiver within the share. */
  key: number;
  /** Browser and OS the device reported (unverified). */
  hint?: string;
  phase: LinkPhase;
  progress: SenderProgress;
  error?: ErrorCodeType;
}

export type LinkSenderEvents = LinkEvents<SenderProgress> & {
  /** Every receiver of this share so far, in arrival order. */
  receivers: readonly ReceiverInfo[];
};

export interface LinkSenderOptions extends LinkOptions {
  files: SenderOptions['files'];
  confirmPeer?: SenderOptions['confirmPeer'];
  /**
   * How many receivers may download at the same time (relay mode). Default 1: a single
   * transfer, and others who open the link are told the sender is busy.
   */
  maxReceivers?: number;
}

export class LinkSender extends Emitter<LinkSenderEvents> {
  readonly #opts: LinkSenderOptions;
  readonly #abort = new AbortController();
  readonly #ended = Promise.withResolvers<void>();
  readonly #slots: ReceiverSlot[] = [];
  readonly #toldBusy = new Set<string>();
  #nextKey = 1;
  #lastPhase: LinkPhase | undefined;
  #signal: SignalSession | undefined;
  #manualOffer: ManualOffer | undefined;
  #manualEngine: Sender | undefined;
  #replied = false;

  constructor(opts: LinkSenderOptions) {
    super();
    if (opts.files.length === 0) throw new RangeError('nothing to send');
    this.#opts = opts;
    this.#ended.promise.catch(() => {});
  }

  get #max(): number {
    return this.#opts.manual ? 1 : Math.max(1, Math.floor(this.#opts.maxReceivers ?? 1));
  }

  get receivers(): ReceiverInfo[] {
    return this.#slots.map((s) => s.info());
  }

  /** Stop sharing: cancels every transfer. `start()` rejects with CANCELLED. */
  cancel(): void {
    this.#abort.abort();
    this.#manualEngine?.cancel();
    for (const slot of this.#slots) slot.cancel();
    this.#ended.reject(cancelled());
  }

  /** Stop the transfer to one receiver; the link stays open for others. */
  cancelReceiver(key: number): void {
    this.#slots.find((s) => s.key === key)?.cancel();
  }

  /**
   * Manual mode: apply the receiver's reply code. Resolves false if the code is damaged
   * or belongs to another link (the user can paste again).
   */
  async acceptReply(code: string): Promise<boolean> {
    if (!this.#manualOffer) return false;
    if (this.#replied) return true;
    try {
      await this.#manualOffer.accept(code);
    } catch {
      return false;
    }
    this.#replied = true;
    this.#phase('connecting');
    return true;
  }

  /**
   * Single receiver: resolves when it confirmed every file. Several receivers: runs until
   * `cancel()`. Rejects with a TransferError.
   */
  async start(): Promise<void> {
    try {
      this.#phase('joining');
      const keys = await deriveLinkKeys(this.#opts.secret);
      if (this.#opts.manual) await this.#runManual(keys);
      else await this.#runShare(keys);
      this.#phase('done');
    } catch (err) {
      const error = toTransferError(err);
      for (const slot of this.#slots) slot.cancel();
      this.#phase(phaseForError(error));
      throw error;
    } finally {
      void this.#signal?.close().catch(() => {});
    }
  }

  #phase(p: LinkPhase) {
    if (p === this.#lastPhase) return;
    this.#lastPhase = p;
    this.emit('phase', p);
  }

  async #runManual(keys: LinkKeys): Promise<void> {
    const o = this.#opts;
    const connectTimeoutMs = o.timeouts?.connectTimeoutMs;
    const offer = await createManualOffer({
      rtc: o.rtc,
      iceServers: o.iceServers,
      signalKey: keys.signalKey,
      abort: this.#abort.signal,
      ...(connectTimeoutMs && { connectTimeoutMs }),
    });
    this.#manualOffer = offer;
    this.emit('code', offer.code);
    this.#phase('waiting');
    const channel = await offer.channel;
    const engine = new Sender(channel, {
      sessionIkm: keys.sessionIkm,
      files: o.files,
      ...(o.config && { config: o.config }),
      ...(o.confirmPeer && { confirmPeer: o.confirmPeer }),
    });
    this.#manualEngine = engine;
    if (this.#abort.signal.aborted) engine.cancel();
    engine.on('phase', (p) => !TERMINAL.has(p) && this.#phase(p));
    engine.on('progress', (p) => this.emit('progress', p));
    await engine.start();
  }

  async #runShare(keys: LinkKeys): Promise<void> {
    const o = this.#opts;
    const room = await joinRoom(o.signaling, keys.roomTopic);
    const signal = new SignalSession(room, keys.signalKey, {
      maxSkewMs: resolveConfig(o.config).signalingMaxSkewMs,
    });
    this.#signal = signal;
    if (this.#abort.signal.aborted) throw cancelled();
    // Stay in the room for the whole share: new receivers, and receivers coming back to resume.
    signal.on((msg) => this.#dispatch(msg, keys, signal));
    this.#phase('waiting');
    await this.#ended.promise;
  }

  #dispatch(msg: SignalMessage, keys: LinkKeys, signal: SignalSession) {
    const known = this.#slots.find((s) => s.active && s.peerId === msg.from);
    if (known) {
      known.deliver(msg);
      return;
    }
    if (msg.t !== 'join') return;
    const resumeId = typeof msg.d.resume === 'string' ? msg.d.resume : undefined;
    if (resumeId !== undefined) {
      // A receiver coming back after a lost connection. Unknown tickets are stale: ignore them.
      this.#slots.find((s) => s.active && s.owns(resumeId))?.rejoin(msg);
      return;
    }
    if (this.#slots.filter((s) => s.active).length >= this.#max) {
      if (!this.#toldBusy.has(msg.from)) {
        if (this.#toldBusy.size > 1000) this.#toldBusy.clear();
        this.#toldBusy.add(msg.from);
        void signal.send('bye', { reason: 'busy' }, msg.from).catch(() => {});
      }
      return;
    }
    const slot = new ReceiverSlot(this.#nextKey++, msg, {
      opts: this.#opts,
      keys,
      signal,
      changed: (s, what) => this.#slotChanged(s, what),
    });
    this.#slots.push(slot);
    this.#slotChanged(slot, 'phase');
    slot.run().then(
      () => this.#slotEnded(slot),
      (err: unknown) => this.#slotEnded(slot, toTransferError(err)),
    );
  }

  #slotChanged(slot: ReceiverSlot, what: 'phase' | 'progress') {
    this.#emitReceivers();
    if (this.#max > 1) return;
    if (what === 'progress') this.emit('progress', { ...slot.progress });
    else if (!TERMINAL.has(slot.phase)) this.#phase(slot.phase);
  }

  #slotEnded(slot: ReceiverSlot, error?: TransferError) {
    this.#emitReceivers();
    if (this.#max > 1 || this.#abort.signal.aborted) return; // several receivers: the share stays open
    if (!error) this.#ended.resolve();
    else if (slot.declinedByUs)
      this.#phase('waiting'); // keep the link open for the right device
    else this.#ended.reject(error);
  }

  #emitReceivers() {
    this.emit('receivers', this.receivers);
  }
}

interface SlotHost {
  opts: LinkSenderOptions;
  keys: LinkKeys;
  signal: SignalSession;
  changed(slot: ReceiverSlot, what: 'phase' | 'progress'): void;
}

/** One receiver of a LinkSender: connects, runs a Sender, and resumes after a lost connection. */
class ReceiverSlot {
  /** The receiver's current signaling id (new after each reconnect). */
  peerId: string;
  hint: string | undefined;
  phase: LinkPhase = 'connecting';
  progress: SenderProgress = { sent: 0, acked: 0, total: 0 };
  error: TransferError | undefined;
  /** Our user turned this device away (the link stays open for another). */
  declinedByUs = false;

  readonly #host: SlotHost;
  readonly #listeners = new Set<(msg: SignalMessage) => void>();
  #join: SignalMessage;
  #nextJoin: SignalMessage | undefined;
  #joinWaiter: PromiseWithResolvers<SignalMessage> | undefined;
  #attempt: AbortController | undefined;
  #engine: Sender | undefined;
  #resume: SenderResume | undefined;
  #deadline: Deadline | undefined;
  #cancelled = false;

  constructor(
    readonly key: number,
    join: SignalMessage,
    host: SlotHost,
  ) {
    this.peerId = join.from;
    this.#join = join;
    this.#host = host;
  }

  get active(): boolean {
    return !TERMINAL.has(this.phase);
  }

  info(): ReceiverInfo {
    return {
      key: this.key,
      ...(this.hint && { hint: this.hint }),
      phase: this.phase,
      progress: { ...this.progress },
      ...(this.error && { error: this.error.code }),
    };
  }

  /** Is `resumeId` one of the tickets this receiver may come back with? */
  owns(resumeId: string): boolean {
    return (
      (this.#engine?.ticketIds.includes(resumeId) ?? false) ||
      (this.#resume?.tickets.some((t) => t.id === resumeId) ?? false)
    );
  }

  deliver(msg: SignalMessage) {
    for (const cb of [...this.#listeners]) cb(msg);
  }

  /** The receiver is back under a new signaling id with one of our tickets. */
  rejoin(msg: SignalMessage) {
    this.peerId = msg.from;
    const waiter = this.#joinWaiter;
    if (waiter) {
      this.#joinWaiter = undefined;
      waiter.resolve(msg);
      return;
    }
    this.#nextJoin = msg;
    // We haven't noticed the drop yet, or are still connecting to an older attempt: let it go.
    this.#engine?.interrupt();
    this.#attempt?.abort();
  }

  cancel() {
    this.#cancelled = true;
    this.#attempt?.abort();
    this.#engine?.cancel();
    const waiter = this.#joinWaiter;
    this.#joinWaiter = undefined;
    waiter?.reject(cancelled());
  }

  async run(): Promise<void> {
    const { opts, keys } = this.#host;
    let lost: TransferError | undefined;
    for (;;) {
      const resume = this.#resume;
      const join = this.#join;
      const attempt = new AbortController();
      this.#attempt = attempt;
      if (this.#cancelled) attempt.abort();
      let resumed = false;
      let engine: Sender | undefined;
      try {
        const channel = await connect({
          role: 'sender',
          signal: this.#port(join),
          rtc: opts.rtc,
          iceServers: opts.iceServers,
          ...opts.timeouts,
          abort: attempt.signal,
          onConnecting: (peer) => {
            if (!resume) this.hint = peer.hint;
            this.#setPhase(resume ? 'reconnecting' : 'connecting');
          },
        });
        const ticket = resume?.tickets.find((t) => t.id === join.d.resume);
        if (resume && !ticket) throw new TransferError(ErrorCode.ConnectionLost, 'rejoin without a ticket');
        const confirmPeer = opts.confirmPeer;
        engine = new Sender(channel, {
          sessionIkm: keys.sessionIkm,
          files: opts.files,
          resumable: true,
          ...(opts.config && { config: opts.config }),
          ...(resume && ticket && { resume: { ticket, files: resume.files, total: resume.total } }),
          ...(confirmPeer && {
            confirmPeer: (peer: PeerInfo) =>
              confirmPeer({ ...peer, key: this.key, ...(this.hint && { hint: this.hint }) }),
          }),
        });
        this.#engine = engine;
        if (this.#cancelled) engine.cancel();
        engine.on('phase', (p) => {
          if (p === 'transferring') {
            resumed = true;
            this.#resume = undefined;
            this.#deadline?.stop();
            this.#deadline = undefined;
            lost = undefined;
          }
          if (!TERMINAL.has(p)) this.#setPhase(resume && !resumed ? 'reconnecting' : p);
        });
        engine.on('progress', (p) => {
          this.progress = p;
          this.#host.changed(this, 'progress');
        });
        await engine.start();
        this.#setPhase('done');
        return;
      } catch (err) {
        let error = toTransferError(err);
        this.#engine = undefined;
        const next = this.#cancelled ? undefined : engine ? engine.resumeState() : resume;
        if (next && !this.#deadline?.expired) {
          lost ??= error;
          this.#resume = next;
          this.#deadline ??= new Deadline(resumeTimeout(opts), () => this.#expire());
          this.#setPhase('reconnecting');
          try {
            this.#join = await this.#waitForRejoin();
            continue;
          } catch (waitErr) {
            error = toTransferError(waitErr);
          }
        }
        if (this.#deadline?.expired && lost) error = lost;
        this.#deadline?.stop();
        const byUs = !(error as TransferError & { fromPeer?: boolean }).fromPeer;
        if (engine && error.code === ErrorCode.Declined && byUs) this.declinedByUs = true;
        this.error = error;
        this.#setPhase(phaseForError(error));
        throw error;
      }
    }
  }

  /** Signaling as seen by this receiver's connection attempt: its messages only, starting with `join`. */
  #port(join: SignalMessage): SignalPort {
    const signal = this.#host.signal;
    return {
      send: (t, d, to) => signal.send(t, d, to),
      on: (cb) => {
        this.#listeners.add(cb);
        queueMicrotask(() => this.#listeners.has(cb) && cb(join));
        return () => this.#listeners.delete(cb);
      },
    };
  }

  #waitForRejoin(): Promise<SignalMessage> {
    const ready = this.#nextJoin;
    this.#nextJoin = undefined;
    if (ready) return Promise.resolve(ready);
    if (this.#cancelled) return Promise.reject(cancelled());
    this.#joinWaiter = Promise.withResolvers();
    return this.#joinWaiter.promise;
  }

  #expire() {
    this.#attempt?.abort();
    const waiter = this.#joinWaiter;
    this.#joinWaiter = undefined;
    waiter?.reject(new TransferError(ErrorCode.ConnectionLost, 'receiver did not come back'));
  }

  #setPhase(p: LinkPhase) {
    if (p === this.phase) return;
    this.phase = p;
    this.#host.changed(this, 'phase');
  }
}
