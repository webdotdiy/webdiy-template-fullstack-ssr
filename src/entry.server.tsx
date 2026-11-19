import type { EntryContext, HandleErrorFunction } from 'react-router';
import { isRouteErrorResponse, ServerRouter } from 'react-router';
import { isbot } from 'isbot';
import { renderToReadableStream } from 'react-dom/server';

/*
 * Renders each page on the server. A crawler or link-preview bot gets the
 * whole page in one answer (`allReady`); a browser gets the shell at once and
 * the rest as it streams.
 */
export const streamTimeout = 5_000;

/*
 * Errors from loaders, actions and renders go to the server's log. A path no
 * route matches is a 404 the page already explains, and a request the browser
 * cancelled is no error, so neither is logged.
 */
export const handleError: HandleErrorFunction = (error, { request }) => {
  if (request.signal.aborted || (isRouteErrorResponse(error) && error.status === 404)) {
    return;
  }

  console.error(error);
};

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  let shellRendered = false;
  const userAgent = request.headers.get('user-agent');

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      signal: AbortSignal.timeout(streamTimeout + 1_000),
      onError(error: unknown) {
        responseStatusCode = 500;

        // Errors before the shell rendered are reported by the rejected promise.
        if (shellRendered) {
          console.error(error);
        }
      },
    },
  );

  shellRendered = true;

  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set('Content-Type', 'text/html');

  return new Response(body, { headers: responseHeaders, status: responseStatusCode });
}
