/**
 * Every failure the UI can show. The UI maps codes to text in
 * apps/web/src/lib/errors.ts (docs/UX.md § Error catalog) — never match on messages.
 */
export const ErrorCode = {
  SignalingUnreachable: 'SIGNALING_UNREACHABLE',
  PeerTimeout: 'PEER_TIMEOUT',
  IceFailed: 'ICE_FAILED',
  ConnectionLost: 'CONNECTION_LOST',
  LinkInvalid: 'LINK_INVALID',
  Declined: 'DECLINED',
  ProtocolError: 'PROTOCOL_ERROR',
  StorageQuota: 'STORAGE_QUOTA',
  Cancelled: 'CANCELLED',
  VersionMismatch: 'VERSION_MISMATCH',
  /** Receiver: the short code didn't match the sender's. */
  CodeInvalid: 'CODE_INVALID',
  /** Sender: too many wrong codes were tried; a new code is needed. */
  CodeAttempts: 'CODE_ATTEMPTS',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class TransferError extends Error {
  override readonly name = 'TransferError';

  constructor(
    readonly code: ErrorCode,
    message: string = code,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function isTransferError(err: unknown): err is TransferError {
  return err instanceof TransferError;
}

/** Normalise any thrown value into a TransferError (unknowns become PROTOCOL_ERROR). */
export function toTransferError(err: unknown): TransferError {
  if (isTransferError(err)) return err;
  return new TransferError(ErrorCode.ProtocolError, err instanceof Error ? err.message : String(err), {
    cause: err,
  });
}
