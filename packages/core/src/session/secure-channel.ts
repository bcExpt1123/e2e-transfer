/**
 * Wraps a MessageChannelLike with the HELLO handshake and per-frame AEAD
 * (docs/PROTOCOL.md §4). Frames are decrypted strictly in arrival order and
 * handed out through `next()`. Any failure is fatal and closes the channel.
 */
import { type Bytes, randomBytes } from '../bytes.ts';
import { PROTOCOL_VERSION, type TransferConfig } from '../config.ts';
import { ErrorCode, TransferError, toTransferError } from '../errors.ts';
import { deriveSessionKeys, HELLO_NONCE_BYTES } from '../keys.ts';
import { type Frame, FrameCipher } from '../protocol/cipher.ts';
import {
  decodeHello,
  decodeJson,
  encodeHello,
  encodeJson,
  FrameType,
  type Hello,
  protocolError,
  type Role,
} from '../protocol/frames.ts';
import type { MessageChannelLike } from '../transport/channel.ts';

export class SecureChannel {
  readonly #ch: MessageChannelLike;
  readonly #role: Role;
  readonly #cfg: TransferConfig;

  #tx?: FrameCipher;
  #rx?: FrameCipher;
  #peerHello = Promise.withResolvers<Hello>();
  #keysReady = Promise.withResolvers<void>();
  #gotHello = false;
  #rxChain: Promise<void> = Promise.resolve();
  #txChain: Promise<void> = Promise.resolve();

  #frames: Frame[] = [];
  #waiters: { resolve: (f: Frame) => void; reject: (e: unknown) => void }[] = [];
  #error?: TransferError;
  #finished = false;
  #unsubscribe: (() => void)[] = [];

