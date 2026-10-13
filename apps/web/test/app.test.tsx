import { ImageClient } from '@image-service/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

const SRC = 'https://example.com/cat.png';

function imageResponse(headers: Record<string, string> = {}) {
  const body = new Uint8Array(4096);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'image/webp',
      'X-Cache': 'MISS',
      'X-Request-Id': 'req-1',
      'X-Source-Width': '1200',
      'X-Source-Height': '800',
      'X-Source-Format': 'png',
      'X-Source-Bytes': '54321',
      'X-Output-Width': '600',
      'X-Output-Height': '400',
      ...headers,
    },
  });
}

function problem(status: number, code: string, detail: string, extra: object = {}, headers = {}) {
  return new Response(
    JSON.stringify({
      type: `urn:image-service:problem:${code}`,
      title: 'Problem',
      status,
      detail,
      code,
      requestId: 'req-err',
      ...extra,
    }),
    { status, headers: { 'Content-Type': 'application/problem+json', ...headers } },
  );
}

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function setup(fetchImpl: FetchImpl = () => Promise.resolve(imageResponse())) {
  const fetch = vi.fn(fetchImpl);
  const user = userEvent.setup();
  render(<App client={new ImageClient({ fetch })} />);
  return { user, fetch };
}

const urlInput = () => screen.getByLabelText(/image url/i);
const processButton = () => screen.getByRole('button', { name: /process image/i });

