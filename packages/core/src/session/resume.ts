/**
 * Resume rules shared by both engines and the link sessions (docs/PROTOCOL.md §4.6).
 * A transfer interrupted by a lost connection continues on a new connection, keyed by
 * the previous session's resume ticket, from the receiver's written offsets.
 */
import { ErrorCode, type TransferError } from '../errors.ts';

export type { ResumeTicket } from '../keys.ts';

export const RESUME_DEFAULTS = {
  /** Give up when no new connection is up within this time after the drop. */
  resumeTimeoutMs: 60_000,
} as const;

/** Connection failures that interrupt a running transfer without anyone deciding to stop it. */
const LOSSES = new Set<ErrorCode>([ErrorCode.ConnectionLost, ErrorCode.IceFailed]);

/**
 * May a transfer continue after `error`?
 * - `resuming`: this connection was itself a resume attempt that hasn't resumed the transfer yet.
 *   Anything except a decision by either side is worth another try (e.g. a stranger with the link
 *   answered first and failed the handshake).
 * - otherwise only a lost connection qualifies.
 */
export function canResumeAfter(error: TransferError, resuming: boolean): boolean {
  if (error.code === ErrorCode.Cancelled || error.code === ErrorCode.Declined) return false;
  if ((error as TransferError & { fromPeer?: boolean }).fromPeer) return false;
  return resuming || LOSSES.has(error.code);
}