  constructor(channel: MessageChannelLike, role: Role, cfg: TransferConfig) {
    this.#ch = channel;
    this.#role = role;
    this.#cfg = cfg;
    channel.bufferedAmountLowThreshold = cfg.bufferedAmountLow;
    // Avoid unhandled-rejection noise; failures surface through handshake()/next().
    this.#peerHello.promise.catch(() => {});
    this.#keysReady.promise.catch(() => {});

    this.#unsubscribe.push(
      channel.onMessage((data) => {
        this.#rxChain = this.#rxChain
          .then(() => this.#receive(data))
          .catch((err) => {
            this.#fail(err);
          });
      }),
      // Queued behind pending frames: a peer that sends DONE/REJECT/CANCEL and then
      // closes must be seen as doing exactly that, not as a lost connection.
      channel.onClose(() => {
        this.#rxChain = this.#rxChain.then(() => {
          if (!this.#finished) this.#fail(new TransferError(ErrorCode.ConnectionLost, 'channel closed'));
        });
      }),
    );
  }

  get error(): TransferError | undefined {
    return this.#error;
  }

  async handshake(sessionIkm: CryptoKey): Promise<void> {
    const nonce = randomBytes(HELLO_NONCE_BYTES);
    this.#ch.send(encodeHello({ version: PROTOCOL_VERSION, role: this.#role, nonce }));
    const peer = await this.#peerHello.promise;
    if (peer.version !== PROTOCOL_VERSION) {
      throw this.#fail(
        new TransferError(
          ErrorCode.VersionMismatch,
          `peer speaks v${peer.version}, we speak v${PROTOCOL_VERSION}`,
        ),
      );
    }
    if (peer.role === this.#role) throw this.#fail(protocolError(`both peers claim role ${peer.role}`));

    const [nonceS, nonceR] = this.#role === 'sender' ? [nonce, peer.nonce] : [peer.nonce, nonce];
    const keys = await deriveSessionKeys(sessionIkm, nonceS, nonceR);
    const [txKey, rxKey] = this.#role === 'sender' ? [keys.s2r, keys.r2s] : [keys.r2s, keys.s2r];
    this.#tx = new FrameCipher(txKey, this.#cfg.maxFrameSize);
    this.#rx = new FrameCipher(rxKey, this.#cfg.maxFrameSize);
    this.#keysReady.resolve();
  }

  async #receive(data: Bytes): Promise<void> {
    if (this.#error) return;
    if (!this.#gotHello) {
      this.#gotHello = true;
      this.#peerHello.resolve(decodeHello(data));
      return;
    }
    await this.#keysReady.promise;
    const frame = await (this.#rx as FrameCipher).open(data);
    // CANCEL/ERROR end the session immediately, even if the engine is busy (e.g. writing):
    // frames already queued are still handed out, then next()/send() report the peer's reason.
    const terminal = terminalFrameError(frame);
    if (terminal) {
      this.#fail(terminal);
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve(frame);
    else this.#frames.push(frame);
  }

  /** Next decrypted frame. Rejects with the session error once the channel has failed. */
  next(): Promise<Frame> {
    const frame = this.#frames.shift();
    if (frame) return Promise.resolve(frame);
    if (this.#error) return Promise.reject(this.#error);
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  /** Encrypt and send. Calls are serialised so counters match send order. */
  send(type: FrameType, payload: Bytes = new Uint8Array(0)): Promise<void> {
    return this.#enqueue(type, payload, false);
  }

  #enqueue(type: FrameType, payload: Bytes, evenAfterError: boolean): Promise<void> {
    const p = this.#txChain.then(async () => {
      if (this.#error && !evenAfterError) throw this.#error;
      if (!this.#tx) throw protocolError('send before handshake');
      if (this.#ch.closed) throw await this.#closedReason();
      const frame = await this.#tx.seal(type, payload);
      try {
        this.#ch.send(frame);
      } catch {
        throw await this.#closedReason(); // closed while we were encrypting
      }
    });
    this.#txChain = p.catch(() => {});
    return p;
  }

  /** Resolves once bufferedAmount is at or below the low watermark (if it was above the high one). */
  drained(): Promise<void> {
    if (this.#ch.bufferedAmount <= this.#cfg.bufferedAmountHigh) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const offLow = this.#ch.onBufferedAmountLow(() => {
        cleanup();
        resolve();
      });
      const offClose = this.#ch.onClose(() => {
        cleanup();
        this.#closedReason().then(reject);
      });
      const cleanup = () => {
        offLow();
        offClose();
      };
    });
  }

  /** Normal end of session: close without treating the close as an error. */
  finish(): void {
    this.#finished = true;
    this.#teardown();
  }

  /**
   * Fatal end of session. Tells the peer (ERROR or CANCEL) when possible, then closes.
   * Returns the normalised error so callers can `throw await channel.abort(err)`.
   */
  async abort(err: unknown): Promise<TransferError> {
    // The first recorded error wins (e.g. a decrypt failure that made the engine abort).
    const error = this.#fail(err);
    const fromPeer = (error as TransferError & { fromPeer?: boolean }).fromPeer === true;
    if (
      !this.#finished &&
      !this.#ch.closed &&
      this.#tx &&
      !fromPeer &&
      error.code !== ErrorCode.ConnectionLost
    ) {
      const payload =
        error.code === ErrorCode.Cancelled
          ? encodeJson({})
          : encodeJson({ code: error.code, message: error.message });
      const type = error.code === ErrorCode.Cancelled ? FrameType.Cancel : FrameType.Error;
      await this.#enqueue(type, payload, true).catch(() => {});
    }
    this.#finished = true;
    this.#teardown();
    return error;
  }

  /**
   * Why the channel is closed. Frames that arrived before the close (often the
   * peer's ERROR or CANCEL) are processed first, so the peer's reason wins.
   * Only used after the handshake, when the receive chain cannot be blocked.
   */
  async #closedReason(): Promise<TransferError> {
    await this.#rxChain;
    return this.#error ?? new TransferError(ErrorCode.ConnectionLost, 'channel closed');
  }

  /** Record the session error and wake everyone waiting. Does not close: abort() does that. */
  #fail(err: unknown): TransferError {
    if (this.#error) return this.#error;
    const error = toTransferError(err);
    this.#error = error;
    this.#peerHello.reject(error);
    this.#keysReady.reject(error);
    for (const w of this.#waiters.splice(0)) w.reject(error);
    return error;
  }

  #teardown() {
    for (const off of this.#unsubscribe.splice(0)) off();
    if (!this.#ch.closed) this.#ch.close();
  }
}

/** Mark an error as reported by the peer, so we don't echo it back. */
export function peerError(code: ErrorCode, message?: string): TransferError {
  return Object.assign(new TransferError(code, message ?? `peer reported ${code}`), { fromPeer: true });
}

const KNOWN_CODES = new Set<string>(Object.values(ErrorCode));

/**
 * For frames either side may send at any time (CANCEL, ERROR): returns the
 * error to throw, or null if the frame is something else.
 */
export function terminalFrameError(frame: Frame): TransferError | null {
  if (frame.type === FrameType.Cancel) return peerError(ErrorCode.Cancelled, 'peer cancelled');
  if (frame.type !== FrameType.Error) return null;
  let code: ErrorCode = ErrorCode.ProtocolError;
  let message: string | undefined;
  try {
    const body = decodeJson(frame.payload) as { code?: unknown; message?: unknown };
    if (typeof body.code === 'string' && KNOWN_CODES.has(body.code)) code = body.code as ErrorCode;
    if (typeof body.message === 'string') message = `peer: ${body.message.slice(0, 200)}`;
  } catch {
    // malformed ERROR payload: still an error
  }
  return peerError(code, message);
}

export function unexpectedFrame(frame: Frame, expected: string): TransferError {
  return (
    terminalFrameError(frame) ??
    protocolError(`unexpected frame 0x${frame.type.toString(16)}, expected ${expected}`)
  );
}
