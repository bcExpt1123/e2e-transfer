import { ErrorCode, type TransferError } from '../errors.ts';

/** Lifecycle shared by Sender and Receiver (docs/ARCHITECTURE.md § Session lifecycle). */
export type TransferPhase =
  | 'handshaking'
  | 'awaiting-accept' // sender: waiting for the receiver to review
  | 'reviewing' // receiver: user is looking at the manifest
  | 'transferring'
  | 'finishing'
  | 'done'
  | 'declined'
  | 'cancelled'
  | 'failed';

export function phaseForError(error: TransferError): TransferPhase {
  if (error.code === ErrorCode.Cancelled) return 'cancelled';
  if (error.code === ErrorCode.Declined) return 'declined';
  return 'failed';
}
