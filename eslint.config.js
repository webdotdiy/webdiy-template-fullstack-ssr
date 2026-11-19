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

const loadContextRule = {
  'no-restricted-syntax': [
    'error',
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
  ],
};

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
      ...loadContextRule,
    },
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['src/server/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.serviceworker },
    },
    rules: { ...routerImportRule, ...loadContextRule },
  },
);
