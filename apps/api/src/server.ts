import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

/** Inbound limits so slow or idle clients cannot hold sockets open indefinitely. */
export const SERVER_TIMEOUTS = {
  headersMs: 10_000,
  requestMs: 30_000,
  keepAliveMs: 5_000,
} as const;

export interface RunningServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export async function startServer(
  app: Express,
  { host, port }: { host: string; port: number },
): Promise<RunningServer> {
  const server = app.listen(port, host);
  server.headersTimeout = SERVER_TIMEOUTS.headersMs;
  server.requestTimeout = SERVER_TIMEOUTS.requestMs;
  server.keepAliveTimeout = SERVER_TIMEOUTS.keepAliveMs;

  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    server,
    url: `http://${address.address}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Drop idle keep-alive sockets so close() does not wait for them to time out.
        server.closeIdleConnections();
      }),
  };
}
