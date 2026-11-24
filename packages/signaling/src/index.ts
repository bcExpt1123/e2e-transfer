export type { Signaling, SignalingRoom } from '@e2e-transfer/core';
export { broadcastSignaling } from './broadcast.ts';
export { MemorySignalingHub } from './memory.ts';
export { multiSignaling } from './multi.ts';
export {
  type HealthStore,
  RelayHealth,
  type RelayRecord,
  type RelayStatus,
  type RelayStatusListener,
} from './shared/health.ts';
// Network adapters are loaded lazily by the app:
//   '@e2e-transfer/signaling/nostr' (pulls in secp256k1), '@e2e-transfer/signaling/mqtt'.
