import { ApiError } from '../http/api-error.js';

export interface LimiterOptions {
  concurrency: number;
  /** Tasks allowed to wait for a slot; beyond this, callers get SERVER_BUSY immediately. */
  maxQueue: number;
}

export interface Limiter {
  run<T>(task: () => Promise<T>): Promise<T>;
  stats(): { active: number; queued: number };
}

const RETRY_AFTER_SECONDS = '2';

/**
 * Bounded concurrency with a bounded wait queue. Image work is CPU and memory
 * heavy; shedding load with a fast 503 keeps latency predictable instead of
 * letting every request slow down together.
 */
export function createLimiter({ concurrency, maxQueue }: LimiterOptions): Limiter {
  let active = 0;
  const waiting: (() => void)[] = [];

  const release = () => {
    active--;
    const next = waiting.shift();
    if (next) {
      active++;
      next();
    }
  };

  return {
    async run(task) {
      if (active >= concurrency) {
        if (waiting.length >= maxQueue) {
          throw new ApiError(
            'SERVER_BUSY',
            'The server is processing too many images right now. Retry shortly.',
            { headers: { 'Retry-After': RETRY_AFTER_SECONDS } },
          );
        }
        // The slot is handed over by release(), which increments `active` for us.
        await new Promise<void>((resolve) => waiting.push(resolve));
      } else {
        active++;
      }
      try {
        return await task();
      } finally {
        release();
      }
    },
    stats: () => ({ active, queued: waiting.length }),
  };
}
