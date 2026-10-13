import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const REQUEST_ID_HEADER = 'X-Request-Id';

// Accept ids from upstream proxies only if they cannot smuggle anything into logs or headers.
const SAFE_REQUEST_ID = /^[\w.-]{1,128}$/;

/** Reuse a safe inbound X-Request-Id (for tracing across hops) or mint a new one, and echo it back. */
export function assignRequestId(req: IncomingMessage, res: ServerResponse): string {
  const inbound = req.headers['x-request-id'];
  const id = typeof inbound === 'string' && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}
