import { describe, expect, it } from 'vitest';
import { en } from './i18n/en.ts';
import { connectStep, statusLine, transferDetail } from './transfer-text.ts';

describe('transfer text', () => {
  it('adds speed and time left only once known', () => {
    expect(transferDetail(en, 12e6, 40e6, { bytesPerSecond: 0, secondsLeft: null })).toBe('12 MB of 40 MB');
    expect(transferDetail(en, 12e6, 40e6, { bytesPerSecond: 34e6, secondsLeft: 20 })).toBe(
      '12 MB of 40 MB · 34 MB/s · about 20 s left',
    );
  });

  it('maps phases to stepper positions and status lines', () => {
    expect(['waiting', 'connecting', 'connected', 'transferring'].map(connectStep)).toEqual([0, 1, 2, 3]);
    expect(statusLine(en, 'connected', 'receiver')).toBe(en.status.waitingSender);
    expect(statusLine(en, 'awaiting-accept', 'sender')).toBe(en.status.waitingAccept);
    expect(statusLine(en, 'handshaking', 'sender')).toBe(en.status.securing);
    expect(statusLine(en, 'done', 'sender')).toBe('');
  });
});
