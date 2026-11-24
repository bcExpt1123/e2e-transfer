/**
 * Which signaling networks and ICE servers to use. Order of precedence: Settings on
 * this device, then deployment config (VITE_*), then built-in defaults.
 */
import type { Signaling } from '@e2e-transfer/core';
import { broadcastSignaling, multiSignaling } from '@e2e-transfer/signaling';
import { settings } from './settings.svelte.ts';

const DEFAULT_STUN = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];

/** Local override, used by the e2e tests and for same-browser demos: `broadcast`. */
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

function envIce(): RTCIceServer[] | undefined {
  const raw = import.meta.env.VITE_ICE_SERVERS as string | undefined;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as RTCIceServer[]) : undefined;
  } catch {
    return undefined;
  }
}

export function iceServers(): RTCIceServer[] {
  const { stunUrls, turn } = settings.network;
  const base: RTCIceServer[] =
    stunUrls.length > 0 ? [{ urls: stunUrls }] : (envIce() ?? [{ urls: DEFAULT_STUN }]);
  return turn ? [...base, { urls: turn.urls, username: turn.username, credential: turn.credential }] : base;
}

export async function createSignaling(): Promise<Signaling> {
  if (readPref() === 'broadcast') return broadcastSignaling();
  const { nostrRelays, mqttBrokers } = settings.network;
  // Loaded on demand: keeps secp256k1 and the MQTT codec out of the initial bundle.
  const [nostr, mqtt] = await Promise.all([
    import('@e2e-transfer/signaling/nostr'),
    import('@e2e-transfer/signaling/mqtt'),
  ]);
  const relays =
    nostrRelays.length > 0
      ? nostrRelays
      : (envList(import.meta.env.VITE_SIGNALING_RELAYS) ?? nostr.DEFAULT_RELAYS);
  const brokers =
    mqttBrokers.length > 0
      ? mqttBrokers
      : (envList(import.meta.env.VITE_MQTT_BROKERS) ?? mqtt.DEFAULT_BROKERS);
  return multiSignaling([nostr.nostrSignaling({ relays }), mqtt.mqttSignaling({ brokers })]);
}

/** Defaults shown as placeholders in Settings. */
export const DEFAULTS = { stun: DEFAULT_STUN };
