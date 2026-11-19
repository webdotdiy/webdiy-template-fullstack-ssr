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
// It also checks what the server does with errors (an /api/* route's error answers JSON, a page's error the
// app's own error page, a server build that can't load is thrown on, an unknown path is not logged), the lint
// rules against React Router 7 and Remix habits, `requireEnv` and the logging fetch.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
    text: 'runs in the browser only',
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
  let dir;

  before(() => {
    dir = makeCopy('webdiy-lint-');
    fs.writeFileSync(
      path.join(dir, 'src', 'routes', 'check-lint.tsx'),
      `import { Link } from 'react-router-dom';
import { json } from '@remix-run/cloudflare';

type Context = { cloudflare: { env: Record<string, string> } };

export function loader({ context }: { context: Context }) {
  return json({ env: context.cloudflare.env, Link });
}

export function action({ context: { cloudflare } }: { context: Context }) {
  return cloudflare.env;
}
`,
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'server', 'check-lint.ts'),
      `type Context = { cloudflare: { env: Record<string, string> } };

export function read(context: Context) {
  const { cloudflare } = context;
  return cloudflare.env;
}
`,
    );
  });

  after(() => {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuse react-router-dom, @remix-run/* and the React Router 7 load context; the template itself is clean', () => {
    const run = spawnSync(
      process.execPath,
      ['node_modules/eslint/bin/eslint.js', '--format', 'json', '.'],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } },
    );
    const results = JSON.parse(run.stdout);
    const found = results.flatMap((r) =>
      r.messages.map((m) => `${path.relative(dir, r.filePath)} ${m.ruleId}: ${m.message}`),
    );
    const restricted = (file, rule) => found.filter((f) => f.startsWith(file) && f.includes(rule));

    assert.equal(
      restricted('src/routes/check-lint.tsx', 'no-restricted-imports').length,
      2,
      found.join('\n'),
    );
    assert.equal(
      restricted('src/routes/check-lint.tsx', 'no-restricted-syntax').length,
      2,
      found.join('\n'),
    );
    assert.equal(
      restricted('src/server/check-lint.ts', 'no-restricted-syntax').length,
      1,
      found.join('\n'),
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
