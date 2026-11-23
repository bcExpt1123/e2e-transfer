import type { Bytes } from '../bytes.ts';

/**
 * The minimal message-channel surface the engine needs. Phase 3 adapts
 * RTCDataChannel to it; tests use LoopbackChannel. Ordered and reliable.
 */
export interface MessageChannelLike {
  /** Throws if the channel is closed. */
  send(data: Bytes): void;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  /** Fires when bufferedAmount drops to or below the threshold. Returns unsubscribe. */
  onBufferedAmountLow(cb: () => void): () => void;
  onMessage(cb: (data: Bytes) => void): () => void;
  onClose(cb: () => void): () => void;
  close(): void;
  readonly closed: boolean;
}
