import type { ImageApiError } from '@image-service/sdk';
import { ERROR_TITLES } from '../lib/content';

export function ErrorBanner({ error, onRetry }: { error: ImageApiError; onRetry: () => void }) {
  const title = ERROR_TITLES[error.code] ?? 'Something went wrong';
  return (
    <div className="banner" role="alert">
      <div className="banner-body">
        <p className="banner-title">
          {title} <code className="badge badge-error">{error.code}</code>
          {error.status !== undefined && <span className="badge">HTTP {error.status}</span>}
        </p>
        <p>{error.message}</p>
        {error.retryAfterSeconds !== undefined && <p>Try again in {error.retryAfterSeconds}s.</p>}
        {error.requestId && (
          <p className="banner-meta">
            Request ID: <code>{error.requestId}</code>
          </p>
        )}
      </div>
      {error.isRetryable && (
        <button type="button" className="ghost" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
