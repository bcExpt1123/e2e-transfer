/** Sending side of a transfer (docs/PROTOCOL.md §4.4). */
import { resolveConfig, type TransferConfig } from '../config.ts';
import { Emitter } from '../emitter.ts';
import { ErrorCode, TransferError } from '../errors.ts';
import {
  decodeJson,
  decodePosition,
  encodeChunk,
  encodeJson,
  encodePosition,
  FrameType,
  protocolError,
} from '../protocol/frames.ts';
import { type Manifest, validateAccept } from '../protocol/manifest.ts';
import type { MessageChannelLike } from '../transport/channel.ts';
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
}

export class Sender extends Emitter<SenderEvents> {
  readonly #cfg: TransferConfig;
  readonly #secure: SecureChannel;
  readonly #opts: SenderOptions;
  #progress: SenderProgress = { sent: 0, acked: 0, total: 0 };
  #ackWaiter: (() => void) | undefined;

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
    try {
      this.emit('phase', 'handshaking');
      await secure.handshake(this.#opts.sessionIkm);
      this.emit('phase', 'connected');
      if (this.#opts.confirmPeer) {
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

      const total = accept.files.reduce((n, i) => n + (manifest.files[i]?.size ?? 0), 0);
      this.#progress = { sent: 0, acked: 0, total };
      this.emit('phase', 'transferring');
      this.emit('progress', { ...this.#progress });

      let sentAll = false;
      const peerDone = this.#readReplies(accept.files, () => sentAll);
      // A peer CANCEL/ERROR (or a bad ACK) must also stop the send loop below.
      peerDone.catch((err) => void secure.abort(err));

      for (const index of accept.files) await this.#sendFile(index);
      sentAll = true;
      this.emit('phase', 'finishing');
      await secure.send(FrameType.Done);
      await peerDone;

      secure.finish();
      this.emit('phase', 'done');
    } catch (err) {
      const error = await secure.abort(err);
      this.emit('phase', phaseForError(error));
      throw error;
    }
  }

  /** Stop the transfer and tell the peer. `start()` rejects with CANCELLED. */
  cancel(): void {
    void this.#secure.abort(new TransferError(ErrorCode.Cancelled));
  }

  async #sendFile(index: number): Promise<void> {
    const file = this.#opts.files[index];
    if (!file) throw protocolError(`no file at index ${index}`);
    const { chunkSize, maxUnackedBytes } = this.#cfg;
    for (let offset = 0; offset < file.size; offset += chunkSize) {
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
  async #readReplies(accepted: readonly number[], sentAll: () => boolean): Promise<void> {
    const ackedPerFile = new Map<number, number>(accepted.map((i) => [i, 0]));
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
