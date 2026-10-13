import { get } from 'node:http';
import type { LookupAddress } from 'node:dns';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlockedAddressError, createPinnedLookup } from '../../src/security/pinned-lookup.js';
import type { Resolver } from '../../src/security/pinned-lookup.js';

const fakeDns =
  (records: Record<string, LookupAddress[]>): Resolver =>
  (hostname) =>
    Promise.resolve(records[hostname] ?? []);

const v4 = (address: string): LookupAddress => ({ address, family: 4 });
const v6 = (address: string): LookupAddress => ({ address, family: 6 });

/** Promisified call of a net-style lookup function. */
function lookup(
  fn: ReturnType<typeof createPinnedLookup>,
  hostname: string,
  options: { all?: boolean; family?: number } = {},
) {
  return new Promise<{ address: string | LookupAddress[]; family?: number }>((resolve, reject) => {
    fn(hostname, options, (error, address, family) =>
      error ? reject(error) : resolve({ address, family }),
    );
  });
}

describe('createPinnedLookup', () => {
  it('returns the first public address for single lookups', async () => {
    const fn = createPinnedLookup({
      resolve: fakeDns({ 'a.test': [v4('8.8.8.8'), v4('8.8.4.4')] }),
    });
    expect(await lookup(fn, 'a.test')).toEqual({ address: '8.8.8.8', family: 4 });
  });

  it('returns every address when asked for all (happy-eyeballs connects)', async () => {
    const fn = createPinnedLookup({
      resolve: fakeDns({ 'a.test': [v6('2606:4700::1111'), v4('8.8.8.8')] }),
    });
    expect((await lookup(fn, 'a.test', { all: true })).address).toEqual([
      v6('2606:4700::1111'),
      v4('8.8.8.8'),
    ]);
  });

  it('honours a requested address family', async () => {
    const fn = createPinnedLookup({
      resolve: fakeDns({ 'a.test': [v6('2606:4700::1111'), v4('8.8.8.8')] }),
    });
    expect(await lookup(fn, 'a.test', { family: 4 })).toEqual({ address: '8.8.8.8', family: 4 });
  });

  it('blocks a hostname that resolves to a private address', async () => {
    const fn = createPinnedLookup({ resolve: fakeDns({ 'evil.test': [v4('169.254.169.254')] }) });
    const error = await lookup(fn, 'evil.test').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BlockedAddressError);
    expect(error).toMatchObject({ code: 'ERR_BLOCKED_ADDRESS', hostname: 'evil.test' });
  });

  it('blocks when any resolved address is private, even if others are public', async () => {
    const fn = createPinnedLookup({
      resolve: fakeDns({ 'mixed.test': [v4('8.8.8.8'), v4('127.0.0.1')] }),
    });
    await expect(lookup(fn, 'mixed.test', { all: true })).rejects.toBeInstanceOf(
      BlockedAddressError,
    );
  });

  it('reports hosts with no records as not found', async () => {
    const fn = createPinnedLookup({ resolve: fakeDns({}) });
    await expect(lookup(fn, 'missing.test')).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });

  it('reports no records for the requested family as not found', async () => {
    const fn = createPinnedLookup({ resolve: fakeDns({ 'a.test': [v4('8.8.8.8')] }) });
    await expect(lookup(fn, 'a.test', { family: 6 })).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });

  it('passes resolver failures through', async () => {
    const failure = Object.assign(new Error('dns down'), { code: 'EAI_AGAIN' });
    const fn = createPinnedLookup({ resolve: () => Promise.reject(failure) });
    await expect(lookup(fn, 'a.test')).rejects.toBe(failure);
  });
});

describe('createPinnedLookup with the system resolver', () => {
  it('blocks localhost resolved through real DNS (/etc/hosts)', async () => {
    await expect(lookup(createPinnedLookup(), 'localhost')).rejects.toBeInstanceOf(
      BlockedAddressError,
    );
  });
});

describe('createPinnedLookup wired into a real socket connect', () => {
  // A local server stands in for an internal service an attacker wants to reach.
  let connections = 0;
  const server = createServer((_req, res) => res.end('internal secret'));
  server.on('connection', () => connections++);
  let port = 0;

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  function fetchVia(lookupFn: ReturnType<typeof createPinnedLookup>) {
    return new Promise<string>((resolve, reject) => {
      get({ host: 'rebind.test', port, path: '/', lookup: lookupFn, agent: false }, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });
  }

  it('refuses to open a socket when DNS points at an internal address', async () => {
    const before = connections;
    const fn = createPinnedLookup({ resolve: fakeDns({ 'rebind.test': [v4('127.0.0.1')] }) });
    await expect(fetchVia(fn)).rejects.toBeInstanceOf(BlockedAddressError);
    expect(connections).toBe(before);
  });

  it('connects to exactly the address it validated (control: policy relaxed for the test)', async () => {
    const fn = createPinnedLookup({
      resolve: fakeDns({ 'rebind.test': [v4('127.0.0.1')] }),
      isAllowed: () => true,
    });
    expect(await fetchVia(fn)).toBe('internal secret');
  });
});
