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
  [ErrorCode.IceFailed]: ['configureTurn', 'tryAgain', 'learnMore'],
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

/**
 * Text and actions for an error. `supported` lists the actions the current screen can
 * perform; others are hidden (e.g. QR and TURN until phase 5). Never returns zero actions:
 * `fallback` is offered when nothing else applies.
 */
export function describeError(
  code: ErrorCode,
  m: Messages,
  supported?: ReadonlySet<ErrorAction>,
  fallback: ErrorAction = 'startOver',
): ErrorView {
  let ids = ERROR_ACTIONS[code].filter((id) => !supported || supported.has(id));
  if (ids.length === 0) ids = [fallback];
  return {
    code,
    message: m.errors[code],
    actions: ids.map((id) => ({ id, label: m.errorActions[id] })),
  };
}
