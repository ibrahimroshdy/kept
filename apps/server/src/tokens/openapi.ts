import type { SwaggerTransform } from '@fastify/swagger';
import { tokenAccessOf } from './access.js';

// The OpenAPI document says which routes a personal token can call (step-6 plan T10; D60, D63):
// a `bearerAuth` scheme, and `security: [{bearerAuth: []}]` on each route the token catalogue
// (tokens/access.ts) opens. The web app's own calls use the session cookie, which isn't
// described here; a route without `security` is for the signed-in app only.

export const TOKEN_SECURITY_SCHEMES = {
  bearerAuth: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'kpt_<lookup>_<secret>',
    description:
      'A personal token from Settings → Connections. It reads (or, read+write, changes) only its own locations, never more than its creator may.',
  },
} as const;

/** Wraps the zod transform: marks the token-open routes' `security`. */
export function tokenSecurityTransform(inner: SwaggerTransform): SwaggerTransform {
  return (args) => {
    const out = inner(args);
    const methods = Array.isArray(args.route.method) ? args.route.method : [args.route.method];
    const open = methods.some((m) => tokenAccessOf(m, args.url) !== 'none');
    if (!open) return out;
    return { ...out, schema: { ...out.schema, security: [{ bearerAuth: [] }] } };
  };
}
