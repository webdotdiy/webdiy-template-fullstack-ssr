/*
 * `cloudflare:workers` for the page program's type-check. Route modules run
 * on the server (loaders, actions) and in the browser (components), so they
 * are checked with the browser's types; this declares the one Workers module
 * a loader imports. Server code under src/server/ gets the full Workers types.
 */
declare module 'cloudflare:workers' {
  export const env: { readonly [binding: string]: unknown };
}
