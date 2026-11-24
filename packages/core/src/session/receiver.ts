/** Receiving side of a transfer (docs/PROTOCOL.md §4.4). */
import { resolveConfig, type TransferConfig } from '../config.ts';
import { Emitter } from '../emitter.ts';
import { ErrorCode, TransferError } from '../errors.ts';
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
import { type Manifest, validateAccept, validateManifest } from '../protocol/manifest.ts';
import type { MessageChannelLike } from '../transport/channel.ts';
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
  progress: ReceiverProgress;
};

/** What the user decided after reviewing the manifest. `null` declines. */
export type AcceptDecision = { sink: FileSink; files?: number[] } | null;

export interface ReceiverOptions {
  sessionIkm: CryptoKey;
  config?: Partial<TransferConfig>;
  /** Called once with the validated manifest; typically shows the review screen. */
  onManifest: (manifest: Manifest) => AcceptDecision | Promise<AcceptDecision>;
}

export type ReceiveOutcome = 'completed' | 'declined';

export class Receiver extends Emitter<ReceiverEvents> {
  readonly #cfg: TransferConfig;
  readonly #secure: SecureChannel;
  readonly #opts: ReceiverOptions;
  #writer: SinkWriter | undefined;

  constructor(channel: MessageChannelLike, opts: ReceiverOptions) {
    super();
    this.#cfg = resolveConfig(opts.config);
    this.#opts = opts;
    this.#secure = new SecureChannel(channel, 'receiver', this.#cfg);
  }

  async start(): Promise<ReceiveOutcome> {
    const secure = this.#secure;
    try {
      this.emit('phase', 'handshaking');
      await secure.handshake(this.#opts.sessionIkm);
      this.emit('phase', 'connected');

      const first = await secure.next();
      if (first.type !== FrameType.Manifest) throw unexpectedFrame(first, 'MANIFEST');
      const manifest = validateManifest(decodeJson(first.payload), this.#cfg);

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

      const accept = validateAccept({ files: decision.files ?? manifest.files.map((_, i) => i) }, manifest);
      await secure.send(FrameType.Accept, encodeJson(accept));

      const total = accept.files.reduce((n, i) => n + (manifest.files[i]?.size ?? 0), 0);
      const progress: ReceiverProgress = { received: 0, total };
      this.emit('phase', 'transferring');
      this.emit('progress', { ...progress });

      for (const index of accept.files) {
        await this.#receiveFile(index, manifest, decision.sink, (n) => {
          progress.received += n;
          this.emit('progress', { ...progress });
        });
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
      await this.#writer?.abort(err).catch(() => {});
      this.#writer = undefined;
      const error = await secure.abort(err);
      this.emit('phase', phaseForError(error));
      throw error;
    }
  }

  /** Stop the transfer and tell the peer. `start()` rejects with CANCELLED. */
  cancel(): void {
    void this.#secure.abort(new TransferError(ErrorCode.Cancelled));
  }

  async #receiveFile(index: number, manifest: Manifest, sink: FileSink, onBytes: (n: number) => void) {
    const meta = manifest.files[index];
    if (!meta) throw protocolError(`no file at index ${index}`);
    this.#writer = await sinkCall(() => sink.open(meta));
    let written = 0;
    let sinceAck = 0;

    for (;;) {
      const frame: Frame = await this.#secure.next();

      if (frame.type === FrameType.Chunk) {
        const { fileIdx, offset, data } = decodeChunk(frame.payload);
        if (fileIdx !== index) throw protocolError(`CHUNK for file ${fileIdx} while receiving ${index}`);
        if (offset !== written) throw protocolError(`CHUNK at offset ${offset}, expected ${written}`);
        if (data.byteLength === 0 || data.byteLength > manifest.chunkSize)
          throw protocolError('bad CHUNK size');
        if (written + data.byteLength > meta.size) throw protocolError('CHUNK beyond declared file size');

        const writer = this.#writer;
        await sinkCall(() => writer.write(data, offset));
        written += data.byteLength;
        sinceAck += data.byteLength;
        onBytes(data.byteLength);
        if (sinceAck >= this.#cfg.ackInterval) {
          sinceAck = 0;
          await this.#secure.send(FrameType.Ack, encodePosition(index, written));
        }
        continue;
      }

      if (frame.type === FrameType.FileEnd) {
        const { fileIdx, value } = decodePosition(frame.payload);
        if (fileIdx !== index || value !== meta.size || written !== meta.size) {
          throw protocolError('FILE_END does not match received data');
        }
        const writer = this.#writer;
        await sinkCall(() => writer.close());
        this.#writer = undefined;
        await this.#secure.send(FrameType.Ack, encodePosition(index, written));
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
