# Vendored: Neon Auth first-party proxy core

Vendored from [`neondatabase/neon-js`](https://github.com/neondatabase/neon-js)
at commit `186ac6b` (`@neondatabase/auth@0.4.2-beta`), `packages/auth/src/server/`,
under the Apache License 2.0: its text is in [LICENSE](LICENSE) beside this file.

**Why vendored:** the framework-agnostic proxy core (`handleAuthProxyRequest`)
runs on Cloudflare Workers, but the package's only server export is
`@neondatabase/auth/next/server`, which hard-imports `next/headers` /
`next/server` and cannot resolve outside Next.js. Neon's roadmap lists a
standalone server entry — when it ships, replace this directory with the
package import and delete the vendor copy.

**What changed vs upstream (mechanical only):**

- `@/server/…` path aliases rewritten to relative imports.
- `@/types` and `@/core/better-auth-types` (type-only imports) point at
  `./shims.ts`, a local reduction of those two files.
- Test files, the Next adapter, `client-factory`, and `middleware/` are not
  vendored (not needed by the proxy path).

**Which files are which:**

- Changed (their import paths only; each starts with a line saying so):
  `endpoints.ts`, `proxy/request.ts`, `proxy/response.ts`,
  `session/cache-handler.ts`, `session/operations.ts`,
  `session/validator.ts`, `types.ts`.
- As upstream has them: `config.ts`, `constants.ts`, `errors.ts`,
  `logger.ts`, `network-error.ts`, `proxy/handler.ts`, `proxy/index.ts`,
  `session/index.ts`, `session/minting.ts`, `utils/cookies.ts`.
- This template's own: `shims.ts`, `globals.d.ts`, this README and the lines
  above the line in `LICENSE`.

Runtime dependencies: `better-auth` (pinned to the version the source repo
pins) and `jose` — both declared in the template's `package.json`.

Do not hand-edit these files; re-vendor from a newer upstream commit instead
(copy the same file list, re-apply the three rewrites above with each changed
file's first line, and copy that commit's `LICENSE` below the line in
`LICENSE`).
