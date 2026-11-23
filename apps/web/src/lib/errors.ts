import { ErrorCode } from '@e2e-transfer/core';
import type { ErrorAction } from './error-actions.ts';
import type { Messages } from './i18n/en.ts';

export type { ErrorAction };

/**
 * The single mapping from core error codes to what the user sees and can do
 * (docs/UX.md § Error catalog). `Record<ErrorCode, …>` makes a missing code a compile error.
 */
export const ERROR_ACTIONS: Readonly<Record<ErrorCode, readonly ErrorAction[]>> = {
  [ErrorCode.SignalingUnreachable]: ['retry', 'useQr'],
  [ErrorCode.PeerTimeout]: ['keepWaiting', 'copyLink'],
  [ErrorCode.IceFailed]: ['configureTurn', 'learnMore'],
  [ErrorCode.ConnectionLost]: ['tryAgain'],
  [ErrorCode.LinkInvalid]: ['askNewLink'],
  [ErrorCode.Declined]: ['startOver'],
  [ErrorCode.ProtocolError]: ['tryAgain'],
  [ErrorCode.StorageQuota]: ['chooseFolder'],
  [ErrorCode.Cancelled]: ['startOver'],
  [ErrorCode.VersionMismatch]: ['reload'],
};

export interface ErrorView {
  code: ErrorCode;
  message: string;
  actions: { id: ErrorAction; label: string }[];
}

export function describeError(code: ErrorCode, m: Messages): ErrorView {
  return {
    code,
    message: m.errors[code],
    actions: ERROR_ACTIONS[code].map((id) => ({ id, label: m.errorActions[id] })),
  };
}
