import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import { isPublicAddress } from './ip-policy.js';

export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

export class BlockedAddressError extends Error {
  readonly code = 'ERR_BLOCKED_ADDRESS';

  constructor(
    readonly hostname: string,
    readonly address: string,
  ) {
    super(`${hostname} resolves to non-public address ${address}`);
    this.name = 'BlockedAddressError';
  }
}

const systemResolver: Resolver = (hostname) =>
  dnsLookup(hostname, { all: true, order: 'verbatim' });

function notFound(hostname: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
    code: 'ENOTFOUND',
    hostname,
  });
}

function requestedFamily(family: unknown): 4 | 6 | undefined {
  if (family === 4 || family === 'IPv4') return 4;
  if (family === 6 || family === 'IPv6') return 6;
  return undefined;
}

export interface PinnedLookupOptions {
  resolve?: Resolver;
  isAllowed?: (address: string) => boolean;
}

/**
 * A `net`-compatible lookup that validates resolved addresses at connect time.
 *
 * Because the socket connects to exactly the address validated here, a
 * hostname cannot pass a check and then re-resolve to an internal address
 * (DNS rebinding). If any record is non-public the whole host is refused,
 * so an attacker cannot mix a public and a private record and hope the
 * private one is picked.
 */
export function createPinnedLookup({
  resolve = systemResolver,
  isAllowed = isPublicAddress,
}: PinnedLookupOptions = {}): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (records) => {
        const blocked = records.find((record) => !isAllowed(record.address));
        if (blocked) {
          callback(new BlockedAddressError(hostname, blocked.address), '');
          return;
        }
        const family = requestedFamily(options.family);
        const candidates = family ? records.filter((record) => record.family === family) : records;
        const [first] = candidates;
        if (!first) {
          callback(notFound(hostname), '');
          return;
        }
        if (options.all) {
          callback(null, candidates);
        } else {
          callback(null, first.address, first.family);
        }
      },
      (error: NodeJS.ErrnoException) => callback(error, ''),
    );
  };
}
