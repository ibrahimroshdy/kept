import type { preHandlerAsyncHookHandler } from 'fastify';
import { AppError } from './errors.js';

// Plain HTTP (D181): over `http:` Kept refuses "secret reveal, export, token creation, admin
// screens" that hand out or change a secret. Step 8 (plan T2) adds the one shared guard: the
// recovery kit's download, changing backup settings and the restic test use it (T9, T10), and
// T24's review checks that secret reveal, export and token creation do too.
//
// The scheme is KEPT_PUBLIC_URL's, the server's own source of truth for its address, never a
// request header a client or a misconfigured proxy could set. There is deliberately no variable
// to turn the guard off: a test that needs the route gives its app an https public URL
// (test/app.ts's `publicUrl`), as the existing test config does.

/** Whether the public URL is `https:`. */
export function isHttps(publicUrl: string): boolean {
  return new URL(publicUrl).protocol === 'https:';
}

/** Throws 403 `https_required` unless the public URL is `https:`. */
export function assertHttps(publicUrl: string): void {
  if (!isHttps(publicUrl)) {
    throw new AppError(
      'https_required',
      403,
      "Serve Kept over https (KEPT_PUBLIC_URL) to do this; secrets aren't sent over plain http.",
    );
  }
}

/** A preHandler for a route (or a plugin's hooks) that must not run over plain HTTP. */
export function requireHttps(publicUrl: string): preHandlerAsyncHookHandler {
  const https = isHttps(publicUrl);
  return async () => {
    if (!https) assertHttps(publicUrl);
  };
}
