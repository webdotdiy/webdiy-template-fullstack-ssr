/*
 * `fetch`, with one addition: a failed answer (status 400 or above) is logged
 * with its method, address, status and the first 500 characters of its body,
 * so a failed POST, PUT or DELETE shows why in the browser's console. The
 * answer itself is returned untouched.
 *
 *   const res = await loggedFetch('/api/todos', { method: 'POST', body });
 *
 * The typed client in `src/lib/api.ts` sends through it already.
 */
export async function loggedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);

  if (!res.ok) {
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = await res
      .clone()
      .text()
      .catch(() => '');

    console.error(`[fetch] ${method} ${url} -> ${res.status}: ${body.slice(0, 500)}`);
  }

  return res;
}
