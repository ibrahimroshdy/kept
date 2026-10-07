import type { FastifyReply, FastifyRequest } from 'fastify';
import type { KeptApp } from './app.js';

// The web app's share target (D140; plan Q26). The manifest declares `POST /share`, and the
// service worker answers it on the phone: the shared files go straight into the capture queue.
// A share only reaches the server when the worker isn't active yet (the first visit, a cleared
// site). The server can't take it: it holds no session context for the files and must not keep
// them. So it sends the phone to the capture screen, which says "Open Kept once, then share
// again", and it does so in an onRequest hook, before the body is read or buffered.
//
// The hook runs before the CSRF check on purpose: a share from the OS share sheet carries the
// session cookie but no Origin a CSRF check can trust, and a redirect that writes nothing and
// points at our own page is safe to send to anyone.

export const SHARE_PATH = '/share';
export const SHARE_UNAVAILABLE = '/capture?share=unavailable';

/** Answers `POST /share` with 303 before anything else looks at the request. */
export async function shareGuard(req: FastifyRequest, reply: FastifyReply) {
  if (req.method !== 'POST') return;
  const pathname = req.url.split('?')[0];
  if (pathname !== SHARE_PATH) return;
  return reply.code(303).header('location', SHARE_UNAVAILABLE).send();
}

/** The route itself, so the share target is a known, public route (the route catalogue's
 * ALLOWLIST: redirect only). shareGuard() answers first; the handler is its twin. */
export async function shareRoutes(app: KeptApp): Promise<void> {
  app.post(SHARE_PATH, { schema: { hide: true }, config: { auth: 'none' } }, async (_req, reply) =>
    reply.code(303).header('location', SHARE_UNAVAILABLE).send(),
  );
}
