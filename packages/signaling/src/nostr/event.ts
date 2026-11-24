/** Minimal NIP-01 event creation for ephemeral signaling events. */
import { toHex, utf8 } from '@e2e-transfer/core';
import { schnorr } from '@noble/curves/secp256k1.js';

/** Ephemeral range (20000–29999): relays forward these live and never store them (NIP-01). */
export const SIGNAL_KIND = 25050;

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** A throwaway identity, one per join: nothing links two transfers to each other. */
export interface Identity {
  secretKey: Uint8Array;
  pubkey: string;
}

export function newIdentity(): Identity {
  const { secretKey, publicKey } = schnorr.keygen();
  return { secretKey, pubkey: toHex(publicKey) };
}

export async function signEvent(
  who: Identity,
  e: { kind: number; tags: string[][]; content: string; created_at: number },
): Promise<NostrEvent> {
  const serialized = JSON.stringify([0, who.pubkey, e.created_at, e.kind, e.tags, e.content]);
  const id = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(serialized)));
  const sig = schnorr.sign(id, who.secretKey);
  return { ...e, pubkey: who.pubkey, id: toHex(id), sig: toHex(sig) };
}
