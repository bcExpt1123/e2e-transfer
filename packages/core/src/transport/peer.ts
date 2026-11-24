/**
 * Establishes the WebRTC DataChannel over an encrypted SignalSession
 * (docs/ARCHITECTURE.md § Session lifecycle). The sender always makes the offer,
 * so no glare handling is needed. ICE is trickled.
 */
import { ErrorCode, TransferError } from '../errors.ts';
import type { Role } from '../protocol/frames.ts';
import type { SignalMessage, SignalSession } from '../signaling/envelope.ts';
import type { MessageChannelLike } from './channel.ts';
import {
  DATA_CHANNEL_LABEL,
  dataChannelAdapter,
  type RtcDataChannelLike,
  type RtcFactory,
  type RtcPeerLike,
} from './rtc.ts';

export interface ConnectOptions {
  role: Role;
  signal: SignalSession;
  rtc: RtcFactory;
  iceServers: RTCIceServer[];
  /** Receiver: give up when no offer arrives within this time (PEER_TIMEOUT). */
  peerTimeoutMs?: number;
  /** Both: ICE + DTLS + channel open must finish within this time (ICE_FAILED). */
  connectTimeoutMs?: number;
  /** Receiver: repeat `join` at this interval until the offer arrives (relays may drop messages). */
  joinIntervalMs?: number;
  abort?: AbortSignal;
  /** Called once the other device has been found and the connection is being set up. */
  onConnecting?: (peer: { hint?: string }) => void;
  /** Receiver: short device description sent in `join` (e.g. "Firefox on Android"). */
  hint?: string;
}

export const CONNECT_DEFAULTS = {
  peerTimeoutMs: 30_000,
  connectTimeoutMs: 30_000,
  joinIntervalMs: 2_000,
} as const;

export function connect(opts: ConnectOptions): Promise<MessageChannelLike> {
  return new Connector(opts).run();
}

class Connector {
  readonly #o: ConnectOptions;
  readonly #cleanups: (() => void)[] = [];
  readonly #result = Promise.withResolvers<MessageChannelLike>();
  #settled = false;
  #peerId: string | undefined;
  #pc: RtcPeerLike | undefined;
  #remoteSet = false;
  #pendingIce: RTCIceCandidateInit[] = [];
  #localSdp: RTCSessionDescriptionInit | undefined;
  #connectTimer: ReturnType<typeof setTimeout> | undefined;
  #peerHint: string | undefined;
  /** Candidates that overtook the offer on the relays, by author (receiver side). */
  readonly #earlyIce = new Map<string, RTCIceCandidateInit[]>();

  constructor(opts: ConnectOptions) {
    this.#o = opts;
  }

  run(): Promise<MessageChannelLike> {
    const { abort, signal, role } = this.#o;
    if (abort?.aborted) return Promise.reject(cancelled());
    const onAbort = () => {
      if (this.#peerId) void signal.send('bye', { reason: 'cancelled' }, this.#peerId).catch(() => {});
      this.#fail(cancelled());
    };
    abort?.addEventListener('abort', onAbort);
    this.#cleanups.push(
      () => abort?.removeEventListener('abort', onAbort),
      signal.on((msg) => {
        this.#onSignal(msg).catch((err) => this.#fail(err));
      }),
    );
    if (role === 'receiver') this.#startJoining();
    return this.#result.promise;
  }

