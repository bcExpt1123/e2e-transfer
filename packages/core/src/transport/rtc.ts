/**
 * The subset of WebRTC that core uses. The browser's RTCPeerConnection satisfies
 * these types structurally; tests pass a fake (packages/core/test/fake-rtc.ts).
 */
import type { Bytes } from '../bytes.ts';
import type { MessageChannelLike } from './channel.ts';

export interface RtcDataChannelLike extends EventTarget {
  readonly label: string;
  readonly readyState: RTCDataChannelState;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType: BinaryType;
  send(data: Bytes): void;
  close(): void;
}

export interface RtcPeerLike extends EventTarget {
  readonly connectionState: RTCPeerConnectionState;
  readonly iceGatheringState: RTCIceGatheringState;
  /** The local SDP; includes gathered candidates once gathering is complete. */
  readonly localDescription: { readonly sdp: string } | null;
  createDataChannel(label: string, init?: RTCDataChannelInit): RtcDataChannelLike;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  close(): void;
}

export type RtcFactory = (config: RTCConfiguration) => RtcPeerLike;

/** Uses the browser's RTCPeerConnection. */
export const browserRtc: RtcFactory = (config) => new RTCPeerConnection(config) as unknown as RtcPeerLike;

export const DATA_CHANNEL_LABEL = 'e2e-transfer/v1';

/**
 * A connection that stays "disconnected" this long counts as lost. Browsers take up to ~30 s
 * to declare it "failed"; giving up sooner lets resume (PROTOCOL §4.6) start sooner.
 */
export const DISCONNECTED_GRACE_MS = 8_000;

/**
 * Adapt an open RTCDataChannel to the engine's MessageChannelLike.
 * Closing the channel also closes the peer connection; a failed connection counts as closed.
 */
export function dataChannelAdapter(
  dc: RtcDataChannelLike,
  pc?: RtcPeerLike,
  disconnectedGraceMs = DISCONNECTED_GRACE_MS,
): MessageChannelLike {
  dc.binaryType = 'arraybuffer';
  const closeListeners = new Set<() => void>();
  let closed = dc.readyState === 'closing' || dc.readyState === 'closed';
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const markClosed = () => {
    clearTimeout(graceTimer);
    if (closed) return;
    closed = true;
    for (const cb of [...closeListeners]) cb();
    closeListeners.clear();
  };
  const onState = () => {
    if (!pc) return;
    const state = pc.connectionState;
    if (state === 'failed' || state === 'closed') markClosed();
    else if (state === 'disconnected') graceTimer ??= setTimeout(markClosed, disconnectedGraceMs);
    else {
      clearTimeout(graceTimer);
      graceTimer = undefined;
    }
  };
  dc.addEventListener('close', markClosed);
  dc.addEventListener('error', markClosed);
  pc?.addEventListener('connectionstatechange', onState);

  const listen = <E extends Event>(type: string, handler: (e: E) => void) => {
    const fn = handler as EventListener;
    dc.addEventListener(type, fn);
    return () => dc.removeEventListener(type, fn);
  };

  return {
    send(data) {
      if (closed) throw new DOMException('channel closed', 'InvalidStateError');
      dc.send(data);
    },
    get bufferedAmount() {
      return dc.bufferedAmount;
    },
    get bufferedAmountLowThreshold() {
      return dc.bufferedAmountLowThreshold;
    },
    set bufferedAmountLowThreshold(v: number) {
      dc.bufferedAmountLowThreshold = v;
    },
    onBufferedAmountLow: (cb) => listen('bufferedamountlow', cb),
    onMessage: (cb) =>
      listen<MessageEvent>('message', (e) => {
        if (e.data instanceof ArrayBuffer) cb(new Uint8Array(e.data));
        // strings/Blobs are not part of the protocol: SecureChannel would reject them anyway
        else cb(new Uint8Array(0));
      }),
    onClose(cb) {
      if (closed) {
        queueMicrotask(cb);
        return () => {};
      }
      closeListeners.add(cb);
      return () => closeListeners.delete(cb);
    },
    close() {
      clearTimeout(graceTimer);
      dc.removeEventListener('close', markClosed);
      pc?.removeEventListener('connectionstatechange', onState);
      dc.close();
      pc?.close();
      markClosed();
    },
    get closed() {
      return closed;
    },
  };
}
