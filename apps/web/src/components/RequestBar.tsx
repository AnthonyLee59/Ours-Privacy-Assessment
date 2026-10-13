import { useEffect, useState } from 'react';
import { curlCommand } from '../lib/format';

type Copied = 'url' | 'curl' | 'failed' | null;

/** The exact GET request the UI will send, with one-click copy as URL or curl. */
/** `hint` explains why there is no URL yet (nothing entered vs. invalid fields). */
export function RequestBar({
  url,
  hint,
  filename,
}: {
  url: string | undefined;
  hint: string;
  /** Local file name used in the curl snippet. */
  filename: string;
}) {
  const [copied, setCopied] = useState<Copied>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async (kind: 'url' | 'curl') => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(kind === 'url' ? url : curlCommand(url, filename));
      setCopied(kind);
    } catch {
      // Clipboard API is unavailable on insecure origins or when permission is denied.
      setCopied('failed');
    }
  };

  return (
    <section className="card request" aria-labelledby="request-heading">
      <div className="request-head">
        <h2 id="request-heading">
          <span className="method">GET</span> Request
        </h2>
        <div className="request-actions">
          <button type="button" className="ghost" disabled={!url} onClick={() => void copy('url')}>
            {copied === 'url' ? 'Copied!' : 'Copy URL'}
          </button>
          <button type="button" className="ghost" disabled={!url} onClick={() => void copy('curl')}>
            {copied === 'curl' ? 'Copied!' : 'Copy curl'}
          </button>
        </div>
      </div>
      <label className="visually-hidden" htmlFor="request-url">
        Request URL
      </label>
      {/* Read-only textarea: selectable for manual copy, and not a live region (no announcements per keystroke). */}
      <textarea
        id="request-url"
        className="request-url"
        readOnly
        rows={2}
        spellCheck={false}
        value={url ?? ''}
        placeholder={hint}
        onFocus={(e) => e.currentTarget.select()}
      />
      {copied === 'failed' && (
        <p className="help">Copy is blocked here; select the URL above and copy it manually.</p>
      )}
    </section>
  );
}