  #startJoining() {
    const { signal } = this.#o;
    const d = this.#o.hint ? { hint: this.#o.hint } : {};
    const join = () => void signal.send('join', d).catch(() => {});
    join();
    const interval = setInterval(() => {
      if (this.#peerId) clearInterval(interval);
      else join();
    }, this.#o.joinIntervalMs ?? CONNECT_DEFAULTS.joinIntervalMs);
    const timeout = setTimeout(() => {
      if (!this.#peerId) this.#fail(new TransferError(ErrorCode.PeerTimeout, 'no offer received'));
    }, this.#o.peerTimeoutMs ?? CONNECT_DEFAULTS.peerTimeoutMs);
    this.#cleanups.push(
      () => clearInterval(interval),
      () => clearTimeout(timeout),
    );
  }

  async #onSignal(msg: SignalMessage): Promise<void> {
    if (this.#settled) return;
    const { role, signal } = this.#o;

    // Only one peer per attempt: lock onto the first one, ignore everyone else.
    if (this.#peerId !== undefined && msg.from !== this.#peerId) return;

    if (msg.t === 'bye') {
      if (this.#peerId === undefined) return;
      const code = msg.d.reason === 'cancelled' ? ErrorCode.Cancelled : ErrorCode.ConnectionLost;
      this.#fail(new TransferError(code, 'peer left'));
      return;
    }

    if (role === 'sender') {
      if (msg.t === 'join') {
        if (this.#peerId === undefined) {
          this.#peerId = msg.from;
          this.#peerHint = cleanHint(msg.d.hint);
          await this.#offer();
        } else if (this.#localSdp && !this.#remoteSet) {
          // The receiver is still asking: our offer was probably lost on the relays.
          await signal.send('offer', { sdp: this.#localSdp.sdp }, this.#peerId);
        }
        return;
      }
      if (msg.t === 'answer' && this.#peerId !== undefined && !this.#remoteSet) {
        await this.#setRemote({ type: 'answer', sdp: sdpOf(msg) });
        return;
      }
    } else {
      if (msg.t === 'offer') {
        if (this.#peerId === undefined) {
          this.#peerId = msg.from;
          this.#pendingIce.push(...(this.#earlyIce.get(msg.from) ?? []));
          this.#earlyIce.clear();
          await this.#answer(sdpOf(msg));
        } else if (this.#localSdp) {
          // A repeated offer means our answer was lost.
          await signal.send('answer', { sdp: this.#localSdp.sdp }, this.#peerId);
        }
        return;
      }
    }

    if (msg.t === 'ice') {
      const candidate = msg.d.candidate;
      if (typeof candidate !== 'object' || candidate === null) return;
      if (this.#peerId === undefined) {
        // Relays don't preserve order: keep a few until we know who the sender is.
        const list = this.#earlyIce.get(msg.from) ?? [];
        if (list.length < 50 && this.#earlyIce.size < 8) this.#earlyIce.set(msg.from, [...list, candidate]);
        return;
      }
      if (this.#remoteSet && this.#pc) await this.#pc.addIceCandidate(candidate as RTCIceCandidateInit);
      else this.#pendingIce.push(candidate as RTCIceCandidateInit);
    }
  }

  #createPeer(): RtcPeerLike {
    this.#o.onConnecting?.(this.#peerHint ? { hint: this.#peerHint } : {});
    const pc = this.#o.rtc({ iceServers: this.#o.iceServers });
    this.#pc = pc;
    const peerId = this.#peerId;
    const onIce = (e: Event) => {
      const c = (e as RTCPeerConnectionIceEvent).candidate;
      if (c && peerId) void this.#o.signal.send('ice', { candidate: c.toJSON() }, peerId).catch(() => {});
    };
    const onState = () => {
      if (pc.connectionState === 'failed') {
        this.#fail(new TransferError(ErrorCode.IceFailed, 'ICE connection failed'));
      }
    };
    pc.addEventListener('icecandidate', onIce);
    pc.addEventListener('connectionstatechange', onState);
    this.#cleanups.push(() => {
      pc.removeEventListener('icecandidate', onIce);
      pc.removeEventListener('connectionstatechange', onState);
    });
    this.#connectTimer = setTimeout(
      () => this.#fail(new TransferError(ErrorCode.IceFailed, 'connection timed out')),
      this.#o.connectTimeoutMs ?? CONNECT_DEFAULTS.connectTimeoutMs,
    );
    this.#cleanups.push(() => clearTimeout(this.#connectTimer));
    return pc;
  }

  async #offer() {
    const pc = this.#createPeer();
    const dc = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
    this.#whenOpen(dc, pc);
    const offer = await pc.createOffer();
    if (this.#settled) return;
    await pc.setLocalDescription(offer);
    if (this.#settled) return;
    this.#localSdp = offer;
    await this.#o.signal.send('offer', { sdp: offer.sdp }, this.#peerId);
  }

  async #answer(sdp: string) {
    const pc = this.#createPeer();
    const onChannel = (e: Event) => {
      const dc = (e as RTCDataChannelEvent).channel as unknown as RtcDataChannelLike;
      if (dc.label === DATA_CHANNEL_LABEL) this.#whenOpen(dc, pc);
    };
    pc.addEventListener('datachannel', onChannel);
    this.#cleanups.push(() => pc.removeEventListener('datachannel', onChannel));
    await this.#setRemote({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    if (this.#settled) return;
    await pc.setLocalDescription(answer);
    if (this.#settled) return;
    this.#localSdp = answer;
    await this.#o.signal.send('answer', { sdp: answer.sdp }, this.#peerId);
  }

  async #setRemote(desc: RTCSessionDescriptionInit) {
    const pc = this.#pc;
    if (!pc) return;
    await pc.setRemoteDescription(desc);
    if (this.#settled) return;
    this.#remoteSet = true;
    for (const c of this.#pendingIce.splice(0)) await pc.addIceCandidate(c);
  }

  #whenOpen(dc: RtcDataChannelLike, pc: RtcPeerLike) {
    dc.binaryType = 'arraybuffer';
    const done = () => this.#succeed(dataChannelAdapter(dc, pc));
    if (dc.readyState === 'open') {
      queueMicrotask(done);
      return;
    }
    const onClose = () => this.#fail(new TransferError(ErrorCode.IceFailed, 'channel closed before opening'));
    dc.addEventListener('open', done, { once: true });
    dc.addEventListener('close', onClose, { once: true });
    this.#cleanups.push(() => {
      dc.removeEventListener('open', done);
      dc.removeEventListener('close', onClose);
    });
  }

  #succeed(channel: MessageChannelLike) {
    if (this.#settled) return;
    this.#settled = true;
    this.#cleanup();
    this.#result.resolve(channel);
  }

  #fail(err: unknown) {
    if (this.#settled) return;
    this.#settled = true;
    this.#cleanup();
    this.#pc?.close();
    this.#result.reject(
      err instanceof TransferError
        ? err
        : new TransferError(ErrorCode.IceFailed, 'connection setup failed', { cause: err }),
    );
  }

  #cleanup() {
    for (const fn of this.#cleanups.splice(0)) fn();
  }
}

const cancelled = () => new TransferError(ErrorCode.Cancelled, 'cancelled');

function sdpOf(msg: SignalMessage): string {
  const sdp = msg.d.sdp;
  if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > 100_000) {
    throw new TransferError(ErrorCode.ProtocolError, `malformed ${msg.t}`);
  }
  return sdp;
}

// C0/C1 controls and bidi overrides: the hint is shown in the UI.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/** The hint is unauthenticated decoration from the peer: keep it short and printable. */
function cleanHint(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(UNSAFE_CHARS, '').trim().slice(0, 48);
  return s || undefined;
}
