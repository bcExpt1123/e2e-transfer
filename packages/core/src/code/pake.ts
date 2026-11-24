/**
 * The CPace exchange over a SignalSession on the nameplate topic (docs/PROTOCOL.md §6),
 * with key confirmation so a wrong code fails at once instead of leaving a dead session.
 *
 *   R → *  pake {Y: Yb}                 repeated until answered
 *   S → R  pake {Y: Ya, tag: tagS}
 *   R → S  pake {tag: tagR}
 *
 * A = sender (initiator), B = receiver. S = first 32 bytes of ISK.
 */
import { type Bytes, fromBase64Url, toBase64Url, utf8 } from '../bytes.ts';
import { ErrorCode, TransferError } from '../errors.ts';
import type { SignalMessage, SignalSession } from '../signaling/envelope.ts';
import {
  calculateGenerator,
  isIdentity,
  iskFromTranscript,
  sampleScalar,
  scalarMult,
  scalarMultVfy,
  transcriptIr,
} from './cpace.ts';

const CI = utf8('e2e-transfer/v1');
// No per-session sid is available before the first message; freshness comes from Ya/Yb in the transcript.
const SID = new Uint8Array(0);
const AD_SENDER = utf8('sender');
const AD_RECEIVER = utf8('receiver');

async function confirmKey(isk: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', isk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
const tagFor = async (key: CryptoKey, role: string) =>
  new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(`e2e-transfer/v1/confirm/${role}`)));
const verifyTag = (key: CryptoKey, role: string, tag: Bytes) =>
  crypto.subtle.verify('HMAC', key, tag, utf8(`e2e-transfer/v1/confirm/${role}`));

function bytesField(msg: SignalMessage, field: string, len?: number): Bytes | null {
  const v = msg.d[field];
  if (typeof v !== 'string' || v.length > 200) return null;
  try {
    const b = fromBase64Url(v);
    return len === undefined || b.length === len ? b : null;
  } catch {
    return null;
  }
}

const cancelled = () => new TransferError(ErrorCode.Cancelled, 'cancelled');

/** Waits for the first message matching `pick`, or rejects on abort/timeout. */
function nextMessage<T>(
  signal: SignalSession,
  pick: (m: SignalMessage) => T | null,
  opts: { abort?: AbortSignal | undefined; timeoutMs?: number; onTimeout?: () => TransferError },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const off = signal.on((m) => {
      const v = pick(m);
      if (v !== null) {
        cleanup();
        resolve(v);
      }
    });
    const onAbort = () => {
      cleanup();
      reject(cancelled());
    };
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            cleanup();
            reject(opts.onTimeout?.() ?? new TransferError(ErrorCode.PeerTimeout, 'timeout'));
          }, opts.timeoutMs)
        : undefined;
    function cleanup() {
      off();
      clearTimeout(timer);
      opts.abort?.removeEventListener('abort', onAbort);
    }
    if (opts.abort?.aborted) onAbort();
    else opts.abort?.addEventListener('abort', onAbort);
  });
}

export interface PakeSenderOptions {
  signal: SignalSession;
  password: Bytes;
  /** Wrong codes allowed before giving up (CODE_ATTEMPTS). */
  maxAttempts?: number;
  /** How long to wait for the receiver's confirmation after answering. */
  confirmTimeoutMs?: number;
  abort?: AbortSignal;
  onWrongCode?: (attempt: number) => void;
}

export async function pakeAsSender(o: PakeSenderOptions): Promise<Bytes> {
  const g = await calculateGenerator(o.password, CI, SID);
  const burned = new Set<string>();
  let failures = 0;
  const max = o.maxAttempts ?? 3;
  for (;;) {
    // 1. Someone typed a code: take the first new peer's share.
    const { from, yb } = await nextMessage(
      o.signal,
      (m) => {
        if (m.t !== 'pake' || burned.has(m.from) || m.d.tag !== undefined) return null;
        const y = bytesField(m, 'Y', 32);
        return y ? { from: m.from, yb: y } : null;
      },
      { abort: o.abort },
    );
    burned.add(from);
    const ya = sampleScalar();
    const Ya = scalarMult(ya, g);
    const k = scalarMultVfy(ya, yb);
    let ok = false;
    if (!isIdentity(k)) {
      const isk = await iskFromTranscript(SID, k, transcriptIr(Ya, AD_SENDER, yb, AD_RECEIVER));
      const key = await confirmKey(isk);
      await o.signal.send(
        'pake',
        { Y: toBase64Url(Ya), tag: toBase64Url(await tagFor(key, 'sender')) },
        from,
      );
      // 2. Their confirmation proves they used the same code.
      const tag = await nextMessage(
        o.signal,
        (m) => (m.from === from && m.t === 'pake' ? bytesField(m, 'tag') : null),
        {
          abort: o.abort,
          timeoutMs: o.confirmTimeoutMs ?? 15_000,
          onTimeout: () => new TransferError(ErrorCode.PeerTimeout, 'no confirmation'),
        },
      ).catch((err: unknown) => {
        if (err instanceof TransferError && err.code === ErrorCode.Cancelled) throw err;
        return null;
      });
      ok = tag !== null && (await verifyTag(key, 'receiver', tag));
      if (ok) return isk.slice(0, 32);
    }
    failures++;
    o.onWrongCode?.(failures);
    if (failures >= max) throw new TransferError(ErrorCode.CodeAttempts, `${failures} wrong codes`);
  }
}

export interface PakeReceiverOptions {
  signal: SignalSession;
  password: Bytes;
  /** Resend our share at this interval until the sender answers. */
  intervalMs?: number;
  /** Give up when the sender doesn't answer (PEER_TIMEOUT). */
  timeoutMs?: number;
  abort?: AbortSignal;
}

export async function pakeAsReceiver(o: PakeReceiverOptions): Promise<Bytes> {
  const g = await calculateGenerator(o.password, CI, SID);
  const yb = sampleScalar();
  const Yb = scalarMult(yb, g);
  const announce = () => void o.signal.send('pake', { Y: toBase64Url(Yb) }).catch(() => {});
  announce();
  const interval = setInterval(announce, o.intervalMs ?? 2_000);
  try {
    const reply = await nextMessage(
      o.signal,
      (m) => {
        if (m.t !== 'pake' || m.to === undefined) return null;
        const Ya = bytesField(m, 'Y', 32);
        const tag = bytesField(m, 'tag');
        return Ya && tag ? { from: m.from, Ya, tag } : null;
      },
      { abort: o.abort, timeoutMs: o.timeoutMs ?? 30_000 },
    );
    clearInterval(interval);
    const k = scalarMultVfy(yb, reply.Ya);
    if (isIdentity(k)) throw new TransferError(ErrorCode.CodeInvalid, 'invalid share');
    const isk = await iskFromTranscript(SID, k, transcriptIr(reply.Ya, AD_SENDER, Yb, AD_RECEIVER));
    const key = await confirmKey(isk);
    const ok = await verifyTag(key, 'sender', reply.tag);
    // Always answer, so a sender with a different code learns at once.
    await o.signal.send('pake', { tag: toBase64Url(await tagFor(key, 'receiver')) }, reply.from);
    if (!ok) throw new TransferError(ErrorCode.CodeInvalid, 'code mismatch');
    return isk.slice(0, 32);
  } finally {
    clearInterval(interval);
  }
}
