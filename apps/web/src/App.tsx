import { ImageApiError, ImageClient } from '@image-service/sdk';
import type { FieldError, ProcessResult } from '@image-service/sdk';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { Controls } from './components/Controls';
import { ErrorBanner } from './components/ErrorBanner';
import { ImagePanel } from './components/ImagePanel';
import { RequestBar } from './components/RequestBar';
import { EXTENSIONS, formatBytes, outputFilename, sizeChange, toOptions } from './lib/format';
import type { FormState } from './lib/format';
import { formFromQuery, queryFromForm } from './lib/url-state';

/** Where the bytes actually came from; the browser's HTTP cache never reaches the server. */
type ServedFrom = 'browser' | 'server' | 'fresh';

const SERVED_FROM_LABEL: Record<ServedFrom, string> = {
  browser: 'Browser cache',
  server: 'Server cache',
  fresh: 'Freshly processed',
};

interface Done {
  result: ProcessResult;
  objectUrl: string;
  sourceUrl: string;
  elapsedMs: number;
  servedFrom: ServedFrom;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; done: Done }
  | { kind: 'error'; error: ImageApiError };

const defaultClient = new ImageClient({ baseUrl: import.meta.env.VITE_API_BASE_URL ?? '' });

/** Validate the form with the SDK (same rules as the server) without sending anything. */
function preview(client: ImageClient, form: FormState): { url?: string; errors: FieldError[] } {
  if (form.url.trim() === '') return { errors: [] };
  try {
    return { url: client.url(toOptions(form)), errors: [] };
  } catch (error) {
    if (ImageApiError.is(error)) return { errors: error.errors };
    throw error;
  }
}

const absolute = (url: string) => new URL(url, window.location.href).href;

/**
 * Resource Timing reports transferSize 0 for responses served from the HTTP
 * cache. Without timing data, fall back to the server's X-Cache header.
 */
function servedFrom(result: ProcessResult): ServedFrom {
  const entries = performance.getEntriesByName(absolute(result.url));
  const timing = entries.at(-1) as PerformanceResourceTiming | undefined;
  if (timing && timing.transferSize === 0 && timing.decodedBodySize > 0) return 'browser';
  return result.cache === 'HIT' ? 'server' : 'fresh';
}

/** Matches the single-column breakpoint in styles.css. */
const NARROW_LAYOUT = '(max-width: 960px)';

