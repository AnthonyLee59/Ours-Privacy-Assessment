/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional API origin when the UI is hosted separately; defaults to same origin. */
  readonly VITE_API_BASE_URL?: string;
}
