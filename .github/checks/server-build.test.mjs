// The template's built Worker, checked the way a published app runs it.
//
//   node --test '.github/checks/*.test.mjs'
//
// `.github/` is the template repository's own: WebDIY leaves it out of every project made from the template.
//
// The check copies the template into a temporary folder (its node_modules linked, not copied), adds fixture
// routes and one throwing /api/* route, runs `react-router build`, then serves the build two ways:
//   - in this Node process, with `cloudflare:workers` stubbed, calling the Worker's own fetch;
//   - under `wrangler dev`, as workerd runs it.
// Every page is fetched as a link-preview bot (the whole page in one answer), and must answer with its own
// title, description, og:title and text. The fixture routes import the browser's auth client module the way
// an app's sign-in page does, so a client made when that module loads (or made on the server) fails here, and
// so does an auth SDK the server evaluates to render a page (the SDK is imported in the browser only).
// A fixture page with a clientLoader and a HydrateFallback checks that the browser's files for every route export
// what the server rendered it with, so the server's HydrateFallback HTML is never left on the page.
// It also checks what the server does with errors (an /api/* route's error answers JSON, a page's error the
// app's own error page, a server build that can't load is thrown on, an unknown path is not logged), the lint
// rules against React Router 7 and Remix habits and against an auth call left without `await` (which
// `pnpm run check` runs), `requireEnv` and the logging fetch.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const BOT = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';
const LEFT_OUT = new Set(['node_modules', 'dist', '.react-router', '.wrangler', '.git', '.github']);

/** The fixture pages: each route file, its path, and what its page must say. */
const PAGES = [
  {
    file: 'routes/check-sign-in.tsx',
    path: '/check-sign-in',
    title: 'Sign in to the check app',
    text: 'session: pending',
    source: `import { useState } from 'react';
import { getAuthClient, neonAuthEnabled, useAuthSession } from '@/lib/neon-auth';

export const meta = () => [
  { title: 'Sign in to the check app' },
  { name: 'description', content: 'The sign-in page of the built Worker check.' },
  { property: 'og:title', content: 'Check sign-in' },
];

export default function CheckSignIn() {
  const { data, isPending } = useAuthSession();
  const [email, setEmail] = useState('');

  return (
    <main>
      <h1>Sign in to the check app</h1>
      <p>{\`session: \${isPending ? 'pending' : data ? 'signed in' : 'signed out'}\`}</p>
      <p>{\`auth: \${neonAuthEnabled ? 'on' : 'off'}\`}</p>
      <input value={email} onChange={(e) => setEmail(e.target.value)} />
      <button
        type="button"
        onClick={() => void getAuthClient().then((auth) => auth.signIn.email({ email, password: 'check' }))}
      >
        Sign in
      </button>
    </main>
  );
}
`,
  },
  {
    file: 'routes/check-server-use.tsx',
    path: '/check-server-use',
    title: 'Server use of the auth client',
    text: 'a page load sends no Authorization header, so verifyAuthToken(request) is null there',
    source: `import { getAuthClient } from '@/lib/neon-auth';

export function loader() {
  try {
    getAuthClient();
    return { said: 'made on the server' };
  } catch (error) {
    return { said: error instanceof Error ? error.message : String(error) };
  }
}

export const meta = () => [
  { title: 'Server use of the auth client' },
  { name: 'description', content: 'A loader that asks for the auth client.' },
  { property: 'og:title', content: 'Check server use' },
];

export default function CheckServerUse({ loaderData }: { loaderData: { said: string } }) {
  return (
    <main>
      <h1>Server use of the auth client</h1>
      <p>{loaderData.said}</p>
    </main>
  );
}
`,
  },
  {
    file: 'routes/check-data.tsx',
    path: '/check-data',
    title: 'Check data: 3 rows',
    text: 'Row 3',
    source: `import { getAuthToken } from '@/lib/neon-auth';
import { createDataClient } from '@/lib/neon-data';

export function loader() {
  return { rows: ['Row 1', 'Row 2', 'Row 3'] };
}

export const meta = ({ loaderData }: { loaderData: { rows: string[] } }) => [
  { title: \`Check data: \${loaderData.rows.length} rows\` },
  { name: 'description', content: 'A page whose data comes from its loader.' },
  { property: 'og:title', content: 'Check data' },
];

export default function CheckData({ loaderData }: { loaderData: { rows: string[] } }) {
  return (
    <main>
      <h1>Check data</h1>
      <ul>
        {loaderData.rows.map((row) => (
          <li key={row}>{row}</li>
        ))}
      </ul>
      <button type="button" onClick={() => void getAuthToken().then(() => createDataClient())}>
        Load
      </button>
    </main>
  );
}
`,
  },
  {
    file: 'routes/check-client-loader.tsx',
    path: '/check-client-loader',
    title: 'Check client loader',
    text: 'Loading the list',
    source: `import { getAuthClient } from '@/lib/neon-auth';

export const meta = () => [
  { title: 'Check client loader' },
  { name: 'description', content: 'A page whose data comes from its clientLoader.' },
  { property: 'og:title', content: 'Check client loader' },
];

export async function clientLoader() {
  const auth = await getAuthClient();
  return { rows: ['Row A', 'Row B'], signIn: typeof auth.signIn.email };
}

export function HydrateFallback() {
  return <p>Loading the list</p>;
}

export default function CheckClientLoader({ loaderData }: { loaderData: { rows: string[] } }) {
  return (
    <main>
      <h1>Check client loader</h1>
      <ul>
        {loaderData.rows.map((row) => (
          <li key={row}>{row}</li>
        ))}
      </ul>
    </main>
  );
}
`,
  },
  {
    file: 'routes/check-throws.tsx',
    path: '/check-throws',
    status: 500,
    title: 'Something went wrong',
    text: 'An unexpected error occurred.',
    source: `export function loader(): { rows: string[] } {
  throw new Error('check loader failure');
}

export default function CheckThrows() {
  return <main>never rendered</main>;
}
`,
  },
];

const HEALTH_ROUTE = ".get('/api/health', (c) => c.json({ ok: true }))";
const THROWING_API_ROUTE = `${HEALTH_ROUTE}\n  .get('/api/check-throws', () => {\n    throw new Error('check api failure');\n  })`;

// The template's protected route example, mounted in the notes' copy where neon-auth.ts's notes say it is.
const PROTECTED_ROUTE_FILE = 'src/server/routes/example-server-write.ts';
const PROTECTED_PATH = '/api/tasks';
const PROTECTED_MOUNT = `${HEALTH_ROUTE}\n  .route('${PROTECTED_PATH}', exampleServerWrite)`;

const ROUTES_TS = `import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
${PAGES.map((p) => `  route('${p.path.slice(1)}', '${p.file}'),`).join('\n')}
] satisfies RouteConfig;
`;

let work;
let serverEntry;
let broken;
let brokenEntry;

function copyTemplate(from, to) {
  fs.mkdirSync(to, { recursive: true });

  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (LEFT_OUT.has(entry.name)) {
      continue;
    }

    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);

    if (entry.isDirectory()) {
      copyTemplate(src, dest);
    } else {
      fs.copyFileSync(src, dest);
    }
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** What a bot's fetch of a page must show: its status, its own head tags and its text in the HTML. */
function assertPage(page, { status, type, body: html }) {
  assert.equal(
    status,
    page.status ?? 200,
    `${page.path} answered ${status}:\n${html.slice(0, 2000)}`,
  );
  assert.match(type, /^text\/html/, `${page.path} answered ${type}, not a page`);
  assert.doesNotMatch(html, /Invalid base URL/, `${page.path} carries "Invalid base URL"`);
  assert.match(html, new RegExp(`<title>${page.title}</title>`), `${page.path} has its own title`);
  assert.ok(html.includes(page.text), `${page.path} has "${page.text}" in its HTML`);

  if (!page.status) {
    assert.match(
      html,
      /<meta name="description" content="[^"]+"/,
      `${page.path} has a description`,
    );
    assert.match(html, /<meta property="og:title" content="[^"]+"/, `${page.path} has an og:title`);
  }
}

