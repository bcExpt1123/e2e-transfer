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
  /** Receiver sends an ACK at least every this many bytes. */
  ackInterval: number;
  /** Signaling messages older/newer than this (ms) are dropped. */
  signalingMaxSkewMs: number;
  /** Upper bound on files in a manifest. */
  maxFiles: number;
}

const KiB = 1024;
const MiB = 1024 * KiB;

export const DEFAULT_CONFIG: Readonly<TransferConfig> = Object.freeze({
  chunkSize: 60 * KiB,
  maxFrameSize: 64 * KiB,
  bufferedAmountHigh: 4 * MiB,
  bufferedAmountLow: 1 * MiB,
  ackInterval: 1 * MiB,
  signalingMaxSkewMs: 120_000,
  maxFiles: 10_000,
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
  return cfg;
}
