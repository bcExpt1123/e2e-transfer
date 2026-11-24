/** Status and progress wording shared by the send and receive screens (docs/UX.md § microcopy). */
import { formatBytes, formatDuration, formatRate } from './format.ts';
import type { Messages } from './i18n/en.ts';

export interface RateLike {
  bytesPerSecond: number;
  secondsLeft: number | null;
}

/** "12 MB of 40 MB · 34 MB/s · about 20 s left" (speed/ETA only once known). */
export function transferDetail(m: Messages, done: number, total: number, rate: RateLike): string {
  const parts = [m.transfer.of(formatBytes(done), formatBytes(total))];
  if (rate.bytesPerSecond > 0) parts.push(m.transfer.speed(formatRate(rate.bytesPerSecond)));
  if (rate.secondsLeft !== null) parts.push(m.transfer.left(formatDuration(rate.secondsLeft)));
  return parts.join(' · ');
}

/** Index into [waiting, connecting, secured] for the status stepper. */
export function connectStep(phase: string): number {
  switch (phase) {
    case 'idle':
    case 'joining':
    case 'waiting':
      return 0;
    case 'connecting':
    case 'handshaking':
      return 1;
    case 'connected':
      return 2;
    default:
      return 3;
  }
}

/** Long-form status line for the phases before the transfer starts. */
export function statusLine(m: Messages, phase: string, role: 'sender' | 'receiver'): string {
  switch (phase) {
    case 'idle':
    case 'joining':
      return m.status.joining;
    case 'waiting':
      return m.status.waitingLong;
    case 'connecting':
      return m.status.connectingLong;
    case 'handshaking':
      return m.status.securing;
    case 'connected':
      return role === 'receiver' ? m.status.waitingSender : m.status.securing;
    case 'awaiting-accept':
      return m.status.waitingAccept;
    default:
      return '';
  }
}
