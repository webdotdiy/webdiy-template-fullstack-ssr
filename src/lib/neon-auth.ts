import { useSyncExternalStore } from 'react';

/*
 * Sign-in for the app's users, through this app's own `/api/auth/*` proxy,
 * never directly at the Neon Auth upstream. First-party cookies on the app's
 * origin are what make sessions work in every browser (Safari/ITP blocks the
 * third-party-cookie client-direct mode).
 *
 * Every page is also rendered on the server, where there is no browser
 * session and no page address for the client. So this module is safe to
 * import anywhere, a route module included: the auth SDK is loaded only in the
 * browser, on first use, and never when this module loads.
 *
 * Everything you need is here; there is no need to read the SDK in
 * node_modules.
 *
 *   In a component (it renders on the server too):
 *     const { data, isPending, error } = useAuthSession();
 *     // isPending: true on the server and until the browser has asked.
 *     // data: null when signed out; else { user, session }, with
 *     //   data.user.id (text, the same value as auth.user_id() in SQL),
 *     //   data.user.email, data.user.name.
 *
 *   In an event handler, an effect or a clientLoader (browser only):
 *     const auth = await getAuthClient();
 *     await auth.signUp.email({ email, password, name });
 *     await auth.signIn.email({ email, password });
 *     await auth.signOut();
 *     // A refused request (a wrong password, a taken email, or /api/auth
 *     // answering 501 before the database is turned on) throws: wrap the
 *     // call in try/catch and show error.message. useAuthSession() follows a
 *     // sign-in or sign-out by itself.
 *
 *   For the Data API or this app's own protected /api/* routes:
 *     const token = await getAuthToken(); // null when signed out
 *     // `Authorization: Bearer <token>`; createDataClient() in
 *     // src/lib/neon-data.ts attaches it already. To a protected /api/*
 *     // route, such as src/server/routes/example-server-write.ts once it is
 *     // mounted at /api/tasks, send it with the typed client (src/lib/api.ts),
 *     // and send nothing when signed out:
 *     if (!token) return; // signed out: show the sign-in form instead
 *     const res = await api.api.tasks.$post({ json: { projectId, title } }, { headers: { Authorization: `Bearer ${token}` } });
 *
 * Never call getAuthClient() or getAuthToken() in a loader, an action, a
 * component's render or server code: they throw there. A loader or action has
 * no token to check either: a page load sends no `Authorization` header, so
 * `verifyAuthToken(request)` is null there. Load what only a signed-in user
 * may see in the browser (a clientLoader or an effect, through the Data API or
 * this app's /api/* routes), and never read the session cookie yourself. This
 * app's /api/* routes read the caller with `await verifyAuthToken(c.req.raw)`
 * (src/server/neon-auth/require-user.ts).
 *
 * Until the project's database is turned on, neonAuthEnabled is false and
 * /api/auth/* answers 501.
 */

/** Whether this project has Neon Auth provisioned (false until the database integration is enabled). */
export const neonAuthEnabled = Boolean(import.meta.env.VITE_NEON_AUTH_URL);

function serverUse(name: string): Error {
  return new Error(
    `${name} runs in the browser only, and this call ran on the server. In a component, read the ` +
      `session with useAuthSession(); call ${name} in an event handler, an effect or a clientLoader. ` +
      'A loader or action has no token to check: a page load sends no Authorization header, so verifyAuthToken(request) ' +
      'is null there. Load what only a signed-in user may see in the browser (a clientLoader or an effect, through the ' +
      "Data API or this app's /api/* routes), and never read the session cookie yourself. This app's /api/* routes " +
      'read the caller with `await verifyAuthToken(c.req.raw)` (src/server/neon-auth/require-user.ts).',
  );
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

async function makeAuthClient() {
  const [{ createAuthClient }, { BetterAuthReactAdapter }] = await Promise.all([
    import('@neondatabase/neon-js/auth'),
    import('@neondatabase/neon-js/auth/react'),
  ]);

  // The client needs an absolute address: this page's origin, then the proxy's path.
  return createAuthClient(new URL('/api/auth', window.location.origin).toString(), {
    adapter: BetterAuthReactAdapter(),
  });
}

export type AuthClient = Awaited<ReturnType<typeof makeAuthClient>>;

let client: AuthClient | undefined;
let loading: Promise<AuthClient> | undefined;

/** The browser's auth client, loaded on the first call. Throws when called on the server. */
export function getAuthClient(): Promise<AuthClient> {
  if (!isBrowser()) {
    throw serverUse('getAuthClient()');
  }

  if (client) {
    return Promise.resolve(client);
  }

  loading ??= makeAuthClient().then(
    (made) => {
      client = made;

      return made;
    },
    (error: unknown) => {
      // A failed load (the network dropped the chunk) is tried again on the next call.
      loading = undefined;
      throw error;
    },
  );

  return loading;
}

/** The signed-in session as the auth client reports it: `data` is null when signed out. */
export type AuthSession = ReturnType<AuthClient['useSession']>;

interface SessionStore {
  get(): AuthSession;
  listen(onChange: () => void): () => void;
}

// What the server renders, and what the browser shows until the session has been read: signed out, pending.
const SERVER_SESSION = {
  data: null,
  error: null,
  isPending: true,
  isRefetching: false,
  refetch: async () => {},
} as unknown as AuthSession;

let loadFailure: AuthSession | undefined;

function sessionStore(made: AuthClient): SessionStore {
  return made.$store.atoms.session as unknown as SessionStore;
}

function subscribeToSession(onChange: () => void): () => void {
  let stop: (() => void) | undefined;
  let stopped = false;

  getAuthClient().then(
    (made) => {
      if (stopped) {
        return;
      }

      loadFailure = undefined;
      stop = sessionStore(made).listen(onChange);
      onChange();
    },
    (error: unknown) => {
      console.error('[auth] the auth client could not load:', error);
      loadFailure = { ...SERVER_SESSION, isPending: false, error } as AuthSession;
      onChange();
    },
  );

  return () => {
    stopped = true;
    stop?.();
  };
}

function readSession(): AuthSession {
  if (client) {
    return sessionStore(client).get();
  }

  return loadFailure ?? SERVER_SESSION;
}

function readServerSession(): AuthSession {
  return SERVER_SESSION;
}

/**
 * The session, in any component. On the server and during hydration it is
 * signed out and pending; in the browser it then follows the auth client
 * (the first read asks `/api/auth/get-session`).
 */
export function useAuthSession(): AuthSession {
  return useSyncExternalStore(subscribeToSession, readSession, readServerSession);
}

/**
 * A short-lived JWT for the signed-in user: attach as
 * `Authorization: Bearer <token>` on Data API queries and this app's own
 * protected /api/* routes. Null when signed out. Browser only.
 */
export async function getAuthToken(): Promise<string | null> {
  if (!isBrowser()) {
    throw serverUse('getAuthToken()');
  }

  const res = await fetch('/api/auth/token', { credentials: 'include' });

  if (!res.ok) {
    return null;
  }

  const data = (await res.json().catch(() => null)) as { token?: string } | null;

  return data?.token ?? null;
}
