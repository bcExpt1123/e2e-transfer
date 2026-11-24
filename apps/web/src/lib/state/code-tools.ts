/** Lazily loaded short-code helpers (the word list and ristretto255 aren't in the initial bundle). */
let loading: Promise<typeof import('@e2e-transfer/core/code')> | undefined;

export const codeTools = (): Promise<typeof import('@e2e-transfer/core/code')> =>
  (loading ??= import('@e2e-transfer/core/code'));
