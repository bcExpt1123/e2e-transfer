/**
 * Just enough of RTCPeerConnection/RTCDataChannel to exercise peer.ts in Node.
 * Peers find each other through the SDP string, "connect" once both have
 * exchanged descriptions and at least one ICE candidate, then pair their channels.
 */
import type { Bytes } from '../bytes.ts';
import type { RtcDataChannelLike, RtcFactory, RtcPeerLike } from '../transport/rtc.ts';

export interface FakeRtcOptions {
  /** Make every connection end in connectionState "failed". */
  failIce?: boolean;
  /** Never connect (to test the connect timeout). */
  hang?: boolean;
}

export class FakeDataChannel extends EventTarget implements RtcDataChannelLike {
  readyState: RTCDataChannelState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = 'blob';
  peer: FakeDataChannel | undefined;
  readonly sent: Bytes[] = [];

  constructor(readonly label: string) {
    super();
  }

  open() {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }

  send(data: Bytes): void {
    if (this.readyState !== 'open') throw new DOMException('not open', 'InvalidStateError');
    this.sent.push(data);
    const copy = data.slice().buffer;
    const peer = this.peer;
    setTimeout(() => {
      if (peer?.readyState === 'open') peer.dispatchEvent(new MessageEvent('message', { data: copy }));
    }, 0);
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    setTimeout(() => this.dispatchEvent(new Event('close')), 0);
    this.peer?.close();
  }
}

let nextId = 0;
const registry = new Map<string, FakePeer>();

export class FakePeer extends EventTarget implements RtcPeerLike {
  readonly id = `fake:${nextId++}`;
  connectionState: RTCPeerConnectionState = 'new';
  local: RTCSessionDescriptionInit | undefined;
  remote: RTCSessionDescriptionInit | undefined;
  remoteCandidates = 0;
  channel: FakeDataChannel | undefined;
  other: FakePeer | undefined;
  #candidatesSent = false;

  constructor(
    readonly config: RTCConfiguration,
    readonly opts: FakeRtcOptions,
  ) {
    super();
    registry.set(this.id, this);
  }

  createDataChannel(label: string): RtcDataChannelLike {
    this.channel = new FakeDataChannel(label);
    return this.channel;
  }
  async createOffer() {
    return { type: 'offer' as const, sdp: this.id };
  }
  async createAnswer() {
    if (!this.remote) throw new Error('answer before offer');
    return { type: 'answer' as const, sdp: this.id };
  }
  async setLocalDescription(d: RTCSessionDescriptionInit) {
    this.local = d;
    this.#maybeGather();
  }
  async setRemoteDescription(d: RTCSessionDescriptionInit) {
    const other = registry.get(d.sdp ?? '');
    if (!other) throw new Error('unknown remote description');
    this.remote = d;
    this.other = other;
    this.#maybeGather();
  }
  async addIceCandidate(c: RTCIceCandidateInit) {
    if (!this.remote) throw new Error('candidate before remote description');
    if (c.candidate !== `cand:${this.other?.id}`) throw new Error('foreign candidate');
    this.remoteCandidates++;
    this.#maybeConnect();
  }
  close() {
    this.channel?.close();
    this.#setState('closed');
    registry.delete(this.id);
  }

  #maybeGather() {
    if (!this.local || !this.remote || this.#candidatesSent) return;
    this.#candidatesSent = true;
    const candidate = { candidate: `cand:${this.id}`, sdpMid: '0', sdpMLineIndex: 0 };
    setTimeout(() => {
      const ev = Object.assign(new Event('icecandidate'), { candidate: { toJSON: () => candidate } });
      this.dispatchEvent(ev);
      // end-of-candidates
      this.dispatchEvent(Object.assign(new Event('icecandidate'), { candidate: null }));
    }, 0);
  }

  #maybeConnect() {
    const other = this.other;
    if (!other || other.remoteCandidates === 0 || this.remoteCandidates === 0) return;
    if (this.opts.hang) return;
    if (this.opts.failIce) {
      this.#setState('failed');
      other.#setState('failed');
      return;
    }
    const [offerer, answerer] = this.channel ? [this, other] : [other, this];
    const a = offerer.channel;
    if (!a || answerer.channel) return;
    const b = new FakeDataChannel(a.label);
    answerer.channel = b;
    a.peer = b;
    b.peer = a;
    offerer.#setState('connected');
    answerer.#setState('connected');
    setTimeout(() => {
      answerer.dispatchEvent(Object.assign(new Event('datachannel'), { channel: b }));
      a.open();
      b.open();
    }, 0);
  }

  #setState(s: RTCPeerConnectionState) {
    if (this.connectionState === s) return;
    this.connectionState = s;
    this.dispatchEvent(new Event('connectionstatechange'));
  }
}

export function fakeRtc(opts: FakeRtcOptions = {}): RtcFactory & { peers: FakePeer[] } {
  const peers: FakePeer[] = [];
  const factory = (config: RTCConfiguration) => {
    const p = new FakePeer(config, opts);
    peers.push(p);
    return p;
  };
  return Object.assign(factory, { peers });
}
