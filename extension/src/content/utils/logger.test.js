import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { log, warn, error, debug, setDebug, isDebug } from './logger.js';

describe('logger', () => {
  let logSpy, warnSpy, errorSpy;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setDebug(false);
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('tags log output', () => {
    log('hello', 42);
    expect(logSpy).toHaveBeenCalledWith('[chessbot]', 'hello', 42);
  });

  it('tags warn output', () => {
    warn('careful');
    expect(warnSpy).toHaveBeenCalledWith('[chessbot]', 'careful');
  });

  it('tags error output', () => {
    error('oops', { code: 1 });
    expect(errorSpy).toHaveBeenCalledWith('[chessbot]', 'oops', { code: 1 });
  });

  it('debug is a no-op by default', () => {
    debug('hidden');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('debug fires when enabled', () => {
    setDebug(true);
    expect(isDebug()).toBe(true);
    debug('visible');
    expect(logSpy).toHaveBeenCalledWith('[chessbot:debug]', 'visible');
  });
});
