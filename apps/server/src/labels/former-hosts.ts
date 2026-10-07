import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { AppError } from '../http/errors.js';

// Former hostnames (plan T16, Q32; D120; engineering spec §2.4). A printed label's link carries
// the host it was printed under; the in-app scanner ignores that host, but a phone's own camera
// opens the link as it is. When an instance moves (kept.home.example → kept.example.org), the
// admin lists the old names in `instance_settings.former_hostnames`, points them at Kept, and a
// request that arrives under one of them is sent to the public URL:
// - GET and HEAD: 301 to KEPT_PUBLIC_URL with the same path and query;
// - anything else: 421 Misdirected Request (a write is never replayed at another origin; the
//   CSRF hook would refuse it anyway).
//
// The list is read as kept_system (instance_settings is the instance admins' under kept_app) and
// kept for CACHE_MS in this process; the admin settings route drops the cache when it changes it,
// and other replicas pick the change up within that time.

export const FORMER_HOSTNAMES_KEY = 'former_hostnames';
export const MAX_FORMER_HOSTNAMES = 10;
const CACHE_MS = 30_000;

/** A DNS hostname (RFC 1123 labels), lower-cased; no port, no IP literal brackets. */
export const Hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/,
    'a hostname',
  );
export const FormerHostnames = z.array(Hostname).max(MAX_FORMER_HOSTNAMES);

let cache: { at: number; hosts: ReadonlySet<string> } | null = null;

/** Drops the cached list (the admin settings route, after a change; tests). */
export function forgetFormerHostnames(): void {
  cache = null;
}

export async function readFormerHostnames(system: pg.Pool): Promise<string[]> {
  const { rows } = await system.query<{ value: unknown }>(
    'SELECT value FROM public.instance_settings WHERE key = $1',
    [FORMER_HOSTNAMES_KEY],
  );
  const parsed = FormerHostnames.safeParse(rows[0]?.value ?? []);
  return parsed.success ? parsed.data : [];
}

async function formerHosts(system: pg.Pool): Promise<ReadonlySet<string>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.hosts;
  // A redirect is a convenience: when the list can't be read, the request is served as it came
  // (and the next read is tried after CACHE_MS), rather than failing every request.
  const hosts = new Set(await readFormerHostnames(system).catch((): string[] => []));
  cache = { at: Date.now(), hosts };
  return hosts;
}

/** The request's host name, without the port, lower-cased. */
function hostOf(req: FastifyRequest): string | null {
  const raw = req.headers.host;
  if (!raw) return null;
  try {
    return new URL(`http://${raw}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The onRequest hook. `publicUrl` is KEPT_PUBLIC_URL. */
export function formerHostHook(system: pg.Pool, publicUrl: string): onRequestAsyncHookHandler {
  const target = new URL(publicUrl);
  const base = publicUrl.replace(/\/+$/, '');
  return async function formerHost(req: FastifyRequest, reply: FastifyReply) {
    const host = hostOf(req);
    if (!host || host === target.hostname.toLowerCase()) return;
    const hosts = await formerHosts(system);
    if (!hosts.has(host)) return;
    if (req.method === 'GET' || req.method === 'HEAD') {
      return reply.redirect(`${base}${req.url}`, 301);
    }
    throw new AppError('validation', 421, `This address moved to ${target.origin}.`);
  };
}
