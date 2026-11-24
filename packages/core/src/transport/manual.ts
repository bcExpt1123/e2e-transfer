/**
 * Manual connect (docs/PROTOCOL.md §3.1): no signaling network at all. The sender's
 * offer travels inside the link; the receiver's answer comes back as a "reply code"
 * the user pastes (or scans). ICE is not trickled: each SDP carries all its candidates.
 * Both codes are encrypted and authenticated with `signalKey`, like signaling envelopes.
 */
import { concat, fromBase64Url, randomBytes, toBase64Url, utf8 } from '../bytes.ts';
import { ErrorCode, TransferError } from '../errors.ts';
import type { MessageChannelLike } from './channel.ts';
import {
  DATA_CHANNEL_LABEL,
  dataChannelAdapter,
  type RtcDataChannelLike,
  type RtcFactory,
  type RtcPeerLike,
} from './rtc.ts';

type Kind = 'offer' | 'answer';
const IV_BYTES = 12;
const MAX_CODE = 16_384;

async function deflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** SDP → compact, encrypted, URL-safe code. */
export async function sealSdp(signalKey: CryptoKey, kind: Kind, sdp: string): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8(`manual/v1/${kind}`) },
    signalKey,
    await deflate(utf8(sdp)),
  );
  return toBase64Url(concat(iv, new Uint8Array(ct)));
}

/** Code → SDP. Throws LINK_INVALID when the code is damaged or belongs to another link. */
export async function openSdp(signalKey: CryptoKey, kind: Kind, code: string): Promise<string> {
  try {
    if (code.length > MAX_CODE) throw new Error('too long');
    const raw = fromBase64Url(code.trim());
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.slice(0, IV_BYTES), additionalData: utf8(`manual/v1/${kind}`) },
      signalKey,
      raw.slice(IV_BYTES),
    );
    const sdp = new TextDecoder().decode(await inflate(new Uint8Array(pt)));
    if (sdp.length === 0 || sdp.length > 100_000) throw new Error('bad sdp');
    return sdp;
  } catch (cause) {
    throw new TransferError(ErrorCode.LinkInvalid, `invalid ${kind} code`, { cause });
  }
}

/** Resolves with the local SDP once ICE gathering completes (or after `timeoutMs`, with what we have). */
function gatheredSdp(pc: RtcPeerLike, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve(pc.localDescription?.sdp ?? '');
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', check);
    check();
  });
}

interface OpenOptions {
  /** Fail with ICE_FAILED if not open this long after the remote description is set. 0 = no limit. */
  timeoutMs: number;
  abort?: AbortSignal | undefined;
}

/** Waits for the DataChannel (ours, or the one the peer opens) and adapts it. */
function channelOpen(
  pc: RtcPeerLike,
  dc: RtcDataChannelLike | null,
  o: OpenOptions,
): Promise<MessageChannelLike> {
  return new Promise((resolve, reject) => {
    const cleanups: (() => void)[] = [];
    const finish = (err: TransferError | null, ch?: MessageChannelLike) => {
      for (const c of cleanups.splice(0)) c();
      if (err) {
        pc.close();
        reject(err);
      } else if (ch) resolve(ch);
    };
    const watch = (channel: RtcDataChannelLike) => {
      channel.binaryType = 'arraybuffer';
      const open = () => finish(null, dataChannelAdapter(channel, pc));
      if (channel.readyState === 'open') queueMicrotask(open);
      else {
        channel.addEventListener('open', open, { once: true });
        cleanups.push(() => channel.removeEventListener('open', open));
      }
    };
    if (dc) watch(dc);
    else {
      const onChannel = (e: Event) => {
        const ch = (e as RTCDataChannelEvent).channel as unknown as RtcDataChannelLike;
        if (ch.label === DATA_CHANNEL_LABEL) watch(ch);
      };
      pc.addEventListener('datachannel', onChannel);
      cleanups.push(() => pc.removeEventListener('datachannel', onChannel));
    }
    const onState = () => {
      if (pc.connectionState === 'failed')
        finish(new TransferError(ErrorCode.IceFailed, 'ICE connection failed'));
    };
    pc.addEventListener('connectionstatechange', onState);
    cleanups.push(() => pc.removeEventListener('connectionstatechange', onState));
    if (o.timeoutMs > 0) {
      const t = setTimeout(
        () => finish(new TransferError(ErrorCode.IceFailed, 'connection timed out')),
        o.timeoutMs,
      );
      cleanups.push(() => clearTimeout(t));
    }
    const onAbort = () => finish(new TransferError(ErrorCode.Cancelled, 'cancelled'));
    if (o.abort?.aborted) onAbort();
    o.abort?.addEventListener('abort', onAbort);
    cleanups.push(() => o.abort?.removeEventListener('abort', onAbort));
  });
}

