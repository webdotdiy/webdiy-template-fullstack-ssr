import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/*
 * React Router is imported from `react-router`. `react-router-dom` is the old
 * package name: it is not installed here and does not exist in React Router 8.
 * `@remix-run/*` is Remix 2, which React Router replaced: its imports and its
 * `json()` helper don't exist here.
 */
const routerImportRule = {
  'no-restricted-imports': [
    'error',
    {
      paths: [
        { name: 'react-router-dom', message: "Import from 'react-router' instead (same API)." },
      ],
      patterns: [
        {
          group: ['react-router-dom/*'],
          message: "Import from 'react-router' instead (same API).",
        },
        {
          group: ['@remix-run/*'],
          message:
            "Remix 2 packages don't exist here: import from 'react-router' (and return plain objects or data() from loaders).",
        },
      ],
    },
  ],
};

/*
 * React Router 7's load context (`context.cloudflare.env`) is not passed in
 * this app: under React Router 8 reading it throws on every request. Bindings
 * come from `import { env } from 'cloudflare:workers'`.
 */
const LOAD_CONTEXT_MESSAGE =
  "There is no load context here: read bindings with `import { env } from 'cloudflare:workers'`.";

const loadContextSyntax = [
  {
    selector: "MemberExpression[object.name='context'][property.name='cloudflare']",
    message: LOAD_CONTEXT_MESSAGE,
  },
  {
    selector: "Property[key.name='context'] > ObjectPattern > Property[key.name='cloudflare']",
    message: LOAD_CONTEXT_MESSAGE,
  },
  {
    selector:
      "VariableDeclarator[init.name='context'] > ObjectPattern > Property[key.name='cloudflare']",
    message: LOAD_CONTEXT_MESSAGE,
  },
];

/*
 * verifyAuthToken() and getAuthToken() return a Promise. Without `await` the
 * result is the Promise itself, which is never null or false, so any check of
 * it (`if (!user)`, `user === null`, `Boolean(...)`) lets every caller
 * through. Lint refuses a call to either one that is not awaited where it is
 * made (`.then(...)` on it is allowed too), and either one imported, exported
 * or destructured under another name.
 */
const AUTH_AWAIT_MESSAGE =
  'This returns a Promise: write `await` before the call (`const user = await verifyAuthToken(request)`). Without it the result is never null or false, so a sign-in check lets every caller through.';

const AUTH_NAME = '/^(verifyAuthToken|getAuthToken)$/';
const AUTH_NAME_MESSAGE =
  'Use verifyAuthToken and getAuthToken under their own names (never imported, exported or destructured under another), so lint can check every call is awaited.';
const AUTH_CALL = `CallExpression[callee.name=${AUTH_NAME}]`;
const AUTH_MEMBER_CALL = `CallExpression[callee.property.name=${AUTH_NAME}]`;
// Awaited where it is made, an optional call (`?.`) or an `as` cast between included.
const AWAITED =
  ':not(AwaitExpression > CallExpression)' +
  ':not(AwaitExpression > ChainExpression > CallExpression)' +
  ':not(AwaitExpression > TSAsExpression > CallExpression)';
const CHAINED =
  ':not(MemberExpression[property.name=/^(then|catch|finally)$/] > CallExpression.object)';

const authAwaitSyntax = [
  { selector: `${AUTH_CALL}${AWAITED}${CHAINED}`, message: AUTH_AWAIT_MESSAGE },
  { selector: `${AUTH_MEMBER_CALL}${AWAITED}${CHAINED}`, message: AUTH_AWAIT_MESSAGE },
  {
    selector: `ImportSpecifier[imported.name=${AUTH_NAME}]:not([local.name=${AUTH_NAME}])`,
    message: AUTH_NAME_MESSAGE,
  },
  {
    selector: `ExportSpecifier[local.name=${AUTH_NAME}]:not([exported.name=${AUTH_NAME}])`,
    message: AUTH_NAME_MESSAGE,
  },
  {
    selector: `ObjectPattern > Property[key.name=${AUTH_NAME}]:not([value.name=${AUTH_NAME}])`,
    message: AUTH_NAME_MESSAGE,
  },
];

const syntaxRule = { 'no-restricted-syntax': ['error', ...loadContextSyntax, ...authAwaitSyntax] };

export default tseslint.config(
  // The neon-auth vendor dir is third-party code kept verbatim — see its README.
  {
    ignores: [
      'dist',
      '.wrangler',
      '.react-router',
      '.github',
      'worker-configuration.d.ts',
      'src/server/neon-auth/vendor',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/server/**'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...routerImportRule,
      ...syntaxRule,
    },
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['src/server/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.serviceworker },
    },
    rules: { ...routerImportRule, ...syntaxRule },
  },
);