/** The checks both servers answer: every page, an unknown path, an /api/* path and the health route. */
async function checkServer(fetchPath) {
  for (const page of PAGES) {
    assertPage(page, await fetchPath(page.path));
  }

  const home = await fetchPath('/');
  assert.equal(home.status, 200, `/ answered ${home.status}`);
  assert.doesNotMatch(home.body, /Invalid base URL/);

  const missing = await fetchPath('/no-such-page');
  assert.equal(missing.status, 404, `an unknown path answered ${missing.status}`);
  assert.match(missing.body, /<title>Page not found<\/title>/);

  const health = await fetchPath('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { ok: true });

  const apiMissing = await fetchPath('/api/no-such-route');
  assert.equal(apiMissing.status, 404);
  assert.match(apiMissing.type, /application\/json/);

  // A built Worker answers an /api/* route's error with a generic JSON body, never a page or a stack.
  const apiThrows = await fetchPath('/api/check-throws');
  assert.equal(apiThrows.status, 500);
  assert.match(apiThrows.type, /application\/json/);
  assert.deepEqual(JSON.parse(apiThrows.body), { error: 'Internal Server Error' });
}

function build(dir, env = {}) {
  const run = spawnSync(process.execPath, ['node_modules/@react-router/dev/bin.cjs', 'build'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...env, FORCE_COLOR: '0' },
  });

  assert.equal(run.status, 0, `react-router build failed:\n${run.stdout}\n${run.stderr}`);
  const entry = path.join(dir, 'dist', 'server', 'index.js');
  assert.ok(fs.existsSync(entry), 'the build wrote dist/server/index.js');

  return entry;
}

// The auth SDK's own error text: a chunk holding it holds the SDK.
const SDK_MARK = 'Invalid base URL';

/**
 * The chunks the built Worker evaluates to render a page: its entry, the server build the entry imports on a
 * page request, and every chunk those import statically. A chunk reached only through an `import()` in app
 * code is left out: it loads only when that code runs. Every chunk the build writes ends in `.js`.
 */
function renderedChunks(entry) {
  const dynamicInEntry = [
    ...fs.readFileSync(entry, 'utf8').matchAll(/\bimport\(\s*["'](\.\.?\/[^"']+\.js)["']\s*\)/g),
  ].map((m) => path.resolve(path.dirname(entry), m[1]));
  const seen = new Set();
  const queue = [entry, ...dynamicInEntry];

  while (queue.length > 0) {
    const file = queue.shift();

    if (seen.has(file)) {
      continue;
    }

    seen.add(file);
    const code = fs.readFileSync(file, 'utf8');

    for (const m of code.matchAll(
      /\b(?:import|export)\s*(?:[\w$*{}\s,]+from\s*)?["'](\.\.?\/[^"']+\.js)["']/g,
    )) {
      const target = path.resolve(path.dirname(file), m[1]);

      // Text that only looks like an import (in a string or a comment) names no chunk of the build.
      if (fs.existsSync(target)) {
        queue.push(target);
      }
    }
  }

  return [...seen];
}

/** The names a built browser file exports, as the bundler writes them (`export{a as default,b as meta}`). */
function exportedNames(file) {
  const code = fs.readFileSync(file, 'utf8');
  const names = new Set();

  for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop();

      if (name) {
        names.add(name);
      }
    }
  }

  for (const m of code.matchAll(
    /\bexport\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([\w$]+)/g,
  )) {
    names.add(m[1]);
  }

  if (/\bexport\s+default\b/.test(code)) {
    names.add('default');
  }

  return names;
}

/** A route module's exports the browser renders or runs with. */
const BROWSER_EXPORTS = [
  'default',
  'Layout',
  'ErrorBoundary',
  'HydrateFallback',
  'clientLoader',
  'clientAction',
  'clientMiddleware',
  'meta',
  'links',
  'handle',
  'shouldRevalidate',
];

function makeCopy(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  copyTemplate(ROOT, dir);
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');

  return dir;
}

function stubCloudflareWorkers() {
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'cloudflare:workers') {
        return {
          url: 'data:text/javascript,export const env = {}; export default {};',
          shortCircuit: true,
        };
      }

      return next(specifier, context);
    },
  });
}

const ASSETS_ENV = { ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) } };
const CTX = { waitUntil() {}, passThroughOnException() {} };

/** Runs `fn` with console.error recorded; returns what it logged. */
async function logged(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => {
    lines.push(
      args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' '),
    );
  };

  try {
    await fn();
  } finally {
    console.error = original;
  }

  return lines;
}

/** A template TypeScript module with no imports, compiled and loaded here. */
async function loadModule(rel) {
  const { default: ts } = await import(
    pathToFileURL(path.join(ROOT, 'node_modules/typescript/lib/typescript.js')).href
  );
  const out = ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });

  return import(`data:text/javascript;base64,${Buffer.from(out.outputText).toString('base64')}`);
}

