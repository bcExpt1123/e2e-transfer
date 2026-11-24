/**
 * CPace over ristretto255 with SHA-512, following draft-irtf-cfrg-cpace-21
 * (initiator-responder mode). Test vectors: packages/core/test/cpace.test.ts (draft §B.3).
 */
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { type Bytes, concat, utf8 } from '../bytes.ts';

const Point = ristretto255.Point;
export const CPACE_DSI = utf8('CPaceRistretto255');
const DSI_ISK = utf8('CPaceRistretto255_ISK');
/** SHA-512 input block size. */
const S_IN_BYTES = 128;
const FIELD_SIZE_BYTES = 32;
export const IDENTITY: Bytes = new Uint8Array(32);

/** LEB128 length prefix (draft §6.3). */
export function prependLen(data: Uint8Array): Bytes {
  const len: number[] = [];
  let n = data.length;
  for (;;) {
    if (n < 128) {
      len.push(n);
      break;
    }
    len.push((n & 0x7f) | 0x80);
    n = n >>> 7;
  }
  return concat(Uint8Array.from(len), data);
}

export const lvCat = (...parts: Uint8Array[]): Bytes => concat(...parts.map(prependLen));

export function generatorString(dsi: Bytes, prs: Bytes, ci: Bytes, sid: Bytes, sInBytes = S_IN_BYTES): Bytes {
  const zpad = Math.max(0, sInBytes - 1 - prependLen(prs).length - prependLen(dsi).length);
  return lvCat(dsi, prs, new Uint8Array(zpad), ci, sid);
}

async function sha512(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-512', data));
}

export async function calculateGenerator(prs: Bytes, ci: Bytes, sid: Bytes) {
  const hash = await sha512(generatorString(CPACE_DSI, prs, ci, sid));
  // RFC 9496 §4.3.4 element derivation from 2 * field_size_bytes uniform bytes
  return ristretto255_hasher.deriveToCurve?.(hash.subarray(0, 2 * FIELD_SIZE_BYTES)) as InstanceType<
    typeof Point
  >;
}

/** Little-endian bytes → integer. */
export function scalarFromBytes(le: Uint8Array): bigint {
  let n = 0n;
  for (let i = le.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(le[i] ?? 0);
  return n;
}

/** Random scalar below 2^252 (draft §8.3: clear bits above group_size_bits), never zero. */
export function sampleScalar(): bigint {
  for (;;) {
    const b = crypto.getRandomValues(new Uint8Array(32));
    b[31] = (b[31] ?? 0) & 0x0f;
    const s = scalarFromBytes(b);
    if (s !== 0n) return s;
  }
}

export function scalarMult(y: bigint, g: InstanceType<typeof Point>): Bytes {
  return g.multiply(y).toBytes() as Bytes;
}

/** Decode X and multiply; invalid encodings and the identity yield IDENTITY (draft §8.3). */
export function scalarMultVfy(y: bigint, x: Uint8Array): Bytes {
  let p: InstanceType<typeof Point>;
  try {
    p = Point.fromBytes(x);
  } catch {
    return IDENTITY;
  }
  if (p.is0()) return IDENTITY;
  const k = p.multiply(y);
  return k.is0() ? IDENTITY : (k.toBytes() as Bytes);
}

export const isIdentity = (k: Uint8Array): boolean => k.every((b) => b === 0);

export const transcriptIr = (ya: Bytes, ada: Bytes, yb: Bytes, adb: Bytes): Bytes =>
  concat(lvCat(ya, ada), lvCat(yb, adb));

/** o_cat: "oc" ‖ larger ‖ smaller (lexicographic). */
export function transcriptOc(ya: Bytes, ada: Bytes, yb: Bytes, adb: Bytes): Bytes {
  const a = lvCat(ya, ada);
  const b = lvCat(yb, adb);
  return concat(utf8('oc'), ...(lexLarger(a, b) ? [a, b] : [b, a]));
}

function lexLarger(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return a.length > b.length;
}

export const iskFromTranscript = (sid: Bytes, k: Bytes, transcript: Bytes): Promise<Bytes> =>
  sha512(concat(lvCat(DSI_ISK, sid, k), transcript));

export const sidOutput = (transcript: Bytes): Promise<Bytes> =>
  sha512(concat(utf8('CPaceSidOutput'), transcript));
