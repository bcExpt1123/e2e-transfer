import { describe, expect, it } from 'vitest';
import { ErrorCode, isTransferError, TransferError, toTransferError } from '../src/index.ts';

describe('TransferError', () => {
  it('carries a code', () => {
    const err = new TransferError(ErrorCode.IceFailed);
    expect(err.code).toBe('ICE_FAILED');
    expect(err.message).toBe('ICE_FAILED');
    expect(isTransferError(err)).toBe(true);
  });

  it('passes TransferErrors through unchanged', () => {
    const err = new TransferError(ErrorCode.Declined);
    expect(toTransferError(err)).toBe(err);
  });

  it('wraps unknown errors as PROTOCOL_ERROR with cause', () => {
    const cause = new Error('boom');
    const err = toTransferError(cause);
    expect(err.code).toBe(ErrorCode.ProtocolError);
    expect(err.message).toBe('boom');
    expect(err.cause).toBe(cause);
    expect(toTransferError('x').message).toBe('x');
  });
});
