import { broadcastSignaling } from '../src/broadcast.ts';
import { signalingContract } from './contract.ts';

signalingContract('broadcast', () => [broadcastSignaling('test'), broadcastSignaling('test')]);