describe('the built Worker', () => {
  before(() => {
    work = makeCopy('webdiy-server-build-');

    for (const page of PAGES) {
      fs.writeFileSync(path.join(work, 'src', page.file), page.source);
    }

    fs.writeFileSync(path.join(work, 'src', 'routes.ts'), ROUTES_TS);

    const serverIndex = path.join(work, 'src', 'server', 'index.ts');
    const server = fs.readFileSync(serverIndex, 'utf8');
    assert.ok(server.includes(HEALTH_ROUTE), 'src/server/index.ts chains the health route');
    fs.writeFileSync(serverIndex, server.replace(HEALTH_ROUTE, THROWING_API_ROUTE));

    serverEntry = build(work, { VITE_NEON_AUTH_URL: 'https://auth.check.invalid/neondb/auth' });

    // A copy whose server build can't load: root.tsx imports a module that throws as it is evaluated.
    broken = makeCopy('webdiy-server-build-broken-');
    fs.writeFileSync(
      path.join(broken, 'src', 'check-broken.ts'),
      "throw new Error('check: this module fails to load');\n",
    );
    const root = path.join(broken, 'src', 'root.tsx');
    fs.writeFileSync(root, `import './check-broken';\n${fs.readFileSync(root, 'utf8')}`);
    brokenEntry = build(broken);
    stubCloudflareWorkers();
  });

  after(() => {
    for (const dir of [work, broken]) {
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('served in Node, with cloudflare:workers stubbed', async () => {
    const { default: worker } = await import(pathToFileURL(serverEntry).href);
    const fetchPath = async (p) => {
      const res = await worker.fetch(
        new Request(`https://check.example${p}`, {
          headers: { 'user-agent': BOT, accept: 'text/html' },
        }),
        ASSETS_ENV,
        CTX,
      );

      return {
        status: res.status,
        type: res.headers.get('content-type') ?? '',
        body: await res.text(),
      };
    };

    const lines = await logged(() => checkServer(fetchPath));
    assert.ok(
      !lines.some((l) => /Invalid base URL/.test(l)),
      `logged "Invalid base URL":\n${lines.join('\n')}`,
    );

    // An unknown path is a 404 the page explains: nothing logged.
    const missing = await logged(() => fetchPath('/no-such-page'));
    assert.deepEqual(missing, [], `an unknown path logged:\n${missing.join('\n')}`);

    // A loader's error is logged once, with its message.
    const thrown = await logged(() => fetchPath('/check-throws'));
    assert.equal(
      thrown.filter((l) => l.includes('check loader failure')).length,
      1,
      thrown.join('\n'),
    );

    // An /api/* route's error is logged with its method and path.
    const apiThrown = await logged(() => fetchPath('/api/check-throws'));
    assert.ok(
      apiThrown.some(
        (l) => l.includes('[api] GET /api/check-throws failed:') && l.includes('check api failure'),
      ),
    );
  });

  test('a page render never loads the auth SDK: it is in the build only behind a browser-only import', () => {
    const serverDir = path.dirname(serverEntry);
    const evaluated = renderedChunks(serverEntry);
    const holding = evaluated.filter((file) => fs.readFileSync(file, 'utf8').includes(SDK_MARK));
    assert.deepEqual(
      holding.map((file) => path.relative(serverDir, file)),
      [],
      'a chunk the server evaluates for a page holds the auth SDK',
    );

    // The marker still finds the SDK in the build, so the check above is not passing on a renamed message.
    const all = fs
      .readdirSync(serverDir, { recursive: true })
      .filter((rel) => rel.endsWith('.js'))
      .map((rel) => path.join(serverDir, rel));
    assert.ok(
      all.some((file) => fs.readFileSync(file, 'utf8').includes(SDK_MARK)),
      `no chunk of the server build holds "${SDK_MARK}": the auth SDK's marker has changed`,
    );
  });

  test('the browser loads every export a route renders with: no HydrateFallback is left out', async () => {
    const assetsDir = path.join(path.dirname(serverEntry), 'assets');
    const serverBuildFile = fs.readdirSync(assetsDir).find((f) => /^server-build-.*\.js$/.test(f));
    assert.ok(serverBuildFile, 'the build wrote dist/server/assets/server-build-*.js');
    const { routes, assets } = await import(
      pathToFileURL(path.join(assetsDir, serverBuildFile)).href
    );
    const clientDir = path.join(work, 'dist', 'client');
    const missing = [];

    for (const [id, route] of Object.entries(routes)) {
      const rendered = Object.keys(route.module).filter((name) => BROWSER_EXPORTS.includes(name));
      const entry = assets.routes[id];
      const files = [
        entry.module,
        entry.clientLoaderModule,
        entry.clientActionModule,
        entry.clientMiddlewareModule,
        entry.hydrateFallbackModule,
      ].filter(Boolean);
      const loaded = new Set(files.flatMap((f) => [...exportedNames(path.join(clientDir, f))]));
      const lost = rendered.filter((name) => !loaded.has(name));

      if (lost.length > 0) {
        missing.push(`${id}: ${lost.join(', ')} (browser files: ${files.join(', ')})`);
      }
    }

    assert.ok(
      Object.keys(routes['routes/check-client-loader'].module).includes('HydrateFallback'),
      'the client loader fixture renders a HydrateFallback on the server',
    );
    assert.deepEqual(
      missing,
      [],
      "a route's browser files leave out exports the server renders it with",
    );
  });

  test('a server build that cannot load: pages are thrown on, never answered as JSON; /api/* still answers', async () => {
    const { default: worker } = await import(pathToFileURL(brokenEntry).href);
    const call = (p) =>
      worker.fetch(
        new Request(`https://check.example${p}`, { headers: { accept: 'text/html' } }),
        ASSETS_ENV,
        CTX,
      );

    await logged(() => assert.rejects(call('/'), /check: this module fails to load/));
    const health = await call('/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
  });

  test('served by wrangler dev', async () => {
    const port = await freePort();
    const inspectorPort = await freePort();
    let output = '';
    const dev = spawn(
      process.execPath,
      [
        'node_modules/wrangler/bin/wrangler.js',
        'dev',
        '--config',
        'dist/server/wrangler.json',
        '--ip',
        '127.0.0.1',
        '--port',
        String(port),
        '--inspector-port',
        String(inspectorPort),
        '--log-level',
        'warn',
      ],
      {
        cwd: work,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', FORCE_COLOR: '0' },
      },
    );

    dev.stdout.on('data', (d) => {
      output += d;
    });
    dev.stderr.on('data', (d) => {
      output += d;
    });

    const stop = () => {
      try {
        process.kill(-dev.pid, 'SIGTERM');
      } catch {
        // The group is gone already.
      }
    };

    try {
      const base = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 90_000;
      let ready = false;

      while (!ready && Date.now() < deadline) {
        assert.equal(dev.exitCode, null, `wrangler dev exited:\n${output}`);

        try {
          ready = (await fetch(`${base}/api/health`)).ok;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      assert.ok(ready, `wrangler dev never answered:\n${output}`);

      try {
        await checkServer(async (p) => {
          const res = await fetch(`${base}${p}`, {
            headers: { 'user-agent': BOT, accept: 'text/html' },
          });

          return {
            status: res.status,
            type: res.headers.get('content-type') ?? '',
            body: await res.text(),
          };
        });
      } catch (error) {
        error.message += `\n--- wrangler dev's output ---\n${output.slice(-6000)}`;
        throw error;
      }

      assert.doesNotMatch(
        output,
        /Invalid base URL/,
        `wrangler dev logged "Invalid base URL":\n${output}`,
      );
    } finally {
      stop();
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      try {
        process.kill(-dev.pid, 'SIGKILL');
      } catch {
        // Stopped by the SIGTERM.
      }
    }
  });
});

describe('the lint rules', () => {
  // A fixture line ending in `// refused: await` must give exactly one "write `await`" error, one ending in
  // `// refused: name` exactly one "under their own names" error, and no other line any error of that kind.
  const ROUTE = `import { Link } from 'react-router-dom';
import { json } from '@remix-run/cloudflare';
import { getAuthToken } from '@/lib/neon-auth';

export async function clientLoader() {
  if (!getAuthToken()) { // refused: await
    return null;
  }

  const token = await getAuthToken();

  return { token };
}

type Context = { cloudflare: { env: Record<string, string> } };

export function loader({ context }: { context: Context }) {
  return json({ env: context.cloudflare.env, Link });
}

export function action({ context: { cloudflare } }: { context: Context }) {
  return cloudflare.env;
}
`;
  // Every way a model plausibly checks the caller without `await`, each of which lets every caller through,
  // and the awaited and chained forms, which must stay allowed.
  const SERVER = `import { verifyAuthToken } from './neon-auth/require-user';
import * as auth from './neon-auth/require-user';
import { verifyAuthToken as checkCaller } from './neon-auth/require-user'; // refused: name
export { verifyAuthToken as checkUser } from './neon-auth/require-user'; // refused: name

type Context = { cloudflare: { env: Record<string, string> } };
const denied = () => new Response('Sign in first.', { status: 401 });

export function negated(request: Request) {
  const user = verifyAuthToken(request); // refused: await
  return !user ? denied() : null;
}

export function strictNull(request: Request) {
  const user = verifyAuthToken(request); // refused: await
  return user === null ? denied() : null;
}

export function looseNull(request: Request) {
  const user = verifyAuthToken(request); // refused: await
  if (user == null) {
    return denied();
  }
  return null;
}

export function boolean(request: Request) {
  const signedIn = Boolean(verifyAuthToken(request)); // refused: await
  return signedIn ? null : denied();
}

export function ifNot(request: Request) {
  if (!verifyAuthToken(request)) { // refused: await
    return denied();
  }
  return null;
}

export function passedOn(request: Request) {
  return verifyAuthToken(request); // refused: await
}

export function throughNamespace(request: Request) {
  return auth.verifyAuthToken(request); // refused: await
}

export async function awaited(request: Request) {
  const user = await verifyAuthToken(request);
  if (!user) {
    return denied();
  }
  return user.sub;
}

export async function returnedAwaited(request: Request) {
  return await auth.verifyAuthToken(request);
}

export function chained(request: Request) {
  return verifyAuthToken(request).then((user) => (user ? user.sub : null));
}

export const aliased = checkCaller;

export function destructured() {
  const { verifyAuthToken: fromNamespace } = auth; // refused: name
  return fromNamespace;
}

export async function destructuredImport() {
  const { verifyAuthToken: loaded } = await import('./neon-auth/require-user'); // refused: name
  return loaded;
}

export function sameName() {
  const { verifyAuthToken } = auth;
  return verifyAuthToken;
}

export const notAPattern = { verifyAuthToken: checkCaller };

export async function awaitedOptional(request: Request) {
  return await verifyAuthToken?.(request);
}

export function optionalNotAwaited(request: Request) {
  return verifyAuthToken?.(request); // refused: await
}

export async function awaitedCast(request: Request) {
  return await (verifyAuthToken(request) as Promise<{ sub: string } | null>);
}

export function castNotAwaited(request: Request) {
  return verifyAuthToken(request) as Promise<{ sub: string } | null>; // refused: await
}

export function read(context: Context) {
  const { cloudflare } = context;
  return cloudflare.env;
}
`;
  // A .tsx file under src/server is server code too.
  const SERVER_TSX = `import { verifyAuthToken } from './neon-auth/require-user';

export function inTsx(request: Request) {
  return verifyAuthToken(request); // refused: await
}
`;
  const FILES = {
    'src/routes/check-lint.tsx': ROUTE,
    'src/server/check-lint.ts': SERVER,
    'src/server/check-lint.page.tsx': SERVER_TSX,
  };
  // How many load-context lines each fixture holds.
  const LOAD_CONTEXT = {
    'src/routes/check-lint.tsx': 2,
    'src/server/check-lint.ts': 1,
    'src/server/check-lint.page.tsx': 0,
  };
  let dir;

  before(() => {
    dir = makeCopy('webdiy-lint-');
    for (const [file, source] of Object.entries(FILES)) {
      fs.writeFileSync(path.join(dir, file), source);
    }
  });

  after(() => {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const marked = (source, mark) =>
    source.split('\n').flatMap((line, i) => (line.endsWith(`// refused: ${mark}`) ? [i + 1] : []));

  test('refuse react-router-dom, @remix-run/*, the React Router 7 load context and an auth call without await; the template itself is clean', () => {
    const run = spawnSync(
      process.execPath,
      ['node_modules/eslint/bin/eslint.js', '--format', 'json', '.'],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } },
    );
    const results = JSON.parse(run.stdout);
    const messages = results.flatMap((r) =>
      r.messages.map((m) => ({ ...m, file: path.relative(dir, r.filePath) })),
    );
    const found = messages.map((m) => `${m.file}:${m.line} ${m.ruleId}: ${m.message}`);
    const lines = (file, rule, text) =>
      messages
        .filter((m) => m.file === file && m.ruleId === rule && m.message.includes(text))
        .map((m) => m.line);

    assert.equal(
      lines('src/routes/check-lint.tsx', 'no-restricted-imports', '').length,
      2,
      found.join('\n'),
    );

    for (const file of Object.keys(FILES)) {
      assert.equal(
        lines(file, 'no-restricted-syntax', 'no load context').length,
        LOAD_CONTEXT[file],
        found.join('\n'),
      );
      assert.deepEqual(
        lines(file, 'no-restricted-syntax', 'write `await` before the call'),
        marked(FILES[file], 'await'),
        found.join('\n'),
      );
      assert.deepEqual(
        lines(file, 'no-restricted-syntax', 'under their own names'),
        marked(FILES[file], 'name'),
        found.join('\n'),
      );
    }

    // The server fixtures' only errors are the ones they were written to give.
    assert.deepEqual(
      messages
        .filter((m) => m.file.startsWith('src/server/') && m.ruleId !== 'no-restricted-syntax')
        .map((m) => `${m.file}:${m.line} ${m.ruleId}: ${m.message}`),
      [],
    );
    assert.ok(
      found.every((f) => f.includes('/check-lint.')),
      `the template's own files have lint errors:\n${found.join('\n')}`,
    );
  });
});

describe('the server and browser helpers', () => {
  test('requireEnv returns a set value and names the missing one with its fix', async () => {
    const { requireEnv } = await loadModule('src/server/env.ts');

    assert.equal(requireEnv({ DATABASE_URL: 'postgres://x' }, 'DATABASE_URL'), 'postgres://x');
    assert.throws(
      () => requireEnv({}, 'DATABASE_URL'),
      /DATABASE_URL is not set .*restart the dev server/s,
    );
    // A database binding is missing first of all because the database is not turned on yet.
    for (const name of ['DATABASE_URL', 'NEON_AUTH_COOKIE_SECRET']) {
      assert.throws(
        () => requireEnv({}, name),
        new RegExp(
          `If the project's database is not turned on yet, it has no ${name}: ask the person to turn it on\\.`,
        ),
      );
    }
    assert.throws(
      () => requireEnv({}, 'STRIPE_SECRET_KEY'),
      (error) => !/database/.test(error.message) && /restart the dev server/.test(error.message),
    );
    assert.throws(
      () => requireEnv({ DATABASE_URL: '' }, 'DATABASE_URL'),
      /DATABASE_URL is not set/,
    );
  });

  test('loggedFetch logs a failed answer with its body and returns it untouched', async () => {
    const { loggedFetch } = await loadModule('src/lib/fetch.ts');
    const realFetch = globalThis.fetch;
    let answer;
    globalThis.fetch = async () => answer;

    try {
      answer = new Response('{"error":"Title is required"}', { status: 422 });
      let res;
      const failed = await logged(async () => {
        res = await loggedFetch('/api/todos', { method: 'POST' });
      });
      assert.deepEqual(failed, ['[fetch] POST /api/todos -> 422: {"error":"Title is required"}']);
      assert.equal(res.status, 422);
      assert.equal(await res.text(), '{"error":"Title is required"}');

      answer = new Response('[]', { status: 200 });
      assert.deepEqual(await logged(() => loggedFetch('/api/todos')), []);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// The template's own licence, and the licence of the vendored auth proxy (Apache-2.0 asks whoever passes the code on
// to give its licence with it, and to mark the files they changed).
describe('the licences', () => {
  const VENDOR = 'src/server/neon-auth/vendor';
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const sha256 = (text) => createHash('sha256').update(text).digest('hex');
  // neon-js's LICENSE at the vendored commit (the same bytes as @neondatabase/auth 0.4.2-beta's LICENSE).
  const APACHE_SHA256 = '360ccd31d8459144450ed98c208e0f2fd5ee41960b453fba1648b2f1d768caa2';
  // The MIT text, its spaces and line breaks collapsed (SPDX's text, its placeholders filled).
  const MIT_SHA256 = '3b602d57ed31a26d66f191b89f4ea287b342c3b4338333902ab19131e9400dc8';
  const NOTICE =
    /^\/\/ Changed from neon-js ([0-9a-f]{7}): its import paths only \(README\.md in this folder lists the changes\)\.\n/;

  test('the repository is MIT, copyright Lumeio, Inc., and the README names both licences', () => {
    const mit = read('LICENSE');
    assert.match(mit, /^MIT License\n\nCopyright \(c\) 2026 Lumeio, Inc\.\n/);
    assert.equal(sha256(mit.replace(/\s+/g, ' ').trim()), MIT_SHA256, 'LICENSE is the MIT text');
    const readme = read('README.md');
    assert.ok(readme.includes('[LICENSE](LICENSE)'), 'the README names LICENSE');
    assert.ok(
      readme.includes(`(${VENDOR}/LICENSE)`),
      "the README names the vendored proxy's licence",
    );
    assert.ok(
      readme.includes(
        'The UI components in src/components/ui/ are adapted from shadcn/ui (MIT, Copyright (c) 2023 shadcn).',
      ),
      'the README credits shadcn/ui for the UI components',
    );
  });

  test("the vendored proxy carries neon-js's licence, unchanged, from the commit its README names", () => {
    const text = read(`${VENDOR}/LICENSE`);
    const line = text.indexOf('\n---');
    assert.ok(line > 0, 'LICENSE has its header above a line');
    const header = text.slice(0, line);
    const body = text.slice(text.indexOf('\n', line + 1) + 1);
    assert.equal(
      sha256(body),
      APACHE_SHA256,
      "the text below the line is neon-js's LICENSE, byte for byte",
    );
    const commit = (header.match(/neondatabase\/neon-js\/blob\/([0-9a-f]{40})\/LICENSE/) ?? [])[1];
    assert.ok(commit, 'the header names the file it was copied from');
    assert.match(header, /copied on \d{4}-\d{2}-\d{2}/, 'the header says when');
    const readme = read(`${VENDOR}/README.md`);
    assert.ok(readme.includes('[LICENSE](LICENSE)'), 'the vendor README names LICENSE');
    assert.ok(
      readme.includes(`at commit \`${commit.slice(0, 7)}\``),
      'the vendor README names the same commit',
    );
  });

  test('every changed vendored file says so, and the vendor README lists every file as changed, as upstream or own', () => {
    const files = fs
      .readdirSync(path.join(ROOT, VENDOR), { recursive: true })
      .filter((rel) => /\.tsx?$/.test(rel))
      .map((rel) => rel.split(path.sep).join('/'))
      .sort();
    const marked = files.filter((rel) => {
      const m = read(`${VENDOR}/${rel}`).match(NOTICE);
      if (m) {
        assert.ok(
          read(`${VENDOR}/README.md`).includes(`at commit \`${m[1]}\``),
          `${rel} names the vendored commit`,
        );
      }
      return Boolean(m);
    });
    const readme = read(`${VENDOR}/README.md`);
    const lists = readme
      .slice(readme.indexOf('**Which files are which:**'))
      .split('\n\n')[1]
      .split(/\n- /)
      .map((item) => [...item.matchAll(/`([^`]+\.tsx?)`/g)].map((m) => m[1]).sort());
    assert.equal(lists.length, 3, 'three lists: changed, as upstream, own');
    const [changed, upstream, own] = lists;
    assert.deepEqual(
      marked,
      changed,
      'the files that start with the change line are the ones listed as changed',
    );
    assert.deepEqual(
      [...changed, ...upstream, ...own].sort(),
      files,
      'every vendored file is in one list',
    );
  });
});

// What git saves of a project. WebDIY saves a project's files through git and its .gitignore, so a line that
// ignores a name at any depth (a line without a leading or middle `/`) also leaves out a person's source folder of
// that name, src/features/logs/ for `logs`, and nothing says so.
describe('what .gitignore leaves out', () => {
  const lines = fs
    .readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  // Names only a tool makes, ignored wherever they are.
  const ANY_DEPTH = new Set([
    'node_modules',
    '.wrangler',
    '.dev.vars',
    'worker-configuration.d.ts',
    '.idea',
    '.DS_Store',
    '.react-router/',
  ]);
  // Folders a person may give their source, at the depths a project has them.
  const SOURCE = [
    'src/features/logs/index.ts',
    'src/routes/logs/route.tsx',
    'src/features/dist/index.ts',
    'src/components/dist-ssr/index.tsx',
    'src/lib/build/index.ts',
    'src/server/out/index.ts',
    'src/coverage/index.ts',
    'src/cache/index.ts',
    'src/tmp/index.ts',
    'public/logs/index.html',
  ];
  // What a build, a check or a tool writes at the root.
  const ROOT_OUTPUT = [
    'dist/client/index.html',
    'dist/server/index.js',
    'dist-ssr/index.js',
    'logs/dev.txt',
    'node_modules/a/index.js',
    '.wrangler/state/v3/d1/db.sqlite',
    '.react-router/types/+routes.ts',
    '.dev.vars',
    'worker-configuration.d.ts',
    'tsconfig.app.tsbuildinfo',
    'pnpm-debug.log',
  ];

  /** The files git would save in a folder holding `files` and the template's .gitignore. */
  function saved(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webdiy-gitignore-'));
    try {
      const git = (args) => {
        const r = spawnSync('git', args, {
          cwd: dir,
          encoding: 'utf8',
          env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' },
        });
        assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);

        return r.stdout;
      };
      git(['init', '-q']);
      for (const rel of files) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), 'x\n');
      }
      // Last, so a `.gitignore` among the files is the template's own.
      fs.copyFileSync(path.join(ROOT, '.gitignore'), path.join(dir, '.gitignore'));
      git(['add', '-A']);

      return new Set(git(['ls-files', '-z']).split('\0').filter(Boolean));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test('a line that names a folder or file is anchored to the root, or names something only a tool makes', () => {
    const anyDepth = lines.filter(
      (line) => !/[*?[]/.test(line) && !line.replace(/\/$/, '').includes('/'),
    );
    assert.deepEqual(
      anyDepth.filter((line) => !ANY_DEPTH.has(line)),
      [],
      'these lines leave out a source folder of the same name anywhere in a project: start them with /',
    );
  });

  test('git keeps a source folder named like build output, and leaves out the build output at the root', () => {
    const files = saved([...SOURCE, ...ROOT_OUTPUT]);
    assert.deepEqual(
      SOURCE.filter((rel) => !files.has(rel)),
      [],
      'source files git would not save',
    );
    assert.deepEqual(
      ROOT_OUTPUT.filter((rel) => files.has(rel)),
      [],
      'build or tool output git would save',
    );
  });

  test('git saves every file the template ships', () => {
    // The template's files: what a build, a check or a tool writes beside them is left out of the walk.
    const written = (name) =>
      LEFT_OUT.has(name) || ANY_DEPTH.has(name) || /\.(tsbuildinfo|log)$/.test(name);
    const shipped = [];
    const walk = (rel) => {
      for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (written(entry.name)) {
          continue;
        }
        if (entry.isDirectory()) {
          walk(child);
        } else {
          shipped.push(child);
        }
      }
    };
    walk('');
    const files = saved(shipped);
    assert.ok(shipped.includes('src/root.tsx'), 'the walk reads the template');
    assert.deepEqual(
      shipped.filter((rel) => !files.has(rel)),
      [],
      'files of the template git would not save',
    );
  });
});

describe('the usage notes', () => {
  // What a model building on the template would otherwise look for in node_modules or the vendor's docs: each
  // file's header must answer it.
  const NOTES = {
    'src/lib/neon-auth.ts': [
      'no need to read the SDK in node_modules',
      'useAuthSession()',
      'await getAuthClient()',
      'auth.signUp.email({ email, password, name })',
      'auth.signIn.email({ email, password })',
      'auth.signOut()',
      'data.user.id',
      'throws: wrap the call in try/catch',
      'getAuthToken()',
      'safe to import anywhere, a route module included',
      'a page load sends no `Authorization` header',
      'never read the session cookie yourself',
      'await verifyAuthToken(c.req.raw)',
      'send it with the typed client',
    ],
    'src/lib/neon-data.ts': [
      'no need to read the packages in node_modules',
      ".from('todos').select('*')",
      '.insert({ title }).select().single()',
      ".update({ done: true }).eq('id', id)",
      ".delete().eq('id', id)",
      "doesn't throw on a database error",
      '`authenticated` role, which already has SELECT, INSERT, UPDATE and DELETE',
      'A migration needs no GRANT for a table',
      'uuid default gen_random_uuid()',
      'a `serial` column',
      'grant usage on sequence',
      'enable row level security',
      'auth.user_id()',
      "in its route's `loader`",
      "neon(requireEnv(env, 'DATABASE_URL'))",
      'never where a module loads',
      "What a loader returns is in the page's HTML for anyone who opens it",
      "sees every user's rows: return only what any visitor may see",
      "A page's own user's rows load in the browser",
      'sees no rows (and no error)',
      'create policy public_read on posts for select to app_rw using (published);',
    ],
    'src/server/routes/example-server-write.ts': [
      'no need to read the packages in node_modules',
      'const user = await verifyAuthToken(c.req.raw);',
      "if (!user) return c.json({ error: 'Sign in first.' }, 401);",
      'Never leave out the `await`',
      'user.sub',
      'const sql = neon(url)',
      'await sql`select',
      "import { env } from 'cloudflare:workers'",
      "neon(requireEnv(env, 'DATABASE_URL'))",
      'z.email()',
      'create policy server_access on tasks to app_rw',
      'a role no policy applies to sees no rows and can write none',
    ],
    'README.md': [
      "**A page's public data** comes from its route `loader`; a signed-in user's own data loads in the browser",
      'pnpm check # react-router typegen, tsc -b, eslint',
    ],
  };

  for (const [file, phrases] of Object.entries(NOTES)) {
    test(`${file} says how to use it`, () => {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      // The header as one line: each comment line's ` * ` (and a `// ` inside an example) joined by a space;
      // a Markdown file whole, its spaces collapsed.
      const header = file.endsWith('.md')
        ? source.replace(/[ \t]+/g, ' ')
        : source.slice(0, source.indexOf('*/') + 2).replace(/\n \*\s*(?:\/\/\s*)?/g, ' ');
      const missing = phrases.filter((phrase) => !header.includes(phrase));
      assert.deepEqual(missing, [], `${file}'s header comment no longer says these`);
    });
  }
});

/*
 * The code the template teaches: every code line and every inline `code` in README.md, in the comments of the
 * template's own source and eslint.config.js, and in their messages (a string holding `code`). Each one must be
 * part of a piece of NOTE_CODE below, which the next section writes into a copy of the template exactly as the
 * notes write it and type-checks, builds and lints there; or be listed in NOT_TYPESCRIPT with the reason it isn't
 * compiled. A new example in a note without its NOTE_CODE entry fails here.
 */
const NOTE_SOURCES = ['README.md', 'eslint.config.js'];
const NOT_NOTES = new Set(['src/server/neon-auth/vendor']);

/** Text a model reads: the comments, and the strings that hold `code` (messages), of one source file. */
async function taughtTexts(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');

  if (rel.endsWith('.md')) {
    return [{ markdown: true, text }];
  }

  const { default: ts } = await import(
    pathToFileURL(path.join(ROOT, 'node_modules/typescript/lib/typescript.js')).href
  );
  const kind = rel.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : rel.endsWith('.js')
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const file = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  const comments = new Map();
  const strings = [];
  const visit = (node) => {
    for (const range of [
      ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? []),
    ]) {
      comments.set(range.pos, text.slice(range.pos, range.end));
    }

    if (ts.isStringLiteral(node) && node.text.includes('`')) {
      strings.push(node.text);
    }

    ts.forEachChild(node, visit);
  };
  visit(file);

  return [
    ...[...comments.values()].map((c) => ({
      text: c.startsWith('//')
        ? c.slice(2)
        : c
            .slice(2, -2)
            .split('\n')
            .map((line) => line.replace(/^\s*\*(?!\/)/, ''))
            .join('\n'),
    })),
    ...strings.map((t) => ({ text: t })),
  ];
}

const one = (text) => text.replace(/\s+/g, ' ').trim();
// A line of code in a note: an import or export, a statement, or a whole call (`route(...),`, `.route(...)`).
const CODE_LINE =
  /^(?:import\s.*\sfrom\s['"]|import\s+['"]|export\s+(?:async\s|default\s|const\s|function\s|\{)|(?:const|let)\s+[\w${[][^=]*=|await\s|return\s|if\s*\()/;
const CALL_LINE = /^\.?[A-Za-z_$][\w$]*(?:\.[\w$]+)*\(.*[;,{)]$/;
// Inline `code` that is TypeScript to run: a call, an assignment, an arrow or an import.
const CODE_SPAN = /[\w$)\]]\s*\(|[^=!<>]=[^=>]|=>|^import\s/;
// SQL is checked by the live database check, not here.
const SQL = /^(?:create|alter|grant|revoke|drop|insert|select|update|delete|using|with)\b/i;

/** The code lines and the inline code spans of one file's notes. */
async function taughtCode(rel) {
  const found = [];

  for (const { text, markdown } of await taughtTexts(rel)) {
    const prose = [];
    let fence = null;

    for (const raw of text.split('\n')) {
      const line = raw.trim();

      if (markdown && line.startsWith('```')) {
        fence = fence === null ? line.slice(3) : null;
        continue;
      }

      if (fence !== null) {
        // A shell block is commands, not TypeScript; any other fenced block is code.
        if (!/^(bash|sh|shell)?$/.test(fence) && line) {
          found.push({ rel, kind: 'line', code: line });
        }

        continue;
      }

      if (!markdown && (CODE_LINE.test(line) || CALL_LINE.test(line)) && !SQL.test(line)) {
        found.push({ rel, kind: 'line', code: line.replace(/\s+\/\/\s.*$/, '') });
      } else {
        prose.push(line.replace(/^\/\/\s?/, ''));
      }
    }

    for (const m of prose.join(' ').matchAll(/`([^`]+)`/g)) {
      const code = m[1].trim();

      if (CODE_SPAN.test(code) && !SQL.test(code)) {
        found.push({ rel, kind: 'span', code });
      }
    }
  }

  return found;
}

/** README.md, eslint.config.js and the template's own source files. */
function noteFiles() {
  const files = [...NOTE_SOURCES];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;

      if (entry.isDirectory() && !NOT_NOTES.has(child)) {
        walk(child);
      } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
        files.push(child);
      }
    }
  };
  walk('src');

  return files;
}

/*
 * Every piece of code the notes teach, with where it runs. `pieces` are written in the note exactly so (spaces
 * aside); the copy places them, in order, in a function of that kind:
 *   component  a React component           browser  an async function in browser code
 *   route      a route module of its own (the pieces are the whole module, a default component added)
 *   hono       a Hono handler (`c`)         server   an async function in server code
 *   server-module  a module of its own under src/server
 *   routes     an entry of a RouteConfig list
 * `params` are the function's parameters, `head` and `tail` the check's own lines around the pieces.
 */
const NOTE_CODE = [
  {
    note: 'src/lib/neon-auth.ts',
    where: 'component',
    pieces: ['const { data, isPending, error } = useAuthSession();'],
    tail: 'return <p>{String(isPending)} {data?.user.id} {data?.user.email} {data?.user.name} {error?.message}</p>;',
  },
  {
    note: 'src/lib/neon-auth.ts',
    where: 'browser',
    params: 'email: string, password: string, name: string',
    pieces: [
      'const auth = await getAuthClient();',
      'await auth.signUp.email({ email, password, name });',
      'await auth.signIn.email({ email, password });',
      'await auth.signOut();',
    ],
  },
  {
    note: 'src/lib/neon-auth.ts',
    where: 'browser',
    params: 'projectId: string, title: string',
    pieces: [
      'const token = await getAuthToken();',
      'if (!token) return;',
      'const res = await api.api.tasks.$post({ json: { projectId, title } }, { headers: { Authorization: `Bearer ${token}` } });',
    ],
    tail: 'return res;',
  },
  {
    note: 'src/lib/neon-data.ts',
    where: 'browser',
    params: 'title: string, id: string',
    pieces: [
      'const db = createDataClient();',
      "const { data, error } = await db.from('todos').select('*').order('created_at', { ascending: false });",
      "await db.from('todos').insert({ title }).select().single();",
      "await db.from('todos').update({ done: true }).eq('id', id);",
      "await db.from('todos').delete().eq('id', id);",
    ],
    tail: 'return { data, error };',
  },
  {
    note: 'src/lib/neon-data.ts',
    where: 'route',
    pieces: [
      `import { env } from 'cloudflare:workers';
import { neon } from '@neondatabase/serverless';
import { requireEnv } from '@/server/env';

export async function loader() {
  const sql = neon(requireEnv(env, 'DATABASE_URL'));
  return { posts: await sql\`select id, title from posts where published order by title limit 50\` };
}`,
    ],
  },
  {
    note: 'src/server/routes/example-server-write.ts',
    where: 'hono',
    pieces: [
      'const user = await verifyAuthToken(c.req.raw);',
      "if (!user) return c.json({ error: 'Sign in first.' }, 401);",
    ],
    tail: 'return c.json({ id: user.sub });',
  },
  {
    note: 'src/server/routes/example-server-write.ts',
    where: 'server',
    params: 'url: string, id: string',
    pieces: [
      'const sql = neon(url)',
      'const rows = await sql`select * from tasks where id = ${id}`;',
    ],
    tail: 'return rows;',
  },
  {
    note: 'src/server/routes/example-server-write.ts',
    where: 'server',
    pieces: ['z.email()', 'z.uuid()', 'z.url()'],
    joiner: ', ',
    wrap: (code) => `return [${code}];`,
  },
  {
    note: 'src/server/env.ts',
    where: 'server-module',
    head: "import { requireEnv } from './env';",
    pieces: [
      "import { env } from 'cloudflare:workers';",
      "const url = requireEnv(env, 'DATABASE_URL');",
    ],
    tail: 'export { url };',
  },
  {
    note: 'src/lib/api.ts',
    where: 'browser',
    pieces: ['const res = await api.api.health.$get();', 'const data = await res.json();'],
    tail: 'return data;',
  },
  {
    note: 'src/lib/fetch.ts',
    where: 'browser',
    params: 'body: string',
    pieces: ["const res = await loggedFetch('/api/todos', { method: 'POST', body });"],
    tail: 'return res;',
  },
  {
    note: 'src/routes.ts',
    where: 'routes',
    pieces: ["route('about', 'routes/about.tsx'),"],
  },
  {
    note: 'src/server/index.ts',
    where: 'server',
    head: 'const todos = new Hono();',
    pieces: ['new Hono()', ".route('/api/todos', todos)"],
    joiner: '\n    ',
    wrap: (code) => `return ${code};`,
  },
  {
    note: 'eslint.config.js',
    where: 'server',
    params: 'request: Request',
    pieces: ['const user = await verifyAuthToken(request)'],
    tail: 'return user;',
  },
];

/** Code in the notes that is not compiled here, each with its reason. */
const NOT_TYPESCRIPT = {
  'auth.user_id()': 'SQL: the database function a policy reads',
  'uuid default gen_random_uuid()': 'SQL: a column definition',
  'z.string().email()': 'named as the deprecated form not to write',
  'if (!user)': 'a shape the await rule refuses, quoted in its comment',
  'Boolean(...)': 'a shape the await rule refuses, quoted in its comment',
  '.then(...)': 'a call shape, its arguments left out',
  'json()': "named as Remix 2's helper that doesn't exist here",
  'app.get(...)': 'a call shape, its arguments left out',
  'auth.signIn.email(...)':
    'a call shape, its arguments left out (the whole call is in src/lib/neon-auth.ts)',
  'auth.signUp.email(...)':
    'a call shape, its arguments left out (the whole call is in src/lib/neon-auth.ts)',
  ".route('/api/<name>', module)":
    'a call shape with a placeholder (the whole call is in src/server/index.ts)',
  'import type { AppType }': "src/lib/api.ts's own import, named in a comment",
  'not_found_handling = "none"': "wrangler.toml's setting, not TypeScript",
};

function placeNoteCode() {
  const files = {
    browser: [
      "import { getAuthClient, getAuthToken, useAuthSession } from '@/lib/neon-auth';",
      "import { createDataClient } from '@/lib/neon-data';",
      "import { api } from '@/lib/api';",
      "import { loggedFetch } from '@/lib/fetch';",
      "import { type RouteConfig, route } from '@react-router/dev/routes';",
      '',
    ],
    server: [
      "import { Hono } from 'hono';",
      "import { neon } from '@neondatabase/serverless';",
      "import { z } from 'zod';",
      "import { verifyAuthToken } from './neon-auth/require-user';",
      '',
    ],
  };
  const own = {};
  const routes = [];

  NOTE_CODE.forEach((entry, i) => {
    const joined = entry.pieces
      .map((p) => (entry.joiner || /[;{},]$/.test(p) ? p : `${p};`))
      .join(entry.joiner ?? '\n');
    const body = [entry.head, entry.wrap ? entry.wrap(joined) : joined, entry.tail]
      .filter(Boolean)
      .join('\n');
    const params = entry.params ?? '';

    switch (entry.where) {
      case 'component':
        files.browser.push(`export function Note${i}() {\n${body}\n}\n`);
        break;
      case 'browser':
        files.browser.push(`export async function note${i}(${params}) {\n${body}\n}\n`);
        break;
      case 'routes':
        files.browser.push(`export const note${i} = [\n${body}\n] satisfies RouteConfig;\n`);
        break;
      case 'route':
        own[`src/routes/check-note-${i}.tsx`] =
          `${body}\n\nexport default function CheckNote${i}() {\n  return <p>Check note ${i}</p>;\n}\n`;
        routes.push(`  route('check-note-${i}', 'routes/check-note-${i}.tsx'),`);
        break;
      case 'hono':
        files.server.push(
          `export const note${i} = new Hono().post('/', async (c) => {\n${body}\n});\n`,
        );
        break;
      case 'server':
        files.server.push(`export async function note${i}(${params}) {\n${body}\n}\n`);
        break;
      case 'server-module':
        own[`src/server/check-note-${i}.ts`] = `${body}\n`;
        break;
      default:
        throw new Error(`NOTE_CODE ${i}: unknown place ${entry.where}`);
    }
  });

  return {
    ...own,
    'src/features/check-notes.tsx': files.browser.join('\n'),
    'src/server/check-notes.ts': files.server.join('\n'),
    'src/routes/check-notes.tsx': `import * as notes from '@/features/check-notes';\n\nexport default function CheckNotes() {\n  return <p>{Object.keys(notes).length} notes</p>;\n}\n`,
    'src/routes.ts': `import { type RouteConfig, index, route } from '@react-router/dev/routes';\n\nexport default [\n  index('routes/home.tsx'),\n  route('check-notes', 'routes/check-notes.tsx'),\n${routes.join('\n')}\n] satisfies RouteConfig;\n`,
  };
}

describe('the code the notes teach', () => {
  // A type-check can't tell an option the client ignores from one it sends: run the note's lines themselves, signed
  // in and signed out. Every note that sends `Bearer ${token}` is run, so none can send `Bearer null`.
  test('the typed client sends the token the way the notes show it, to the protected route, and nothing when signed out', async () => {
    const { hc } = await import('hono/client');
    const sending = NOTE_CODE.filter((entry) =>
      entry.pieces.some((p) => p.includes('Bearer ${token}')),
    );
    assert.ok(sending.length > 0, "neon-auth.ts's notes show the token sent with the typed client");
    const AsyncFunction = (async () => {}).constructor;

    for (const entry of sending) {
      const [first, ...rest] = entry.pieces;
      assert.equal(
        first,
        'const token = await getAuthToken();',
        'the token comes from getAuthToken()',
      );
      const sent = [];
      const api = hc('http://check.example/', {
        fetch: async (input, init) => {
          const request = new Request(input, init);
          sent.push(
            `${request.method} ${new URL(request.url).pathname} ${request.headers.get('authorization')}`,
          );
          return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
        },
      });
      const run = (token) =>
        new AsyncFunction(
          'api',
          'token',
          'projectId',
          'title',
          `${rest.join('\n')}\n${entry.tail ?? ''}`,
        )(api, token, '00000000-0000-4000-8000-000000000000', 'A title');

      const res = await run('check-token');
      assert.equal(res.status, 200);
      assert.deepEqual(
        sent,
        [`POST ${PROTECTED_PATH} Bearer check-token`],
        'signed in: the token, to the protected route',
      );

      sent.length = 0;
      await run(null);
      assert.deepEqual(sent, [], 'signed out: nothing sent (no `Bearer null`)');
    }
  });

  test('every NOTE_CODE piece is written in its note as it is compiled', async () => {
    const missing = [];

    for (const entry of NOTE_CODE) {
      const said = one((await taughtTexts(entry.note)).map((t) => t.text).join('\n'));

      for (const piece of entry.pieces) {
        if (!said.includes(one(piece))) {
          missing.push(`${entry.note}: ${piece}`);
        }
      }
    }

    assert.deepEqual(
      missing,
      [],
      'NOTE_CODE pieces a note no longer says (fix the note or the entry)',
    );
  });

  test('every piece of code in the notes is compiled by the check, or listed as not TypeScript', async () => {
    const compiled = NOTE_CODE.flatMap((entry) => entry.pieces.map(one));
    const unchecked = [];

    for (const rel of noteFiles()) {
      for (const { kind, code } of await taughtCode(rel)) {
        const text = one(code);

        if (!(text in NOT_TYPESCRIPT) && !compiled.some((piece) => piece.includes(text))) {
          unchecked.push(`${rel} (${kind}): ${text}`);
        }
      }
    }

    assert.deepEqual(
      unchecked,
      [],
      'code in a note that no NOTE_CODE entry compiles: add the entry (or fix the code)',
    );
  });
});

describe('the code the notes teach, as written', () => {
  let dir;

  before(() => {
    dir = makeCopy('webdiy-notes-');

    for (const [file, source] of Object.entries(placeNoteCode())) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), source);
    }

    // The server's pieces are in the Worker the build makes, and the protected route example is mounted where
    // neon-auth.ts's notes say it is, so the typed client's call to it type-checks.
    const serverIndex = path.join(dir, 'src', 'server', 'index.ts');
    const server = fs.readFileSync(serverIndex, 'utf8');
    assert.equal(
      server.split(HEALTH_ROUTE).length,
      2,
      'src/server/index.ts chains the health route once',
    );
    fs.writeFileSync(
      serverIndex,
      `import './check-notes';\nimport exampleServerWrite from './routes/example-server-write';\n${server.replace(HEALTH_ROUTE, PROTECTED_MOUNT)}`,
    );
  });

  after(() => {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('type-checks and builds: pnpm run build, step by step', () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(scripts.build, 'react-router typegen && tsc -b && react-router build');

    for (const args of [
      ['node_modules/@react-router/dev/bin.cjs', 'typegen'],
      ['node_modules/typescript/bin/tsc', '-b'],
      ['node_modules/@react-router/dev/bin.cjs', 'build'],
    ]) {
      const run = spawnSync(process.execPath, args, {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      assert.equal(run.status, 0, `${args.join(' ')} failed:\n${run.stdout}\n${run.stderr}`);
    }
  });

  test("a loader's server code stays out of the browser's files", () => {
    const clientDir = path.join(dir, 'dist', 'client');
    assert.ok(fs.existsSync(clientDir), 'the build wrote dist/client');
    const holding = fs
      .readdirSync(clientDir, { recursive: true })
      .filter((rel) => rel.endsWith('.js'))
      .filter((rel) => {
        const code = fs.readFileSync(path.join(clientDir, rel), 'utf8');
        return (
          code.includes('is not set in the worker environment') ||
          code.includes('cloudflare:workers')
        );
      });
    assert.deepEqual(holding, [], 'a browser file holds requireEnv or cloudflare:workers');
  });

  // A loader's binding read where its module loads would throw as the server build loads, taking every page down
  // while the binding is unset (before the database is turned on).
  test('with no bindings set, every other page still renders', async () => {
    stubCloudflareWorkers();
    const { default: worker } = await import(
      pathToFileURL(path.join(dir, 'dist', 'server', 'index.js')).href
    );

    for (const p of ['/', '/check-notes']) {
      const res = await logged(async () => {
        const answer = await worker.fetch(
          new Request(`https://check.example${p}`, {
            headers: { 'user-agent': BOT, accept: 'text/html' },
          }),
          ASSETS_ENV,
          CTX,
        );
        assert.equal(
          answer.status,
          200,
          `${p} answered ${answer.status}: ${(await answer.text()).slice(0, 500)}`,
        );
      });
      assert.deepEqual(res, [], `${p} logged an error`);
    }
  });

  // The route the token example calls is a protected one: without a token it answers 401.
  test('the route the token example calls refuses a caller with no token', async () => {
    const note = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'neon-auth.ts'), 'utf8');
    assert.ok(
      note.includes(`mounted at ${PROTECTED_PATH}`),
      `neon-auth.ts's notes name ${PROTECTED_PATH}`,
    );
    assert.ok(
      note.includes(PROTECTED_ROUTE_FILE),
      `neon-auth.ts's notes name ${PROTECTED_ROUTE_FILE}`,
    );
    stubCloudflareWorkers();
    const { default: worker } = await import(
      pathToFileURL(path.join(dir, 'dist', 'server', 'index.js')).href
    );
    const res = await worker.fetch(
      new Request(`https://check.example${PROTECTED_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: '00000000-0000-4000-8000-000000000000',
          title: 'A title',
        }),
      }),
      ASSETS_ENV,
      CTX,
    );
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'Sign in first.' });
  });

  test('lints clean', () => {
    const files = Object.keys(placeNoteCode()).filter((f) => f !== 'src/routes.ts');
    const run = spawnSync(
      process.execPath,
      ['node_modules/eslint/bin/eslint.js', '--format', 'json', ...files],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } },
    );
    const found = JSON.parse(run.stdout).flatMap((r) =>
      r.messages.map(
        (m) => `${path.relative(dir, r.filePath)}:${m.line} ${m.ruleId}: ${m.message}`,
      ),
    );
    assert.deepEqual(found, []);
  });

  // `pnpm run check` is what a model runs after a change: it type-checks and lints, so a sign-in check left
  // without `await` (which TypeScript lets through) fails it.
  test('pnpm run check type-checks and lints: it passes here, and a guard without await fails it', () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const check = () =>
      spawnSync('/bin/sh', ['-c', scripts.check], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          PATH: `${path.join(dir, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH}`,
        },
      });

    const clean = check();
    assert.equal(clean.status, 0, `check failed:\n${clean.stdout}\n${clean.stderr}`);

    const guard = path.join(dir, 'src', 'server', 'check-unawaited.ts');
    fs.writeFileSync(
      guard,
      `import { verifyAuthToken } from './neon-auth/require-user';

export function guard(request: Request) {
  const user = verifyAuthToken(request);
  return !user ? new Response('Sign in first.', { status: 401 }) : null;
}
`,
    );

    try {
      const run = check();
      const out = `${run.stdout}\n${run.stderr}`;
      assert.notEqual(run.status, 0, `check passed a guard without await:\n${out}`);
      assert.doesNotMatch(out, /error TS\d+/, 'TypeScript, not lint, refused it');
      assert.match(out, /check-unawaited\.ts[\s\S]*write `await` before the call/);
    } finally {
      fs.rmSync(guard);
    }
  });
});
