import { hc } from 'hono/client';
import type { AppType } from '../server';
import { loggedFetch } from './fetch';

/*
 * Typed client for this app's own `/api/*` routes: request bodies, params and
 * JSON responses are checked against the Hono routes in `src/server/`. A
 * failed answer is logged with its body (`loggedFetch`).
 *
 *   const res = await api.api.health.$get();
 *   const data = await res.json();
 *
 * Browser only (an event handler, an effect, a clientLoader, TanStack Query):
 * its addresses are relative to the page. A loader runs on the server and
 * reads its data directly, not through /api/*.
 *
 * Keep the server import type-only: the browser must never load server code.
 */
export const api = hc<AppType>('/', { fetch: loggedFetch });
