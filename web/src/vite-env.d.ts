/// <reference types="vite/client" />

/**
 * Typed `import.meta.env`.
 *
 * Only `VITE_`-prefixed variables are exposed to the bundle, and everything
 * here is public by definition — whatever is declared below ends up in
 * JavaScript the browser can read. No secrets, ever.
 */
interface ImportMetaEnv {
  /** API origin. Blank in development: the Vite proxy keeps us same-origin. */
  readonly VITE_API_URL?: string;
  /**
   * Shared password for the seeded demo accounts. When set, the login page
   * offers one-click sign-in for each role — the whole point of a review
   * deployment. Left unset, the accounts are still listed but nothing is
   * pre-filled.
   */
  readonly VITE_DEMO_PASSWORD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
