import type { Config } from '@react-router/dev/config';

/*
 * React Router framework mode. Every route is rendered on the server (in the
 * app's Worker) and then hydrated in the browser, so crawlers and link
 * previews read each page's own HTML, title and description.
 *
 *   appDirectory  the routes, root.tsx and the entry files live in src/
 *   buildDirectory  the build writes dist/client (assets) and dist/server (the Worker)
 */
export default {
  appDirectory: 'src',
  buildDirectory: 'dist',
  ssr: true,
} satisfies Config;
