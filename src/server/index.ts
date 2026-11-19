import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createRequestHandler } from 'react-router';
import { handleNeonAuth, type NeonAuthBindings } from './neon-auth';

/*
 * Binding types stay structural (no Workers-only globals such as `Fetcher`):
 * the browser program type-checks this file through `import type { AppType }`
 * in `src/lib/api.ts`.
 */
type Bindings = NeonAuthBindings & {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
};

/*
 * Routes are chained off `new Hono()` so `AppType` carries every route's input
 * and output types to the typed client in `src/lib/api.ts`. A route registered
 * in a separate `app.get(...)` statement is invisible to the client types.
 *
 * Add routes as modules under `src/server/routes/` and chain them here:
 *   .route('/api/todos', todos)
 *
 * Neon Auth first-party proxy — sessions live as host-only cookies on THIS
 * origin. Answers 501 until the project's database/auth is provisioned.
 * Protect your own routes with `verifyAuthToken` from `./neon-auth/require-user`.
 */
const app = new Hono<{ Bindings: Bindings }>()
  .use('/api/*', cors())
  .get('/api/health', (c) => c.json({ ok: true }))
  .all('/api/auth/*', (c) => handleNeonAuth(c.req.raw, c.env));

/*
 * A thrown error in an /api/* route: the stack goes to the dev server's log,
 * and only the dev server's answer carries it. A published app answers a
 * generic 500. An error on any other path is thrown on.
 */
app.onError((err, c) => {
  // A page's error is React Router's and the dev server's to show; only /api/* answers JSON.
  if (!new URL(c.req.url).pathname.startsWith('/api/')) {
    throw err;
  }

  console.error(`[api] ${c.req.method} ${new URL(c.req.url).pathname} failed:`, err);

  if (import.meta.env.DEV) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined },
      500,
    );
  }

  return c.json({ error: 'Internal Server Error' }, 500);
});

// An /api/* path no route matches is a JSON 404, never a page.
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

/*
 * Every other path is a page: React Router renders it on the server. Loaders
 * and actions read bindings with `import { env } from 'cloudflare:workers'`;
 * no load context is passed (React Router 8 refuses a plain object here).
 */
const renderPage = createRequestHandler(() => import('virtual:react-router/server-build'), import.meta.env.MODE);

app.all('*', (c) => renderPage(c.req.raw));

export type AppType = typeof app;
export default app;
