/** Receiving side of a transfer (docs/PROTOCOL.md §4.4). */
import { resolveConfig, type TransferConfig } from '../config.ts';
import { Emitter } from '../emitter.ts';
import { ErrorCode, TransferError } from '../errors.ts';
import type { ResumeTicket } from '../keys.ts';
import type { FileSink, SinkWriter } from '../ports/storage.ts';
import type { Frame } from '../protocol/cipher.ts';
import {
  decodeChunk,
  decodeJson,
  decodePosition,
  encodeJson,
  encodePosition,
  FrameType,
  protocolError,
} from '../protocol/frames.ts';
import {
  type Accept,
  type Manifest,
  sameManifest,
  validateAccept,
  validateManifest,
} from '../protocol/manifest.ts';
import type { MessageChannelLike } from '../transport/channel.ts';
import { canResumeAfter } from './resume.ts';
import { SecureChannel, unexpectedFrame } from './secure-channel.ts';
import { phaseForError, type TransferPhase } from './types.ts';

export interface ReceiverProgress {
  /** Bytes written to the sink. */
  received: number;
  /** Total bytes of the accepted files. */
  total: number;
}

export type ReceiverEvents = {
  phase: TransferPhase;
  /** Verification words to show while the sender decides (emitted before 'connected'). */
  words: readonly string[];
  progress: ReceiverProgress;
};

/** What the user decided after reviewing the manifest. `null` declines. */
export type AcceptDecision = { sink: FileSink; files?: number[] } | null;

/** What a receiver keeps to continue an interrupted transfer (PROTOCOL §4.6). */
export interface ReceiverResume {
  ticket: ResumeTicket;
  manifest: Manifest;
  sink: FileSink;
  /** Files still to receive, in order. The first one may be partly written (`partial`). */
  files: readonly number[];
  partial?: { index: number; writer: SinkWriter; written: number };
  received: number;
  total: number;
}

/** Give up on a resume: abort the partly written file. */
export async function discardResume(resume: ReceiverResume | undefined): Promise<void> {
  await resume?.partial?.writer.abort(new TransferError(ErrorCode.ConnectionLost)).catch(() => {});
}

export interface ReceiverOptions {
  sessionIkm: CryptoKey;
  config?: Partial<TransferConfig>;
  /** Called once with the validated manifest; typically shows the review screen. */
  onManifest: (manifest: Manifest) => AcceptDecision | Promise<AcceptDecision>;
  /**
   * Keep the partly written file open after a lost connection so the transfer can be
   * resumed (see `resumeState()`; call `discardResume()` when giving up).
   */
  resumable?: boolean;
  /** Continue an interrupted transfer instead of asking the user again. */
  resume?: ReceiverResume;
}

export type ReceiveOutcome = 'completed' | 'declined';

export class Receiver extends Emitter<ReceiverEvents> {
  readonly #cfg: TransferConfig;
  readonly #secure: SecureChannel;
  readonly #opts: ReceiverOptions;
  /** The file being written right now. */
  #current: { index: number; writer: SinkWriter; written: number } | undefined;
  #state: { manifest: Manifest; sink: FileSink; remaining: number[]; progress: ReceiverProgress } | undefined;
  #accepted = false;
  #resumeState: ReceiverResume | undefined;

  constructor(channel: MessageChannelLike, opts: ReceiverOptions) {
    super();
    this.#cfg = resolveConfig(opts.config);
    this.#opts = opts;
    this.#secure = new SecureChannel(channel, 'receiver', this.#cfg);
  }

