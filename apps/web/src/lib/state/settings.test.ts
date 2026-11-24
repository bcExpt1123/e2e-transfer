import { beforeEach, describe, expect, it } from 'vitest';
import { iceServers } from './network.ts';
import { EMPTY_SETTINGS, parseList, settings, validate } from './settings.svelte.ts';

describe('network settings', () => {
  beforeEach(() => {
    localStorage.clear();
    settings.reset();
  });

  it('parses lists from text', () => {
    expect(parseList(' wss://a \n\nwss://b, wss://a ')).toEqual(['wss://a', 'wss://b']);
  });

  it.each([
    [{ nostrRelays: ['https://x'] }, 'relay'],
    [{ mqttBrokers: ['ws://insecure'] }, 'broker'],
    [{ stunUrls: ['turn:x'] }, 'stun'],
    [{ turn: { urls: 'turn:x:3478', username: '', credential: 'p' } }, 'turn'],
    [{ turn: { urls: 'stun:x', username: 'u', credential: 'p' } }, 'turn'],
    [
      {
        nostrRelays: ['wss://r'],
        stunUrls: ['stun:s:3478'],
        turn: { urls: 'turns:t:443', username: 'u', credential: 'p' },
      },
      null,
    ],
  ])('validate(%j) → %s', (patch, problem) => {
    expect(validate({ ...EMPTY_SETTINGS, ...patch })).toBe(problem);
  });

  it('saves valid settings, applies them to ICE, and refuses invalid ones', () => {
    expect(iceServers()).toEqual([
      { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
    ]);
    expect(settings.save({ ...EMPTY_SETTINGS, stunUrls: ['nope'] })).toBe('stun');
    const turn = { urls: 'turn:t.example:3478', username: 'u', credential: 'p' };
    expect(settings.save({ ...EMPTY_SETTINGS, stunUrls: ['stun:s.example:3478'], turn })).toBeNull();
    expect(settings.hasTurn).toBe(true);
    expect(iceServers()).toEqual([{ urls: ['stun:s.example:3478'] }, turn]);
    expect(JSON.parse(localStorage.getItem('e2e-transfer.network') ?? '{}').turn).toEqual(turn);
    settings.reset();
    expect(settings.hasTurn).toBe(false);
    expect(localStorage.getItem('e2e-transfer.network')).toBeNull();
  });
});
