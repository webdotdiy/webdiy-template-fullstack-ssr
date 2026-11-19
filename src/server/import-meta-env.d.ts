/*
 * `import.meta.env` in worker code. Vite inlines VITE_-prefixed values from
 * `.env` into the worker bundle as it does for browser code (the worker is a
 * Vite environment under @cloudflare/vite-plugin). The worker tsconfig loads
 * vite/client's types, where a name they don't declare is `any`; this file
 * gives the three Neon values their real type, `string | undefined`, as
 * src/vite-env.d.ts does for browser code. Declare here any other VITE_
 * value server code reads.
 */
interface ImportMetaEnv {
  readonly VITE_NEON_AUTH_URL?: string;
  readonly VITE_NEON_JWKS_URL?: string;
  readonly VITE_NEON_DATA_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