export interface ManualOptions {
  rtc: RtcFactory;
  iceServers: RTCIceServer[];
  signalKey: CryptoKey;
  /** Max time to gather candidates before using what we have. */
  gatherTimeoutMs?: number;
  connectTimeoutMs?: number;
  abort?: AbortSignal;
}

export interface ManualOffer {
  /** Goes into the link. */
  code: string;
  /**
   * Apply the receiver's reply code. Rejects with LINK_INVALID (the session stays usable,
   * so the user can paste again); otherwise resolves once the reply is applied.
   */
  accept(replyCode: string): Promise<void>;
  /** Resolves when the DataChannel is open (after a valid reply). */
  channel: Promise<MessageChannelLike>;
  close(): void;
}

export async function createManualOffer(o: ManualOptions): Promise<ManualOffer> {
  const pc = o.rtc({ iceServers: o.iceServers });
  const dc = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
  await pc.setLocalDescription(await pc.createOffer());
  const code = await sealSdp(o.signalKey, 'offer', await gatheredSdp(pc, o.gatherTimeoutMs ?? 3_000));
  const accepted = Promise.withResolvers<void>();
  let applied = false;
  // The ICE timeout only starts once the reply is in: humans copy codes slowly.
  const channel = accepted.promise.then(() =>
    channelOpen(pc, dc, { timeoutMs: o.connectTimeoutMs ?? 30_000, abort: o.abort }),
  );
  const onAbort = () => accepted.reject(new TransferError(ErrorCode.Cancelled, 'cancelled'));
  o.abort?.addEventListener('abort', onAbort, { once: true });
  channel.catch(() => pc.close());
  return {
    code,
    channel,
    async accept(replyCode) {
      if (applied) return;
      const sdp = await openSdp(o.signalKey, 'answer', replyCode);
      await pc.setRemoteDescription({ type: 'answer', sdp });
      applied = true;
      accepted.resolve();
    },
    close: () => pc.close(),
  };
}

export interface ManualAnswer {
  /** Show to the user, to be pasted on the sender's device. */
  code: string;
  channel: Promise<MessageChannelLike>;
}

/** Receiver: answer the offer from the link. Throws LINK_INVALID if the offer doesn't fit the secret. */
export async function createManualAnswer(o: ManualOptions & { offerCode: string }): Promise<ManualAnswer> {
  const sdp = await openSdp(o.signalKey, 'offer', o.offerCode);
  const pc = o.rtc({ iceServers: o.iceServers });
  // No timeout here: the sender may take minutes to paste our reply.
  const channel = channelOpen(pc, null, { timeoutMs: 0, abort: o.abort });
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await pc.setLocalDescription(await pc.createAnswer());
  } catch (cause) {
    pc.close();
    throw new TransferError(ErrorCode.IceFailed, 'could not answer the offer', { cause });
  }
  channel.catch(() => {});
  const code = await sealSdp(o.signalKey, 'answer', await gatheredSdp(pc, o.gatherTimeoutMs ?? 3_000));
  return { code, channel };
}
