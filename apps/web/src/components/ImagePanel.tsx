import { useState } from 'react';
import type { ReactNode } from 'react';

interface ImagePanelProps {
  title: string;
  src: string | undefined;
  alt: string;
  /** Load the image without sending a Referer (third-party sources). */
  noReferrer?: boolean;
  facts: (string | undefined)[];
  badges?: ReactNode;
  actions?: ReactNode;
  loading?: boolean;
  placeholder: string;
}

export function ImagePanel(props: ImagePanelProps) {
  const { title, src, alt, noReferrer, facts, badges, actions, loading, placeholder } = props;
  const [failedSrc, setFailedSrc] = useState<string>();
  const failed = src !== undefined && failedSrc === src;

  return (
    <section className="card panel" aria-label={title}>
      <header className="panel-head">
        <h3>{title}</h3>
        {badges}
      </header>
      <div className={`stage ${loading ? 'is-loading' : ''}`}>
        {loading && <div className="shimmer" aria-hidden="true" />}
        {!loading && src && !failed && (
          <img
            src={src}
            alt={alt}
            decoding="async"
            referrerPolicy={noReferrer ? 'no-referrer' : undefined}
            onError={() => setFailedSrc(src)}
          />
        )}
        {!loading && failed && (
          <p className="stage-note">Preview unavailable: the source does not allow embedding.</p>
        )}
        {!loading && !src && <p className="stage-note">{placeholder}</p>}
      </div>
      <ul className="facts">
        {facts.filter(Boolean).map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
      {actions && <div className="panel-actions">{actions}</div>}
    </section>
  );
}
