import { MemorySignalingHub } from '../src/index.ts';
import { signalingContract } from './contract.ts';

signalingContract('memory', () => {
  const hub = new MemorySignalingHub();
  return [hub.client(), hub.client()];
});
