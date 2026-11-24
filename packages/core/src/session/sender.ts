/** Sending side of a transfer (docs/PROTOCOL.md §4.4). */
import { resolveConfig, type TransferConfig } from '../config.ts';
import { Emitter } from '../emitter.ts';
import { ErrorCode, TransferError } from '../errors.ts';
import type { ResumeTicket } from '../keys.ts';
import {
  decodeJson,
  decodePosition,
  encodeChunk,
  encodeJson,
  encodePosition,
  FrameType,
  protocolError,
} from '../protocol/frames.ts';
import { type Accept, type Manifest, validateAccept } from '../protocol/manifest.ts';
import type { MessageChannelLike } from '../transport/channel.ts';
import { canResumeAfter } from './resume.ts';
import { peerError, SecureChannel, terminalFrameError, unexpectedFrame } from './secure-channel.ts';
import type { SourceFile } from './source.ts';
import { phaseForError, type TransferPhase } from './types.ts';

export interface SenderProgress {
  /** Bytes handed to the channel. */
  sent: number;
  /** Bytes the receiver confirmed as written. */
  acked: number;
  /** Total bytes of the accepted files. */
  total: number;
}

/** What the user can check about the other device before trusting it. */
export interface PeerInfo {
  /** Verification words; the same on both screens only within one session. */
  words: readonly string[];
  /** Browser and OS the other device reported, e.g. "Firefox on Android" (unverified). */
  hint?: string;
  /** LinkSender: which receiver is asking (`ReceiverInfo.key`). */
  key?: number;
}

/** What a sender needs to continue an interrupted transfer (PROTOCOL §4.6). */
export interface SenderResume {
  /** Tickets the receiver may present, newest first. */
  tickets: readonly ResumeTicket[];
  /** Files still being sent when the connection dropped (from the last ACCEPT), in order. */
  files: readonly number[];
  /** Total bytes of the originally accepted files (for progress). */
  total: number;
}

export type SenderEvents = {
  phase: TransferPhase;
  progress: SenderProgress;
};

export interface SenderOptions {
  sessionIkm: CryptoKey;
  files: readonly SourceFile[];
  config?: Partial<TransferConfig>;
  /**
   * Asked after the secure handshake, before anything about the files is revealed.
   * Returning false tells the receiver DECLINED (docs/UX.md § Send: Approve).
   */
  confirmPeer?: (peer: PeerInfo) => boolean | Promise<boolean>;
  /** Keep what's needed to resume after a lost connection (see `resumeState()`). */
  resumable?: boolean;
  /** Continue an interrupted transfer: handshake with `ticket`, no approval, send from the receiver's offsets. */
  resume?: { ticket: ResumeTicket; files: readonly number[]; total: number };
}

export class Sender extends Emitter<SenderEvents> {
  readonly #cfg: TransferConfig;
  readonly #secure: SecureChannel;
  readonly #opts: SenderOptions;
  #progress: SenderProgress = { sent: 0, acked: 0, total: 0 };
  #ackWaiter: (() => void) | undefined;
  /** Set once this session's ACCEPT arrived. */
  #accepted: Accept | undefined;
  #error: TransferError | undefined;

  constructor(channel: MessageChannelLike, opts: SenderOptions) {
    super();
    if (opts.files.length === 0) throw new RangeError('nothing to send');
    this.#cfg = resolveConfig(opts.config);
    this.#opts = opts;
    this.#secure = new SecureChannel(channel, 'sender', this.#cfg);
  }

