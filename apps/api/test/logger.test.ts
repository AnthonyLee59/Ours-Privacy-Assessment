import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { lines, stream };
}

describe('createLogger', () => {
  it('honours the configured level', () => {
    expect(createLogger({ logLevel: 'warn' }).level).toBe('warn');
  });

  it('redacts credentials from logged request headers', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ logLevel: 'info' }, stream);
    logger.info({ req: { headers: { cookie: 'session=secret', authorization: 'Bearer secret' } } });
    expect(lines.join('')).not.toMatch(/secret/);
    expect(lines.join('')).toMatch(/\[Redacted\]/);
  });
});