// jsdom does not implement object URLs; record what the app creates and revokes.
const realCreate = URL.createObjectURL.bind(URL);
const realRevoke = URL.revokeObjectURL.bind(URL);
const revokeObjectURL = vi.fn<(url: string) => void>();

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:processed-${++n}`);
  URL.revokeObjectURL = revokeObjectURL;
});
afterEach(() => {
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
  revokeObjectURL.mockReset();
});

describe('empty state', () => {
  it('invites the user to paste a URL or pick a sample', () => {
    setup();
    expect(screen.getByText(/paste an image url/i)).toBeInTheDocument();
    expect(processButton()).toBeDisabled();
  });

  it('fills the URL from a sample', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: /sample: dog photo/i }));
    expect(urlInput()).toHaveValue('https://picsum.photos/id/237/1200/800.jpg');
    expect(processButton()).toBeEnabled();
  });
});

describe('request preview', () => {
  it('shows the exact absolute request URL as you type, before sending anything', async () => {
    const { user, fetch } = setup();
    await user.type(urlInput(), SRC);
    await user.type(screen.getByLabelText(/^width/i), '500');
    const expected = `${window.location.origin}/v1/process?url=${encodeURIComponent(SRC)}&width=500`;
    expect(screen.getByLabelText(/request url/i)).toHaveValue(expected);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('copies the URL and a curl snippet', async () => {
    const { user } = setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    await user.type(urlInput(), SRC);
    const expected = `${window.location.origin}/v1/process?url=${encodeURIComponent(SRC)}`;

    await user.click(screen.getByRole('button', { name: /copy url/i }));
    expect(writeText).toHaveBeenLastCalledWith(expected);
    expect(await screen.findByRole('button', { name: /copied/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /copy curl/i }));
    expect(writeText).toHaveBeenLastCalledWith(`curl -fo processed.png '${expected}'`);
  });
});

describe('client-side validation', () => {
  it('tells the user to fix fields (not the URL) when another field is invalid', async () => {
    const { user } = setup();
    await user.type(urlInput(), SRC);
    await user.type(screen.getByLabelText(/^width/i), '0');
    expect(screen.getByLabelText(/request url/i)).toHaveAttribute(
      'placeholder',
      expect.stringMatching(/fix the highlighted fields/i),
    );
  });

  it('flags invalid fields inline and blocks sending', async () => {
    const { user, fetch } = setup();
    await user.type(urlInput(), SRC);
    await user.type(screen.getByLabelText(/^width/i), '0');
    const width = screen.getByLabelText(/^width/i);
    expect(width).toHaveAccessibleDescription(/between 1 and 4000/);
    expect(width).toHaveAttribute('aria-invalid', 'true');
    expect(processButton()).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('explains crop modes that need both dimensions', async () => {
    const { user } = setup();
    await user.type(urlInput(), SRC);
    await user.type(screen.getByLabelText(/^width/i), '100');
    await user.selectOptions(screen.getByLabelText(/crop/i), 'fill');
    expect(screen.getByLabelText(/crop/i)).toHaveAccessibleDescription(/both width and height/);
  });

  it('disables quality for lossless formats and crop until a size is set', async () => {
    const { user } = setup();
    expect(screen.getByLabelText(/crop/i)).toBeDisabled();
    await user.type(screen.getByLabelText(/^height/i), '100');
    expect(screen.getByLabelText(/crop/i)).toBeEnabled();
    await user.selectOptions(screen.getByLabelText(/format/i), 'png');
    expect(screen.getByLabelText(/quality/i)).toBeDisabled();
  });
});

describe('processing', () => {
  it('shows loading, then original and processed side by side with details', async () => {
    let release!: (r: Response) => void;
    const { user } = setup(() => new Promise((resolve) => (release = resolve)));
    await user.type(urlInput(), SRC);
    await user.type(screen.getByLabelText(/^width/i), '600');
    await user.click(processButton());

    expect(processButton()).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent(/processing/i);

    release(imageResponse());
    const processed = await screen.findByRole('region', { name: /processed/i });
    const original = screen.getByRole('region', { name: /original/i });

    expect(within(original).getByRole('img')).toHaveAttribute('src', SRC);
    expect(within(original).getByRole('img')).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(original).toHaveTextContent('1200 × 800');
    expect(original).toHaveTextContent('PNG');
    expect(original).toHaveTextContent('53.0 KB');

    expect(within(processed).getByRole('img')).toHaveAttribute('src', 'blob:processed-1');
    expect(processed).toHaveTextContent('600 × 400');
    expect(processed).toHaveTextContent('WEBP');
    expect(processed).toHaveTextContent('4.0 KB');
    expect(processed).toHaveTextContent('−92%');
    expect(processed).toHaveTextContent(/freshly processed/i);
    expect(processButton()).not.toHaveAttribute('aria-busy', 'true');
  });

  it('offers a download of the processed file', async () => {
    const { user } = setup();
    await user.type(urlInput(), SRC);
    await user.click(processButton());
    const link = await screen.findByRole('link', { name: /download/i });
    expect(link).toHaveAttribute('href', 'blob:processed-1');
    expect(link).toHaveAttribute('download', 'processed.webp');
  });

  it('releases the previous object URL when a new result arrives', async () => {
    const { user } = setup();
    await user.type(urlInput(), SRC);
    await user.click(processButton());
    await screen.findByRole('region', { name: /processed/i });
    await user.click(processButton());
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:processed-1'));
  });
});

describe('errors', () => {
  it('surfaces server problems with code, message and request id, and marks the field', async () => {
    const { user } = setup(() =>
      Promise.resolve(
        problem(
          400,
          'URL_NOT_ALLOWED',
          '169.254.169.254 is a private address and cannot be fetched.',
          {
            errors: [{ param: 'url', message: 'Private addresses are not allowed' }],
          },
        ),
      ),
    );
    await user.type(urlInput(), 'http://169.254.169.254/latest');
    await user.click(processButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('URL_NOT_ALLOWED');
    expect(alert).toHaveTextContent(/private address/);
    expect(alert).toHaveTextContent('req-err');
    expect(urlInput()).toHaveAccessibleDescription(/private addresses are not allowed/i);
  });

  it('explains unsupported files', async () => {
    const { user } = setup(() =>
      Promise.resolve(
        problem(415, 'UNSUPPORTED_MEDIA_TYPE', 'The source URL returned an HTML document.'),
      ),
    );
    await user.type(urlInput(), 'https://example.com/');
    await user.click(processButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/HTML document/);
  });

  it('tells the user when to retry after a rate limit', async () => {
    const { user } = setup(() =>
      Promise.resolve(
        problem(429, 'RATE_LIMITED', 'Rate limit exceeded.', {}, { 'Retry-After': '42' }),
      ),
    );
    await user.type(urlInput(), SRC);
    await user.click(processButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/try again in 42s/i);
  });

  it('reports an unreachable API', async () => {
    const { user } = setup(() => Promise.reject(new TypeError('Failed to fetch')));
    await user.type(urlInput(), SRC);
    await user.click(processButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not reach the image api/i);
  });

  it('clears the error when the user edits the form', async () => {
    const { user } = setup(() => Promise.resolve(problem(502, 'SOURCE_FETCH_FAILED', 'HTTP 404')));
    await user.type(urlInput(), SRC);
    await user.click(processButton());
    await screen.findByRole('alert');
    await user.type(urlInput(), 'x');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('resilience', () => {
  it('explains when the original cannot be embedded (hotlink protection)', async () => {
    const { user } = setup();
    await user.type(urlInput(), SRC);
    await user.click(processButton());
    const original = await screen.findByRole('region', { name: /original/i });
    fireEvent.error(within(original).getByRole('img'));
    expect(original).toHaveTextContent(/preview unavailable/i);
  });

  it('falls back to manual copy when the clipboard is blocked', async () => {
    const { user } = setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    await user.type(urlInput(), SRC);
    await user.click(screen.getByRole('button', { name: /copy url/i }));
    expect(await screen.findByText(/copy it manually/i)).toBeInTheDocument();
  });

  it('includes quality in the request when set', async () => {
    const { user } = setup();
    await user.type(urlInput(), SRC);
    await user.selectOptions(screen.getByLabelText(/format/i), 'webp');
    await user.type(screen.getByLabelText(/quality/i), '55');
    expect(screen.getByLabelText(/request url/i)).toHaveValue(
      `${window.location.origin}/v1/process?url=${encodeURIComponent(SRC)}&format=webp&quality=55`,
    );
  });

  it('retries a retryable failure from the banner', async () => {
    let calls = 0;
    const { user } = setup(() =>
      Promise.resolve(
        ++calls === 1
          ? problem(503, 'SERVER_BUSY', 'Busy', {}, { 'Retry-After': '1' })
          : imageResponse(),
      ),
    );
    await user.type(urlInput(), SRC);
    await user.click(processButton());
    await user.click(await screen.findByRole('button', { name: /retry/i }));
    expect(await screen.findByRole('region', { name: /processed/i })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('selects the whole request URL on focus for easy manual copying', async () => {
    const { user } = setup();
    await user.type(urlInput(), SRC);
    const field = screen.getByLabelText<HTMLTextAreaElement>(/request url/i);
    await user.click(field);
    expect(field.selectionEnd - field.selectionStart).toBe(field.value.length);
  });
});

describe('layout behaviour', () => {
  it('hides the getting-started card once an error is shown', async () => {
    const { user } = setup(() =>
      Promise.resolve(problem(415, 'UNSUPPORTED_MEDIA_TYPE', 'Not an image')),
    );
    await user.type(urlInput(), SRC);
    await user.click(processButton());
    await screen.findByRole('alert');
    expect(screen.queryByText(/paste an image url/i)).not.toBeInTheDocument();
  });

  it('scrolls results into view on narrow screens, where they sit below the form', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width'),
      media: query,
    }));
    const { user } = setup();
    await user.type(urlInput(), SRC);
    await user.click(processButton());
    await screen.findByRole('region', { name: /processed/i });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    vi.unstubAllGlobals();
  });

  it('does not scroll on wide screens', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query }));
    const { user } = setup();
    await user.type(urlInput(), SRC);
    await user.click(processButton());
    await screen.findByRole('region', { name: /processed/i });
    expect(scrollIntoView).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('where the result came from', () => {
  function stubTiming(transferSize: number | undefined) {
    vi.spyOn(performance, 'getEntriesByName').mockImplementation(() =>
      transferSize === undefined
        ? []
        : ([{ transferSize, decodedBodySize: 4096 }] as unknown as PerformanceEntry[]),
    );
  }

  async function processOnce(headers: Record<string, string> = {}) {
    const { user } = setup(() => Promise.resolve(imageResponse(headers)));
    await user.type(urlInput(), SRC);
    await user.click(processButton());
    await screen.findByRole('region', { name: /processed/i });
  }

  it('says when the browser answered from its own HTTP cache', async () => {
    stubTiming(0);
    await processOnce();
    expect(screen.getByRole('status')).toHaveTextContent(/browser cache/i);
    expect(screen.getByRole('region', { name: /processed/i })).toHaveTextContent(/browser cache/i);
  });

  it('says when the server answered from its result cache', async () => {
    stubTiming(5000);
    await processOnce({ 'X-Cache': 'HIT' });
    expect(screen.getByRole('status')).toHaveTextContent(/server cache/i);
  });

  it('says when the image was freshly processed', async () => {
    stubTiming(5000);
    await processOnce({ 'X-Cache': 'MISS' });
    expect(screen.getByRole('status')).toHaveTextContent(/freshly processed/i);
  });

  it('falls back to the server header when timing data is unavailable', async () => {
    stubTiming(undefined);
    await processOnce({ 'X-Cache': 'HIT' });
    expect(screen.getByRole('status')).toHaveTextContent(/server cache/i);
  });
});

describe('shareable URLs and history', () => {
  const shared = `?url=${encodeURIComponent(SRC)}&width=600&format=webp`;

  it('restores the form from the page URL and processes it straight away', async () => {
    window.history.replaceState(null, '', `/${shared}`);
    const { fetch } = setup();
    expect(urlInput()).toHaveValue(SRC);
    expect(screen.getByLabelText(/^width/i)).toHaveValue(600);
    expect(screen.getByLabelText(/format/i)).toHaveValue('webp');
    await screen.findByRole('region', { name: /processed/i });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0] as string).toBe(`/v1/process${shared}`);
  });

  it('normalises a messy shared link in place, without adding a history entry', async () => {
    window.history.replaceState(null, '', `/?evil=1&width=600&url=${encodeURIComponent(SRC)}`);
    const before = window.history.length;
    setup();
    await screen.findByRole('region', { name: /processed/i });
    expect(window.location.search).toBe(`?url=${encodeURIComponent(SRC)}&width=600`);
    expect(window.history.length).toBe(before);
  });

  it('does not auto-process a link with invalid parameters, and shows why', () => {
    window.history.replaceState(null, '', `/?url=${encodeURIComponent(SRC)}&width=0`);
    const { fetch } = setup();
    expect(screen.getByLabelText(/^width/i)).toHaveAccessibleDescription(/between 1 and 4000/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('mirrors edits into the address bar without a history entry per keystroke', async () => {
    const { user } = setup();
    const before = window.history.length;
    await user.type(urlInput(), SRC);
    await user.type(screen.getByLabelText(/^width/i), '250');
    expect(window.location.search).toBe(`?url=${encodeURIComponent(SRC)}&width=250`);
    expect(window.history.length).toBe(before + 1);
  });

  it('goes back to the previously processed transformation', async () => {
    window.history.replaceState(null, '', `/${shared}`);
    const { user, fetch } = setup();
    await screen.findByRole('region', { name: /processed/i });

    const width = screen.getByLabelText(/^width/i);
    await user.clear(width);
    await user.type(width, '300');
    await user.click(processButton());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    window.history.back();
    await waitFor(() => expect(screen.getByLabelText(/^width/i)).toHaveValue(600));
    expect(window.location.search).toBe(shared);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(fetch.mock.calls[2]![0] as string).toBe(`/v1/process${shared}`);
  });

  it('going back to the empty landing page clears the form without a request', async () => {
    const { user, fetch } = setup();
    await user.type(urlInput(), SRC);
    await user.click(processButton());
    await screen.findByRole('region', { name: /processed/i });

    window.history.back();
    await waitFor(() => expect(urlInput()).toHaveValue(''));
    expect(window.location.search).toBe('');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(processButton()).toBeDisabled();
  });
});
