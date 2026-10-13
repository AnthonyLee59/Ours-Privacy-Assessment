import { describe, expect, it } from 'vitest';
import { isPublicAddress } from '../../src/security/ip-policy.js';

describe('isPublicAddress', () => {
  it.each([
    ['8.8.8.8', 'public IPv4'],
    ['93.184.216.34', 'public IPv4'],
    ['2606:4700::1111', 'public IPv6'],
    ['::ffff:8.8.8.8', 'IPv4-mapped public address'],
  ])('allows %s (%s)', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    ['0.0.0.0', 'unspecified (reaches localhost on Linux)'],
    ['0.1.2.3', '"this network" 0/8'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback range'],
    ['10.0.0.1', 'private 10/8'],
    ['172.16.0.1', 'private 172.16/12'],
    ['172.31.255.255', 'private 172.16/12 upper edge'],
    ['192.168.1.1', 'private 192.168/16'],
    ['169.254.169.254', 'cloud metadata (link-local)'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['192.0.0.1', 'IETF protocol assignments'],
    ['192.0.2.1', 'TEST-NET-1'],
    ['198.18.0.1', 'benchmarking'],
    ['224.0.0.1', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
    ['::', 'IPv6 unspecified'],
    ['::1', 'IPv6 loopback'],
    ['fc00::1', 'IPv6 unique local'],
    ['fd12:3456::1', 'IPv6 unique local'],
    ['fe80::1', 'IPv6 link-local'],
    ['fec0::1', 'IPv6 deprecated site-local'],
    ['ff02::1', 'IPv6 multicast'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ['::127.0.0.1', 'IPv4-compatible loopback'],
    ['2002:7f00:1::', '6to4 wrapping 127.0.0.1'],
    ['64:ff9b::7f00:1', 'NAT64 wrapping 127.0.0.1'],
    ['2001::1', 'Teredo'],
    ['2001:db8::1', 'IPv6 documentation'],
    ['100::1', 'IPv6 discard'],
  ])('blocks %s (%s)', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['', 'localhost', '999.1.1.1', '1.2.3', 'fe80::1%eth0', 'not-an-ip'])(
    'blocks unparseable input %j',
    (address) => {
      expect(isPublicAddress(address)).toBe(false);
    },
  );
});
