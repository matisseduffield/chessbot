import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require2 = createRequire(import.meta.url);
const logger = require2('./logger.js');

beforeEach(() => logger.clear());

describe('logger', () => {
  it('captures console.log through override', () => {
    logger.install();
    console.log('hello', { a: 1 });
    const buf = logger.getBuffer();
    expect(buf.length).toBeGreaterThan(0);
    expect(buf[buf.length - 1]).toMatch(/LOG:.*hello.*"a":1/);
  });

  it('captures console.warn and console.error', () => {
    logger.install();
    console.warn('w');
    console.error('e');
    const buf = logger.getBuffer();
    expect(buf.some((l) => /WARN:.*w/.test(l))).toBe(true);
    expect(buf.some((l) => /ERR:.*e/.test(l))).toBe(true);
  });

  it('caps buffer at SERVER_LOG_MAX', () => {
    logger.install();
    for (let i = 0; i < logger.SERVER_LOG_MAX + 50; i++) console.log('x' + i);
    expect(logger.getBuffer().length).toBe(logger.SERVER_LOG_MAX);
  });
});
