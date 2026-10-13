import type { LookupAddress } from 'node:dns';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isPublicAddress } from '../../src/security/ip-policy.js';
import { createPinnedLookup } from '../../src/security/pinned-lookup.js';

/**
 * Scriptable fake "internet" for fetcher tests: one local HTTP server reached
 * through fake hostnames resolved by a fake DNS.
 *
 *   img.test     -> 127.0.0.1 (the test server; loopback allowed for this host only)
 *   evil.test    -> 169.254.169.254 (cloud metadata; must be blocked)
 *   nxdomain.test -> no records
 *   hang.test    -> DNS never answers
 */
export interface Upstream {
  port: number;
  /** Base URL for the test server via its fake public hostname. */
  base: string;
  lastRequestHeaders: IncomingHttpHeaders | undefined;
  /** Whether the server saw its response torn down before it finished writing. */
  abortedResponses: string[];
  routes: Map<string, (res: ServerResponse) => void>;
  close(): Promise<void>;
}

export const TEST_LOOPBACK = '127.0.0.1';

const DNS: Record<string, LookupAddress[]> = {
  'img.test': [{ address: TEST_LOOPBACK, family: 4 }],
  'evil.test': [{ address: '169.254.169.254', family: 4 }],
  'nxdomain.test': [],
};

export const testLookup = createPinnedLookup({
  resolve: (hostname) =>
    hostname === 'hang.test' ? new Promise(() => {}) : Promise.resolve(DNS[hostname] ?? []),
  // Same policy as production, plus loopback so tests can reach the local server.
  isAllowed: (address) => address === TEST_LOOPBACK || isPublicAddress(address),
});

export async function startUpstream(port = 0): Promise<Upstream> {
  const routes = new Map<string, (res: ServerResponse) => void>();
  const upstream: Upstream = {
    port: 0,
    base: '',
    lastRequestHeaders: undefined,
    abortedResponses: [],
    routes,
    close: () => Promise.resolve(),
  };

  const server = createServer((req, res) => {
    upstream.lastRequestHeaders = req.headers;
    const path = req.url ?? '/';
    res.on('close', () => {
      if (!res.writableFinished) upstream.abortedResponses.push(path);
    });
    const handler = routes.get(path);
    if (handler) {
      handler(res);
    } else {
      res.writeHead(404).end('not found');
    }
  });

  await new Promise<void>((resolve) => server.listen(port, TEST_LOOPBACK, resolve));
  upstream.port = (server.address() as AddressInfo).port;
  upstream.base = `http://img.test:${upstream.port}`;
  upstream.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return upstream;
}

/** A port with nothing listening on it. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, TEST_LOOPBACK, resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
