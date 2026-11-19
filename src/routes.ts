import { type RouteConfig, index } from '@react-router/dev/routes';

/*
 * Every page of the app, in one list. Add a page with
 *   route('about', 'routes/about.tsx'),
 * and nested pages with layout() and prefix() from '@react-router/dev/routes'.
 * A path no route matches answers 404 through root.tsx's ErrorBoundary.
 */
export default [index('routes/home.tsx')] satisfies RouteConfig;