  /** Runs the whole transfer. Resolves when the receiver confirmed DONE; rejects with a TransferError. */
  async start(): Promise<void> {
    const secure = this.#secure;
    const resume = this.#opts.resume;
    try {
      this.emit('phase', 'handshaking');
      await secure.handshake(resume ? resume.ticket.ikm : this.#opts.sessionIkm);
      this.emit('phase', 'connected');
      // A resumed session's peer proved it is the device approved before (it holds the ticket).
      if (this.#opts.confirmPeer && !resume) {
        const ok = await this.#opts.confirmPeer({ words: secure.words });
        if (secure.error) throw secure.error;
        if (!ok) throw new TransferError(ErrorCode.Declined, 'sender declined the receiver');
      }

      const manifest: Manifest = {
        files: this.#opts.files.map(({ path, size, mime }) => ({ path, size, mime })),
        chunkSize: this.#cfg.chunkSize,
        total: this.#opts.files.reduce((n, f) => n + f.size, 0),
      };
      await secure.send(FrameType.Manifest, encodeJson(manifest));
      this.emit('phase', 'awaiting-accept');

      const reply = await secure.next();
      if (reply.type === FrameType.Reject) throw peerError(ErrorCode.Declined, 'receiver declined');
      if (reply.type !== FrameType.Accept) throw unexpectedFrame(reply, 'ACCEPT');
      const accept = validateAccept(decodeJson(reply.payload), manifest);
      const offsets = accept.resume ?? {};
      const sizeOf = (i: number) => manifest.files[i]?.size ?? 0;
      let total: number;
      if (resume) {
        // The receiver lists what it still needs; it can only shrink.
        if (accept.files.some((i) => !resume.files.includes(i)))
          throw protocolError('resume asks for new files');
        total = resume.total;
      } else {
        if (Object.keys(offsets).length > 0) throw protocolError('resume offsets in a fresh ACCEPT');
        total = accept.files.reduce((n, i) => n + sizeOf(i), 0);
      }
      this.#accepted = accept;
      const remaining = accept.files.reduce((n, i) => n + sizeOf(i) - (offsets[i] ?? 0), 0);
      this.#progress = { sent: total - remaining, acked: total - remaining, total };
      this.emit('phase', 'transferring');
      this.emit('progress', { ...this.#progress });

      let sentAll = false;
      const peerDone = this.#readReplies(accept, () => sentAll);
      // A peer CANCEL/ERROR (or a bad ACK) must also stop the send loop below.
      peerDone.catch((err) => void secure.abort(err));

      for (const index of accept.files) await this.#sendFile(index, offsets[index] ?? 0);
      sentAll = true;
      this.emit('phase', 'finishing');
      await secure.send(FrameType.Done);
      await peerDone;

      secure.finish();
      this.emit('phase', 'done');
    } catch (err) {
      const error = await secure.abort(err);
      this.#error = error;
      this.emit('phase', phaseForError(error));
      throw error;
    }
  }

  /**
   * After `start()` rejected: what's needed to continue on a new connection, or undefined
   * if this failure ends the transfer (see `canResumeAfter`).
   */
  resumeState(): SenderResume | undefined {
    const error = this.#error;
    const resume = this.#opts.resume;
    if (!this.#opts.resumable || !error) return undefined;
    if (!canResumeAfter(error, resume !== undefined && !this.#accepted)) return undefined;
    const ticket = this.#secure.ticket;
    if (this.#accepted && ticket) {
      return { tickets: [ticket], files: this.#accepted.files, total: this.#progress.total };
    }
    if (!resume) return undefined; // never got as far as transferring
    // The receiver may already have switched to this session's ticket (it sent ACCEPT) or not.
    const tickets = ticket ? [ticket, resume.ticket] : [resume.ticket];
    return { tickets, files: resume.files, total: resume.total };
  }

  /** Ids of the tickets the receiver could present to resume this transfer right now. */
  get ticketIds(): string[] {
    const ids = [this.#secure.ticket?.id, this.#accepted ? undefined : this.#opts.resume?.ticket.id];
    return ids.filter((id): id is string => id !== undefined);
  }

  /** The receiver is back on a new connection: drop this one as lost (it can then be resumed). */
  interrupt(): void {
    void this.#secure.abort(new TransferError(ErrorCode.ConnectionLost, 'receiver reconnected'));
  }

  /** Stop the transfer and tell the peer. `start()` rejects with CANCELLED. */
  cancel(): void {
    void this.#secure.abort(new TransferError(ErrorCode.Cancelled));
  }

  async #sendFile(index: number, from: number): Promise<void> {
    const file = this.#opts.files[index];
    if (!file) throw protocolError(`no file at index ${index}`);
    const { chunkSize, maxUnackedBytes } = this.#cfg;
    for (let offset = from; offset < file.size; offset += chunkSize) {
      await this.#secure.drained();
      // Flow-control window (see TransferConfig.maxUnackedBytes)
      while (this.#progress.sent - this.#progress.acked > maxUnackedBytes) {
        if (this.#secure.error) throw this.#secure.error;
        await new Promise<void>((resolve) => {
          this.#ackWaiter = resolve;
        });
      }
      if (this.#secure.error) throw this.#secure.error;
      const end = Math.min(offset + chunkSize, file.size);
      const data = await file.read(offset, end);
      if (data.byteLength !== end - offset) {
        throw new TransferError(ErrorCode.ProtocolError, `${file.path} changed while sending`);
      }
      await this.#secure.send(FrameType.Chunk, encodeChunk(index, offset, data));
      this.#progress.sent += data.byteLength;
      this.emit('progress', { ...this.#progress });
    }
    await this.#secure.send(FrameType.FileEnd, encodePosition(index, file.size));
  }

  /** Background reader during the transfer: ACKs, then the receiver's DONE. */
  async #readReplies(accept: Accept, sentAll: () => boolean): Promise<void> {
    const ackedPerFile = new Map<number, number>(accept.files.map((i) => [i, accept.resume?.[i] ?? 0]));
    const wake = () => {
      const w = this.#ackWaiter;
      this.#ackWaiter = undefined;
      w?.();
    };
    try {
      for (;;) {
        const frame = await this.#secure.next();
        if (frame.type === FrameType.Done) {
          if (!sentAll()) throw protocolError('receiver sent DONE before the transfer finished');
          return;
        }
        if (frame.type !== FrameType.Ack) throw terminalFrameError(frame) ?? unexpectedFrame(frame, 'ACK');

        const { fileIdx, value } = decodePosition(frame.payload);
        const prev = ackedPerFile.get(fileIdx);
        const size = this.#opts.files[fileIdx]?.size;
        if (prev === undefined || size === undefined || value < prev || value > size) {
          throw protocolError('invalid ACK');
        }
        ackedPerFile.set(fileIdx, value);
        this.#progress.acked += value - prev;
        if (this.#progress.acked > this.#progress.sent) throw protocolError('ACK beyond sent data');
        this.emit('progress', { ...this.#progress });
        wake();
      }
    } finally {
      wake();
    }
  }
}
