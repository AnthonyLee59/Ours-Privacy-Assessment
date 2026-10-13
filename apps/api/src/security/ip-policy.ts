import ipaddr from 'ipaddr.js';

/**
 * True only for globally routable unicast addresses.
 *
 * This is an allowlist: anything ipaddr.js classifies as other than plain
 * `unicast` (private, loopback, link-local/cloud metadata, CGNAT, reserved,
 * multicast, and IPv6 transition ranges such as 6to4, Teredo and NAT64 that
 * can embed an internal IPv4 address) is refused. IPv4-mapped IPv6 addresses
 * are unwrapped and judged as IPv4.
 */
export function isPublicAddress(address: string): boolean {
  // Strict parsing: reject shorthand IPv4 like "1.2.3" that ipaddr.js would otherwise accept.
  const valid = ipaddr.IPv4.isValidFourPartDecimal(address) || ipaddr.IPv6.isValid(address);
  if (!valid) return false;
  return ipaddr.process(address).range() === 'unicast';
}

/** True if the string is an IP address literal (dotted-quad IPv4 or IPv6 without brackets). */
export function isIpLiteral(host: string): boolean {
  return ipaddr.IPv4.isValidFourPartDecimal(host) || ipaddr.IPv6.isValid(host);
}
