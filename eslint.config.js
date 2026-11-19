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
          message: "Remix 2 packages don't exist here: import from 'react-router' (and return plain objects or data() from loaders).",
        },
      ],
    },
  ],
};

export default tseslint.config(
  // The neon-auth vendor dir is third-party code kept verbatim — see its README.
  { ignores: ['dist', '.wrangler', '.react-router', 'worker-configuration.d.ts', 'src/server/neon-auth/vendor'] },
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
    },
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['src/server/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.serviceworker },
    },
    rules: routerImportRule,
  },
);
