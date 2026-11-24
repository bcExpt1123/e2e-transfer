import { ErrorCode } from '@e2e-transfer/core';
import { describe, expect, it } from 'vitest';
import { describeError, ERROR_ACTIONS } from './errors.ts';
import { en } from './i18n/en.ts';

describe('error catalog', () => {
  const codes = Object.values(ErrorCode);

  it.each(codes)('%s has a message and at least one action', (code) => {
    const view = describeError(code, en);
    expect(view.message.length).toBeGreaterThan(0);
    expect(view.actions.length).toBeGreaterThan(0);
    for (const a of view.actions) expect(a.label.length).toBeGreaterThan(0);
  });

  it('covers exactly the core error codes', () => {
    expect(Object.keys(ERROR_ACTIONS).sort()).toEqual([...codes].sort());
    expect(Object.keys(en.errors).sort()).toEqual([...codes].sort());
  });
});

describe('describeError with supported actions', () => {
  it('hides unsupported actions and falls back when none remain', () => {
    const supported = new Set(['retry', 'tryAgain'] as const);
    expect(describeError(ErrorCode.SignalingUnreachable, en, supported).actions.map((a) => a.id)).toEqual([
      'retry',
    ]);
    expect(describeError(ErrorCode.IceFailed, en, supported, 'tryAgain').actions).toEqual([
      { id: 'tryAgain', label: 'Try again' },
    ]);
  });
});
