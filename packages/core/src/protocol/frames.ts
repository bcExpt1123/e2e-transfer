/** Wire layout from docs/PROTOCOL.md §4. All integers big-endian. */
import { type Bytes, concat, fromUtf8, utf8 } from '../bytes.ts';
import { ErrorCode, TransferError } from '../errors.ts';
import { HELLO_NONCE_BYTES } from '../keys.ts';

export const FrameType = {
  Manifest: 0x02,
  Accept: 0x03,
  Reject: 0x04,
  Chunk: 0x10,
  FileEnd: 0x11,
  Ack: 0x12,
  Done: 0x20,
  Cancel: 0x7e,
  Error: 0x7f,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

const KNOWN_TYPES = new Set<number>(Object.values(FrameType));
export const isFrameType = (n: number): n is FrameType => KNOWN_TYPES.has(n);

export const HEADER_BYTES = 12;
export const GCM_TAG_BYTES = 16;
export const CHUNK_PREFIX_BYTES = 12;

export const protocolError = (message: string, cause?: unknown) =>
  new TransferError(ErrorCode.ProtocolError, message, cause === undefined ? undefined : { cause });

// ── HELLO (§4.1) ────────────────────────────────────────────────────────────

const MAGIC = utf8('E2ET');
export const HELLO_BYTES = MAGIC.byteLength + 2 + HELLO_NONCE_BYTES;

export type Role = 'sender' | 'receiver';

export interface Hello {
  version: number;
  role: Role;
  nonce: Bytes;
}

export function encodeHello({ version, role, nonce }: Hello): Bytes {
  return concat(MAGIC, Uint8Array.of(version, role === 'sender' ? 0 : 1), nonce);
}

export function decodeHello(b: Bytes): Hello {
  if (b.byteLength !== HELLO_BYTES || MAGIC.some((x, i) => b[i] !== x))
    throw protocolError('malformed HELLO');
  const version = b[4] ?? 0;
  const roleByte = b[5];
  if (roleByte !== 0 && roleByte !== 1) throw protocolError('invalid HELLO role');
  return { version, role: roleByte === 0 ? 'sender' : 'receiver', nonce: b.slice(6) };
}

// ── Frame header (§4.2) ─────────────────────────────────────────────────────

export interface FrameHeader {
  type: number;
  flags: number;
  reserved: number;
  counter: number;
}

export function encodeHeader(type: FrameType, counter: number): Bytes {
  const h = new Uint8Array(HEADER_BYTES);
  const dv = new DataView(h.buffer);
  dv.setUint8(0, type);
  dv.setBigUint64(4, BigInt(counter));
  return h;
}

export function decodeHeader(frame: Bytes): FrameHeader {
  const dv = new DataView(frame.buffer, frame.byteOffset, HEADER_BYTES);
  return {
    type: dv.getUint8(0),
    flags: dv.getUint8(1),
    reserved: dv.getUint16(2),
    counter: Number(dv.getBigUint64(4)),
  };
}

/** 96-bit GCM nonce = 0x00000000 ‖ counter u64. */
export function nonceFor(counter: number): Bytes {
  const n = new Uint8Array(12);
  new DataView(n.buffer).setBigUint64(4, BigInt(counter));
  return n;
}

// ── Payload codecs (§4.3) ───────────────────────────────────────────────────

export function encodeJson(value: unknown): Bytes {
  return utf8(JSON.stringify(value));
}

export function decodeJson(b: Bytes): unknown {
  try {
    return JSON.parse(fromUtf8(b));
  } catch (cause) {
    throw protocolError('invalid JSON payload', cause);
  }
}

/** CHUNK: fileIdx u32 ‖ offset u64 ‖ bytes */
export function encodeChunk(fileIdx: number, offset: number, data: Uint8Array): Bytes {
  const out = new Uint8Array(CHUNK_PREFIX_BYTES + data.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, fileIdx);
  dv.setBigUint64(4, BigInt(offset));
  out.set(data, CHUNK_PREFIX_BYTES);
  return out;
}

export function decodeChunk(b: Bytes): { fileIdx: number; offset: number; data: Bytes } {
  if (b.byteLength < CHUNK_PREFIX_BYTES) throw protocolError('CHUNK too short');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    fileIdx: dv.getUint32(0),
    offset: Number(dv.getBigUint64(4)),
    data: b.subarray(CHUNK_PREFIX_BYTES),
  };
}

/** FILE_END and ACK: fileIdx u32 ‖ u64 (size or offset) */
export function encodePosition(fileIdx: number, value: number): Bytes {
  const out = new Uint8Array(12);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, fileIdx);
  dv.setBigUint64(4, BigInt(value));
  return out;
}

export function decodePosition(b: Bytes): { fileIdx: number; value: number } {
  if (b.byteLength !== 12) throw protocolError('bad position payload');
  const dv = new DataView(b.buffer, b.byteOffset, 12);
  return { fileIdx: dv.getUint32(0), value: Number(dv.getBigUint64(4)) };
}
