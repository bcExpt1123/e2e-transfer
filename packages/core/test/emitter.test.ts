import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '../src/index.ts';

type Events = { progress: number; done: undefined };

describe('Emitter', () => {
  it('delivers payloads to listeners', () => {
    const e = new Emitter<Events>();
    const fn = vi.fn();
    e.on('progress', fn);
    e.emit('progress', 42);
    expect(fn).toHaveBeenCalledWith(42);
  });

  it('unsubscribes via the returned function', () => {
    const e = new Emitter<Events>();
    const fn = vi.fn();
    const off = e.on('progress', fn);
    off();
    e.emit('progress', 1);
    expect(fn).not.toHaveBeenCalled();
  });

  it('once fires a single time', () => {
    const e = new Emitter<Events>();
    const fn = vi.fn();
    e.once('done', fn);
    e.emit('done', undefined);
    e.emit('done', undefined);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('tolerates listeners unsubscribing during emit', () => {
    const e = new Emitter<Events>();
    const second = vi.fn();
    const offFirst = e.on('progress', () => offFirst());
    e.on('progress', second);
    e.emit('progress', 1);
    expect(second).toHaveBeenCalledOnce();
  });

  it('clear removes everything', () => {
    const e = new Emitter<Events>();
    const fn = vi.fn();
    e.on('progress', fn);
    e.clear();
    e.emit('progress', 1);
    expect(fn).not.toHaveBeenCalled();
  });
});