  async start(): Promise<ReceiveOutcome> {
    const secure = this.#secure;
    const resume = this.#opts.resume;
    if (resume) {
      this.#current = resume.partial && { ...resume.partial };
      this.#state = {
        manifest: resume.manifest,
        sink: resume.sink,
        remaining: [...resume.files],
        progress: { received: resume.received, total: resume.total },
      };
    }
    try {
      this.emit('phase', 'handshaking');
      await secure.handshake(resume ? resume.ticket.ikm : this.#opts.sessionIkm);
      if (!resume) this.emit('words', secure.words);
      this.emit('phase', 'connected');

      const first = await secure.next();
      if (first.type !== FrameType.Manifest) throw unexpectedFrame(first, 'MANIFEST');
      const manifest = validateManifest(decodeJson(first.payload), this.#cfg);

      let accept: Accept;
      if (resume) {
        if (!sameManifest(manifest, resume.manifest))
          throw protocolError('different files offered on resume');
        accept = { files: [...resume.files] };
        if (this.#current) accept.resume = { [this.#current.index]: this.#current.written };
      } else {
        this.emit('phase', 'reviewing');
        const decision = await this.#opts.onManifest(manifest);
        if (secure.error) throw secure.error;
        if (!decision) {
          await secure.send(FrameType.Reject, encodeJson({}));
          await secure.peerClosed(this.#cfg.closeGraceMs); // let REJECT arrive before tearing down
          secure.finish();
          this.emit('phase', 'declined');
          return 'declined';
        }
        accept = validateAccept({ files: decision.files ?? manifest.files.map((_, i) => i) }, manifest);
        const total = accept.files.reduce((n, i) => n + (manifest.files[i]?.size ?? 0), 0);
        this.#state = {
          manifest,
          sink: decision.sink,
          remaining: [...accept.files],
          progress: { received: 0, total },
        };
      }
      await secure.send(FrameType.Accept, encodeJson(accept));
      this.#accepted = true;

      const state = this.#state;
      if (!state) throw protocolError('no transfer state');
      this.emit('phase', 'transferring');
      this.emit('progress', { ...state.progress });

      while (state.remaining.length > 0) {
        await this.#receiveFile(state.remaining[0] ?? -1, state.manifest, state.sink, (n) => {
          state.progress.received += n;
          this.emit('progress', { ...state.progress });
        });
        state.remaining.shift();
      }

      const last = await secure.next();
      if (last.type !== FrameType.Done) throw unexpectedFrame(last, 'DONE');
      this.emit('phase', 'finishing');
      await secure.send(FrameType.Done);
      // Our DONE must reach the sender before the connection is torn down: let it close first.
      await secure.peerClosed(this.#cfg.closeGraceMs);
      secure.finish();
      this.emit('phase', 'done');
      return 'completed';
    } catch (err) {
      const error = await secure.abort(err);
      const ticket = this.#accepted ? secure.ticket : resume?.ticket;
      const state = this.#state;
      if (
        this.#opts.resumable &&
        ticket &&
        state &&
        canResumeAfter(error, resume !== undefined && !this.#accepted)
      ) {
        // Keep the open file: a new connection continues writing where this one stopped.
        this.#resumeState = {
          ticket,
          manifest: state.manifest,
          sink: state.sink,
          files: [...state.remaining],
          ...(this.#current && { partial: this.#current }),
          received: state.progress.received,
          total: state.progress.total,
        };
      } else {
        await this.#current?.writer.abort(err).catch(() => {});
      }
      this.#current = undefined;
      this.emit('phase', phaseForError(error));
      throw error;
    }
  }

  /** After `start()` rejected: how to continue on a new connection, or undefined if the transfer is over. */
  resumeState(): ReceiverResume | undefined {
    return this.#resumeState;
  }

  /** Stop the transfer and tell the peer. `start()` rejects with CANCELLED. */
  cancel(): void {
    void this.#secure.abort(new TransferError(ErrorCode.Cancelled));
  }

  async #receiveFile(index: number, manifest: Manifest, sink: FileSink, onBytes: (n: number) => void) {
    const meta = manifest.files[index];
    if (!meta) throw protocolError(`no file at index ${index}`);
    // A resumed file continues in the writer the previous connection left open.
    if (this.#current?.index !== index) {
      this.#current = { index, writer: await sinkCall(() => sink.open(meta)), written: 0 };
    }
    const current = this.#current;
    let sinceAck = 0;

    for (;;) {
      const frame: Frame = await this.#secure.next();

      if (frame.type === FrameType.Chunk) {
        const { fileIdx, offset, data } = decodeChunk(frame.payload);
        if (fileIdx !== index) throw protocolError(`CHUNK for file ${fileIdx} while receiving ${index}`);
        if (offset !== current.written)
          throw protocolError(`CHUNK at offset ${offset}, expected ${current.written}`);
        if (data.byteLength === 0 || data.byteLength > manifest.chunkSize)
          throw protocolError('bad CHUNK size');
        if (current.written + data.byteLength > meta.size)
          throw protocolError('CHUNK beyond declared file size');

        await sinkCall(() => current.writer.write(data, offset));
        current.written += data.byteLength;
        sinceAck += data.byteLength;
        onBytes(data.byteLength);
        if (sinceAck >= this.#cfg.ackInterval) {
          sinceAck = 0;
          await this.#secure.send(FrameType.Ack, encodePosition(index, current.written));
        }
        continue;
      }

      if (frame.type === FrameType.FileEnd) {
        const { fileIdx, value } = decodePosition(frame.payload);
        if (fileIdx !== index || value !== meta.size || current.written !== meta.size) {
          throw protocolError('FILE_END does not match received data');
        }
        await sinkCall(() => current.writer.close());
        this.#current = undefined;
        await this.#secure.send(FrameType.Ack, encodePosition(index, current.written));
        return;
      }

      throw unexpectedFrame(frame, 'CHUNK or FILE_END');
    }
  }
}

/** Map storage failures to user-meaningful codes. */
async function sinkCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      throw new TransferError(ErrorCode.StorageQuota, 'storage quota exceeded', { cause: err });
    }
    throw err;
  }
}
