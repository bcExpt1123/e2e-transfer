/**
 * Which signaling network and ICE servers to use. Defaults can be overridden per
 * deployment (VITE_SIGNALING_RELAYS, VITE_ICE_SERVERS) — docs/ARCHITECTURE.md § Why this scales.
 */
import type { Signaling } from '@e2e-transfer/core';
import { broadcastSignaling } from '@e2e-transfer/signaling';

const DEFAULT_ICE: RTCIceServer[] = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
];

/** Local override, used by the e2e tests and for same-browser demos: `broadcast` | `nostr`. */
export const SIGNALING_PREF_KEY = 'e2e-transfer.signaling';

function readPref(): string | null {
  try {
    return localStorage.getItem(SIGNALING_PREF_KEY);
  } catch {
    return null;
  }
}

function envList(value: string | undefined): string[] | undefined {
  const list = value
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list && list.length > 0 ? list : undefined;
}

export function iceServers(): RTCIceServer[] {
  const raw = import.meta.env.VITE_ICE_SERVERS as string | undefined;
  if (!raw) return DEFAULT_ICE;
  try {
    const parsed = JSON.parse(raw) as RTCIceServer[];
    return Array.isArray(parsed) ? parsed : DEFAULT_ICE;
  } catch {
    return DEFAULT_ICE;
  }
}

export async function createSignaling(): Promise<Signaling> {
  if (readPref() === 'broadcast') return broadcastSignaling();
  // Loaded on demand: keeps secp256k1 out of the initial bundle.
  const { nostrSignaling, DEFAULT_RELAYS } = await import('@e2e-transfer/signaling/nostr');
  const relays = envList(import.meta.env.VITE_SIGNALING_RELAYS as string | undefined) ?? DEFAULT_RELAYS;
  return nostrSignaling({ relays });
}
