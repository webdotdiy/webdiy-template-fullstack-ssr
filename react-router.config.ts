import type { Config } from '@react-router/dev/config';

/*
 * React Router framework mode. Every route is rendered on the server (in the
 * app's Worker) and then hydrated in the browser, so crawlers and link
 * previews read each page's own HTML, title and description.
 *
 *   appDirectory  the routes, root.tsx and the entry files live in src/
 *   buildDirectory  the build writes dist/client (assets) and dist/server (the Worker)
 *   splitRouteModules  keep it false: each route's clientLoader, clientAction
 *     and HydrateFallback stay in the route's own browser file. Split apart,
 *     the browser loads a route without its HydrateFallback, and the
 *     fallback's HTML from the server stays on the page above the route.
 */
export default {
  appDirectory: 'src',
  buildDirectory: 'dist',
  ssr: true,
  splitRouteModules: false,
} satisfies Config;