export function App({ client = defaultClient }: { client?: ImageClient }) {
  // The page URL mirrors the form, so links are shareable and reload/back/forward work.
  const [form, setForm] = useState<FormState>(() => formFromQuery(window.location.search));
  // A shared link with a valid request starts out loading; the mount effect fetches it.
  const [status, setStatus] = useState<Status>(() =>
    preview(client, form).url && window.location.search ? { kind: 'loading' } : { kind: 'idle' },
  );
  // Last successful result stays on screen while a new request loads or after an error.
  const [last, setLast] = useState<Done>();
  const inFlight = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  // True while the current history entry is a processed (or landing) state: the next
  // edit pushes a new entry so Back returns here; later edits just replace it.
  const historyCommitted = useRef(true);

  const { url: requestUrl, errors: clientErrors } = useMemo(
    () => preview(client, form),
    [client, form],
  );

  const serverErrors = status.kind === 'error' ? status.error.errors : [];
  const fieldErrors = Object.fromEntries(
    [...clientErrors, ...serverErrors].map((e) => [e.param, e.message] as const),
  );

  // Free the previous blob URL whenever it is replaced, and on unmount.
  const objectUrl = last?.objectUrl;
  useEffect(() => {
    if (!objectUrl) return;
    return () => URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  useEffect(() => () => inFlight.current?.abort(), []);

  // On narrow screens results render below the form; bring them into view when they arrive.
  useEffect(() => {
    if (!objectUrl || !window.matchMedia?.(NARROW_LAYOUT).matches) return;
    resultsRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [objectUrl]);

  const update = (patch: Partial<FormState>) => {
    setForm((current) => ({ ...current, ...patch }));
    if (status.kind === 'error') setStatus({ kind: 'idle' });
  };

  /** Fetch and show a result. State is only set after the first await (safe from effects). */
  const execute = async (target: FormState, controller: AbortController) => {
    const options = toOptions(target);
    const started = performance.now();
    try {
      const result = await client.process(options, { signal: controller.signal });
      const done: Done = {
        result,
        objectUrl: URL.createObjectURL(result.blob),
        sourceUrl: options.url,
        elapsedMs: Math.round(performance.now() - started),
        servedFrom: servedFrom(result),
      };
      setLast(done);
      setStatus({ kind: 'done', done });
    } catch (error) {
      if (controller.signal.aborted) return;
      setStatus({
        kind: 'error',
        error: ImageApiError.is(error)
          ? error
          : new ImageApiError({
              code: 'UNEXPECTED_RESPONSE',
              message: String(error),
              cause: error,
            }),
      });
    }
  };

  const startRequest = () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    historyCommitted.current = true;
    return controller;
  };

  const run = (target: FormState = form) => {
    const controller = startRequest();
    setStatus({ kind: 'loading' });
    void execute(target, controller);
  };

  // Back/Forward: show the transformation described by the restored page URL.
  const onHistoryNavigation = useEffectEvent(() => {
    const next = formFromQuery(window.location.search);
    historyCommitted.current = true;
    setForm(next);
    if (preview(client, next).url) {
      run(next);
    } else {
      inFlight.current?.abort();
      setStatus({ kind: 'idle' });
    }
  });

  // First load from a shared link: canonicalise the address and fetch it. The form and the
  // initial 'loading' status were already derived from the URL during the first render.
  const loadSharedLink = useEffectEvent(() => {
    const canonical = `${window.location.pathname}${queryFromForm(form)}`;
    window.history.replaceState(window.history.state, '', canonical);
    if (status.kind === 'loading') void execute(form, startRequest());
  });

  useEffect(() => {
    // False positive: loadSharedLink only sets state after awaiting the fetch (see execute).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadSharedLink();
    const onPopState = () => onHistoryNavigation();
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Mirror edits into the address bar. Declared after the effect above so a shared link is
  // canonicalised (replace) before this compares it, instead of pushing a duplicate entry.
  useEffect(() => {
    const query = queryFromForm(form);
    if (query === window.location.search) return;
    const url = `${window.location.pathname}${query}`;
    if (historyCommitted.current) {
      window.history.pushState(null, '', url);
      historyCommitted.current = false;
    } else {
      window.history.replaceState(null, '', url);
    }
  }, [form]);

  const loading = status.kind === 'loading';
  const showComparison = Boolean(last) || loading;
  // After a failed first attempt the banner is the focus; the getting-started card would be noise.
  const showEmptyState = !showComparison && status.kind !== 'error';
  const result = last?.result;
  const source = result?.source;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <div>
            <h1>Image Processing API</h1>
            <p className="tagline">Resize and convert any public image by URL.</p>
          </div>
        </div>
        <nav className="links" aria-label="API reference">
          <a href="/docs/">API docs</a>
          <a href="/openapi.json">OpenAPI</a>
        </nav>
      </header>

      <main className="layout">
        <Controls
          form={form}
          fieldErrors={fieldErrors}
          canSubmit={Boolean(requestUrl) && !loading}
          loading={loading}
          onChange={update}
          onSubmit={() => run()}
        />

        <div className="workspace">
          <RequestBar
            url={requestUrl ? absolute(requestUrl) : undefined}
            filename={outputFilename(form)}
            hint={
              clientErrors.length > 0
                ? 'Fix the highlighted fields to see the exact API request.'
                : 'Enter an image URL to see the exact API request.'
            }
          />

          {status.kind === 'error' && <ErrorBanner error={status.error} onRetry={() => run()} />}

          <p className="status" role="status">
            {loading && 'Processing image…'}
            {status.kind === 'done' &&
              `Done in ${status.done.elapsedMs} ms · ${SERVED_FROM_LABEL[status.done.servedFrom].toLowerCase()}`}
          </p>

          {showEmptyState && (
            <div className="card empty">
              <div className="empty-art" aria-hidden="true" />
              <h2>Paste an image URL to get started</h2>
              <p>
                Or pick a sample on the left. Set a size, format and quality, then press{' '}
                <strong>Process image</strong> to compare the original and the result side by side.
              </p>
            </div>
          )}

          {showComparison && (
            <div className="comparison" ref={resultsRef}>
              <ImagePanel
                title="Original"
                src={last?.sourceUrl}
                alt="Original source image"
                noReferrer
                loading={loading && !last}
                placeholder="The original appears here after processing."
                facts={[
                  source?.width && source.height ? `${source.width} × ${source.height}` : undefined,
                  source?.format.toUpperCase(),
                  source?.bytes !== undefined ? formatBytes(source.bytes) : undefined,
                ]}
              />
              <ImagePanel
                title="Processed"
                src={last?.objectUrl}
                alt="Processed image"
                loading={loading}
                placeholder="The processed image appears here."
                facts={[
                  result?.width && result.height ? `${result.width} × ${result.height}` : undefined,
                  result?.format.toUpperCase(),
                  result ? formatBytes(result.bytes) : undefined,
                  result ? sizeChange(source?.bytes, result.bytes) : undefined,
                ]}
                badges={
                  last && (
                    <span className={`badge ${last.servedFrom === 'fresh' ? '' : 'badge-ok'}`}>
                      {SERVED_FROM_LABEL[last.servedFrom]}
                    </span>
                  )
                }
                actions={
                  last &&
                  result && (
                    <a
                      className="ghost button-link"
                      href={last.objectUrl}
                      download={`processed.${EXTENSIONS[result.format]}`}
                    >
                      Download
                    </a>
                  )
                }
              />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
