/**
 * Port for signaling adapters (docs/ARCHITECTURE.md § Adapter interfaces).
 * Adapters move opaque, already-encrypted bytes; core does all crypto,
 * replay filtering and deduplication, so an adapter cannot weaken security.
 */
export interface Signaling {
  /** Human-readable adapter id, e.g. "nostr". */
  readonly id: string;
  join(topic: string): Promise<SignalingRoom>;
}

export interface SignalingRoom {
  send(payload: Uint8Array): Promise<void>;
  /** Returns an unsubscribe function. */
  onMessage(cb: (payload: Uint8Array) => void): () => void;
  leave(): Promise<void>;
}
