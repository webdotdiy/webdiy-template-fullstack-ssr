# webdiy-template-fullstack-ssr

A WebDIY starter: React Router 8 in framework mode, with every page rendered on the server, and Hono for `/api/*`, in one Cloudflare Worker. Vite + React 19 + TypeScript + Tailwind 4, built and served through `@cloudflare/vite-plugin`.

Every page is rendered on the server and then hydrated in the browser, so crawlers and link previews read each page's own HTML, title and description.

## Stack

- **Pages:** React Router 8 framework mode. Routes are listed in `src/routes.ts`; each route module can export a `loader` (its data, read on the server), an `action`, a `meta` (its title and description) and its component. Import from `react-router` only.
- **API:** Hono on the same Worker, at `/api/*` ([src/server/index.ts](src/server/index.ts)).
- **Database + auth:** Neon Postgres (Data API) and Neon Auth through a first-party proxy at `/api/auth/*`, pre-wired and inert until the project's database is turned on (see "Neon" below).
- **UI:** Tailwind 4, Radix Primitives, cva, motion; five base components in [src/components/ui/](src/components/ui) (Button, Input, Card, Dialog, Dropdown).
- **Forms:** React Hook Form + Zod. **Browser-side server state:** TanStack Query.

## Commands

```bash
pnpm install
pnpm dev         # vite: the dev server, pages and /api/* together
pnpm build       # react-router typegen, tsc -b, react-router build -> dist/client + dist/server
pnpm check       # react-router typegen, tsc -b, eslint
pnpm lint        # eslint
pnpm deploy      # build, then wrangler deploy
pnpm cf-typegen  # wrangler types: regenerate the binding types
```

## How a request is answered

1. A file in `dist/client` (scripts, styles, `public/`) is served as it is.
2. `/api/*` reaches the Hono routes. An `/api/*` path no route matches answers a JSON 404.
3. Every other path is a page: React Router renders it on the server. A path no route matches answers 404 with `root.tsx`'s error page.

`wrangler.toml` keeps `not_found_handling = "none"`: the build has no `index.html` to fall back to.

## Where things go

- [src/root.tsx](src/root.tsx): the document every page renders into, and the error page. Keep it small: an edit to it resets the page's state in the dev server.
- [src/routes.ts](src/routes.ts) and [src/routes/](src/routes): the pages. [src/routes/home.tsx](src/routes/home.tsx) is the starter page, to be replaced.
- [src/entry.server.tsx](src/entry.server.tsx): renders each page on the server (bots get the whole page at once, browsers a stream).
- [src/server/](src/server): the Worker. `index.ts` chains the `/api/*` routes; put each resource's routes in `src/server/routes/` and chain them with `.route('/api/<name>', module)`. [src/server/routes/example-server-write.ts](src/server/routes/example-server-write.ts) shows a privileged write (not mounted).
- [src/server/env.ts](src/server/env.ts): `requireEnv`, which reads a binding and names its fix when it is missing.
- [src/lib/api.ts](src/lib/api.ts): the typed client for `/api/*` (browser only). [src/lib/fetch.ts](src/lib/fetch.ts): `loggedFetch`, which logs a failed answer with its body.
- [src/lib/neon-auth.ts](src/lib/neon-auth.ts) and [src/lib/neon-data.ts](src/lib/neon-data.ts): the browser's auth client and the Data API client.
- [src/features/](src/features), [src/hooks/](src/hooks), [src/lib/](src/lib): app code by feature, shared hooks, helpers.
- [src/index.css](src/index.css): the design tokens. Replace the placeholder palette before building components; components read semantic tokens (`bg-primary`, `text-foreground`, `border-border`).
- [migrations/](migrations): the app's SQL migrations.
- [vite.config.ts](vite.config.ts): uses `@webdiy/starter-vite-preset`, which registers `@cloudflare/vite-plugin` and keeps the WebDIY preview working. Don't replace it with Vite's own `defineConfig`.

## Rules this shape needs

- **Bindings** (secrets, the database URL): `import { env } from 'cloudflare:workers'` in loaders, actions and server code, each read with `requireEnv(env, 'DATABASE_URL')` from `src/server/env.ts` (in a route module a binding's value has no type). There is no load context (`context.cloudflare` throws in React Router 8; lint refuses it).
- **Browser-only code** (`window`, `localStorage`, the auth client) runs in effects, event handlers or a `clientLoader`, never during render. Nothing random or time-based in what a page renders: the server's HTML and the browser's first render must match.
- **A page's public data** comes from its route `loader`; a signed-in user's own data loads in the browser (see `src/lib/neon-auth.ts`). A page's title and description come from its `meta` export (`meta` receives `loaderData`). Long lists are paginated: a page is rendered within the Worker's CPU allowance.

## Neon (the database and sign-in)

On WebDIY, turning on the project's database provisions a Neon Postgres database and Neon Auth: `VITE_NEON_AUTH_URL`, `VITE_NEON_JWKS_URL` and `VITE_NEON_DATA_API_URL` arrive in `.env` (public addresses), and `NEON_AUTH_COOKIE_SECRET` and `DATABASE_URL` reach the Worker as bindings. Until then `/api/auth/*` answers 501.

- **Sign-in:** `src/lib/neon-auth.ts` is safe to import from any route: the auth client is loaded in the browser only, on first use. In a component, `useAuthSession()` gives the session (signed out and pending on the server and during hydration); in an event handler, `const auth = await getAuthClient()`, then `auth.signIn.email(...)`, `auth.signUp.email(...)`, `auth.signOut()`. Sessions are first-party, host-only cookies on the app's own address.
- **User data:** the Data API (`createDataClient()` in `src/lib/neon-data.ts`, in the browser) with the signed-in user's token; Postgres row-level security decides what each user may read and write. A page signed-out visitors and crawlers read gets its data in its `loader`, through `DATABASE_URL`: `neon(requireEnv(env, 'DATABASE_URL'))` (a whole loader is in `src/lib/neon-data.ts`'s notes).
- **Writes row-level security can't express:** a Hono route that checks the caller (`await verifyAuthToken(c.req.raw)`), validates the body and writes with `DATABASE_URL`, as `src/server/routes/example-server-write.ts` shows.

Outside WebDIY, `.env.example` lists every name: put the public addresses in `.env`, the secrets in `.dev.vars`, and `wrangler secret put` each secret before the first deploy.

`src/server/neon-auth/vendor/` is Neon's proxy code, kept as it is (see its README).

## Licence

The starter code this project began from is under the MIT licence ([LICENSE](LICENSE)). The vendored auth proxy in [src/server/neon-auth/vendor/](src/server/neon-auth/vendor) is from Neon's `neon-js` repository, under the Apache License 2.0 ([its licence](src/server/neon-auth/vendor/LICENSE)).

The UI components in src/components/ui/ are adapted from shadcn/ui (MIT, Copyright (c) 2023 shadcn).
