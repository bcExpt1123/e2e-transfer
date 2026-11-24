/**
 * Protocol and engine defaults. See docs/PROTOCOL.md §5.
 * Every value can be overridden per session via `resolveConfig`.
 */
export const PROTOCOL_VERSION = 1;

export interface TransferConfig {
  /** Plaintext bytes per CHUNK frame. Frames must stay ≤ maxFrameSize. */
  chunkSize: number;
  /** Hard cap for any DataChannel message (cross-browser safe value). */
  maxFrameSize: number;
  /** Pause sending while `bufferedAmount` exceeds this. */
  bufferedAmountHigh: number;
  /** Resume sending when `bufferedAmount` drops below this. */
  bufferedAmountLow: number;
  /** Receiver sends an ACK at least every this many bytes (protocol cap: ACK_INTERVAL_MAX). */
  ackInterval: number;
  /**
   * Flow-control window: the sender pauses while more than this many bytes are
   * sent but not yet ACKed as written. DataChannels have no receive-side
   * backpressure, so without this a slow disk would buffer unboundedly in RAM.
   */
  maxUnackedBytes: number;
  /** Signaling messages older/newer than this (ms) are dropped. */
  signalingMaxSkewMs: number;
  /** Upper bound on files in a manifest. */
  maxFiles: number;
  /** Receiver: after its final DONE, wait up to this long (ms) for the sender to close. */
  closeGraceMs: number;
}

const KiB = 1024;
const MiB = 1024 * KiB;

export const DEFAULT_CONFIG: Readonly<TransferConfig> = Object.freeze({
  chunkSize: 60 * KiB,
  maxFrameSize: 64 * KiB,
  bufferedAmountHigh: 4 * MiB,
  bufferedAmountLow: 1 * MiB,
  ackInterval: 1 * MiB,
  maxUnackedBytes: 16 * MiB,
  signalingMaxSkewMs: 120_000,
  maxFiles: 10_000,
  closeGraceMs: 3_000,
});

/** Merge overrides onto defaults and validate invariants. */
export function resolveConfig(overrides: Partial<TransferConfig> = {}): TransferConfig {
  const cfg: TransferConfig = { ...DEFAULT_CONFIG, ...overrides };
  // header (12) + chunk prefix (12) + GCM tag (16) must fit next to the data
  const overhead = 12 + 12 + 16;
  if (cfg.chunkSize <= 0 || cfg.chunkSize + overhead > cfg.maxFrameSize) {
    throw new RangeError(`chunkSize must be in (0, ${cfg.maxFrameSize - overhead}]`);
  }
  if (cfg.bufferedAmountLow >= cfg.bufferedAmountHigh) {
    throw new RangeError('bufferedAmountLow must be below bufferedAmountHigh');
  }
  if (cfg.ackInterval <= 0 || cfg.ackInterval > ACK_INTERVAL_MAX) {
    throw new RangeError(`ackInterval must be in (0, ${ACK_INTERVAL_MAX}]`);
  }
  // Peers may use different configs; the window must exceed any compliant peer's ACK spacing.
  if (cfg.maxUnackedBytes < 2 * ACK_INTERVAL_MAX) {
    throw new RangeError(`maxUnackedBytes must be at least ${2 * ACK_INTERVAL_MAX}`);
  }
  return cfg;
}

/** Protocol rule (PROTOCOL §5): receivers ACK at least every 1 MiB written and at every FILE_END. */
export const ACK_INTERVAL_MAX = 1 * MiB;
