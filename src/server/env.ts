/*
 * Reads a required binding, with an error that says how to fix a missing one.
 *
 *   import { env } from 'cloudflare:workers';
 *   const url = requireEnv(env, 'DATABASE_URL');
 */
export function requireEnv(env: object, name: string): string {
  const value = (env as Record<string, unknown>)[name];

  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  throw new Error(
    `${name} is not set in the worker environment. On WebDIY this binding is ` +
      `injected when the dev server starts: if the variable was provisioned or ` +
      `changed after the server started, restart the dev server to deliver it. ` +
      `It never appears in .env files or the shell.`,
  );
}
