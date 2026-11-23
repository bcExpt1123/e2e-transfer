/**
 * Per-direction frame encryption (docs/PROTOCOL.md §4.2).
 * AES-256-GCM, nonce = counter, AAD = header. The receiving side requires
 * counter == expected, which rejects drops, reordering, replays and duplicates.
 */
import { type Bytes, concat } from '../bytes.ts';
import {
  decodeHeader,
  encodeHeader,
  type FrameType,
  GCM_TAG_BYTES,
  HEADER_BYTES,
  isFrameType,
  nonceFor,
  protocolError,
} from './frames.ts';

export interface Frame {
  type: FrameType;
  payload: Bytes;
}

export class FrameCipher {
  #counter = 0;

  constructor(
    private readonly key: CryptoKey,
    private readonly maxFrameSize: number,
  ) {}

  /** Must be called sequentially in send order (the counter is part of the frame). */
  async seal(type: FrameType, payload: Bytes): Promise<Bytes> {
    const counter = this.#counter++;
    const header = encodeHeader(type, counter);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonceFor(counter), additionalData: header },
      this.key,
      payload,
    );
    const frame = concat(header, new Uint8Array(ct));
    if (frame.byteLength > this.maxFrameSize) throw protocolError('outgoing frame exceeds maxFrameSize');
    return frame;
  }

  /** Must be called sequentially in arrival order. Any failure is fatal for the session. */
  async open(frame: Bytes): Promise<Frame> {
    if (frame.byteLength < HEADER_BYTES + GCM_TAG_BYTES) throw protocolError('frame too short');
    if (frame.byteLength > this.maxFrameSize) throw protocolError('frame exceeds maxFrameSize');

    const header = decodeHeader(frame);
    if (header.flags !== 0 || header.reserved !== 0) throw protocolError('unsupported header flags');
    if (header.counter !== this.#counter) {
      throw protocolError(`unexpected frame counter ${header.counter}, expected ${this.#counter}`);
    }
    if (!isFrameType(header.type)) throw protocolError(`unknown frame type 0x${header.type.toString(16)}`);
    this.#counter++;

    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonceFor(header.counter), additionalData: frame.subarray(0, HEADER_BYTES) },
        this.key,
        frame.subarray(HEADER_BYTES),
      );
    } catch (cause) {
      throw protocolError('frame authentication failed', cause);
    }
    return { type: header.type, payload: new Uint8Array(plain) };
  }
}
