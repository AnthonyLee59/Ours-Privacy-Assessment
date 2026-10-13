import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { SERVER_TIMEOUTS, startServer } from '../src/server.js';
import { silentLogger, testConfig } from './helpers.js';

describe('startServer', () => {
  it('listens, serves requests and closes cleanly', async () => {
    const app = createApp({ config: testConfig, logger: silentLogger });
    const running = await startServer(app, { host: '127.0.0.1', port: 0 });

    const res = await fetch(`${running.url}/healthz`);
    expect(res.status).toBe(200);

    await running.close();
    expect(running.server.listening).toBe(false);
  });

  it('applies inbound timeouts against slow clients', async () => {
    const app = createApp({ config: testConfig, logger: silentLogger });
    const running = await startServer(app, { host: '127.0.0.1', port: 0 });

    expect(running.server.headersTimeout).toBe(SERVER_TIMEOUTS.headersMs);
    expect(running.server.requestTimeout).toBe(SERVER_TIMEOUTS.requestMs);
    expect(running.server.keepAliveTimeout).toBe(SERVER_TIMEOUTS.keepAliveMs);

    await running.close();
  });

  it('rejects when the port is unavailable', async () => {
    const app = createApp({ config: testConfig, logger: silentLogger });
    const first = await startServer(app, { host: '127.0.0.1', port: 0 });
    const port = Number(new URL(first.url).port);

    await expect(startServer(app, { host: '127.0.0.1', port })).rejects.toThrow(/EADDRINUSE/);
    await first.close();
  });
});
