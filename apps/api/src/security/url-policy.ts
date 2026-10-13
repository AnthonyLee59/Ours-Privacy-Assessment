import { ApiError } from '../http/api-error.js';
import { isIpLiteral, isPublicAddress } from './ip-policy.js';

export interface UrlPolicy {
  /** Lower-case hostnames; `*.example.com` matches any subdomain. Empty means any public host. */
  allowedHosts: readonly string[];
  /** Extra ports beyond the defaults 80/443. Not exposed as config; exists for tests. */
  allowedPorts?: readonly string[];
}

/** Special-use and conventional private DNS suffixes that never point at the public internet. */
const INTERNAL_SUFFIXES = ['localhost', 'local', 'internal', 'home.arpa', 'lan'];

function deny(detail: string): never {
  throw new ApiError('URL_NOT_ALLOWED', detail);
}

/** URL.hostname keeps IPv6 brackets and a trailing root dot; strip both for comparisons. */
function normaliseHost(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, '$1').replace(/\.+$/, '');
}

function isInternalHostname(host: string): boolean {
  // Single-label names (e.g. "metadata", "redis") resolve via local search domains.
  if (!host.includes('.')) return true;
  return INTERNAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function matchesAllowedHost(host: string, allowedHosts: readonly string[]): boolean {
  return allowedHosts.some((entry) =>
    entry.startsWith('*.') ? host.endsWith(entry.slice(1)) : host === entry,
  );
}

/**
 * Static checks on a source URL before any network activity. Called for the
 * requested URL and again for every redirect target. DNS-based checks happen
 * at connect time in the pinned lookup, which also covers DNS rebinding.
 *
 * @throws ApiError URL_NOT_ALLOWED with a caller-facing reason.
 */
export function assertAllowedSourceUrl(input: string | URL, policy: UrlPolicy): URL {
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    deny('The source url is not a valid URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    deny(`Only http and https URLs can be fetched (got "${url.protocol.slice(0, -1)}").`);
  }
  if (url.username || url.password) {
    deny('URLs with embedded credentials (user:password@) are not allowed.');
  }
  const ports = ['80', '443', ...(policy.allowedPorts ?? [])];
  if (url.port !== '' && !ports.includes(url.port)) {
    deny(
      `Only ports ${ports.join(', ').replace(/, (\d+)$/, ' and $1')} are allowed (got ${url.port}).`,
    );
  }

  const host = normaliseHost(url.hostname);
  if (isIpLiteral(host)) {
    if (!isPublicAddress(host)) {
      deny(`${host} is a private, loopback or reserved address and cannot be fetched.`);
    }
  } else if (isInternalHostname(host)) {
    deny(`${host} looks like an internal or single-label hostname and cannot be fetched.`);
  }

  if (policy.allowedHosts.length > 0 && !matchesAllowedHost(host, policy.allowedHosts)) {
    deny(`${host} is not in the list of allowed hosts for this deployment.`);
  }
  return url;
}
