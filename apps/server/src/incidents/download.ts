import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pools } from '../db/pools.js';
import { withSystem } from '../db/scope.js';
import { pgErrorOf } from '../http/errors.js';
import { BlobNotFoundError, type FileStorage } from '../storage/blob-store.js';
import { contentDisposition } from '../storage/disposition.js';
import { tokenHash } from './claim-pack.js';

// GET /x/<token>: a claim pack's download link (D158, D180; Q19; engineering spec §5). No session
// is read: the token is the key. kept.export_download() (kept_system's door, 0049) refuses a
// revoked, expired, unknown or unbuilt link and one whose creator no longer holds owner or admin
// on the location (D180: every download re-checks the role), all alike, and counts the download.
// Any refusal is a 410 with a small page, "This link has expired", in the Accept-Language's
// language: a link that never existed says the same, so a guess learns nothing. The token is
// redacted from the request log (http/logger.ts), and only its sha256 is ever stored.

const LANGS = ['en', 'ar', 'fr', 'de', 'it'] as const;
type Lang = (typeof LANGS)[number];

const EXPIRED: Record<Lang, { title: string; body: string }> = {
  en: {
    title: 'This link has expired',
    body: 'Ask whoever shared it for a new link.',
  },
  ar: {
    title: 'انتهت صلاحية هذا الرابط',
    body: 'اطلب رابطًا جديدًا ممن شاركه معك.',
  },
  fr: {
    title: 'Ce lien a expiré',
    body: 'Demandez un nouveau lien à la personne qui vous l’a envoyé.',
  },
  de: {
    title: 'Dieser Link ist abgelaufen',
    body: 'Bitte die Person, die ihn geteilt hat, um einen neuen Link.',
  },
  it: {
    title: 'Questo link è scaduto',
    body: 'Chiedi un nuovo link a chi te l’ha condiviso.',
  },
};

/** The first language of Accept-Language that the page speaks, by q order; English otherwise. */
export function langOf(header: string | undefined): Lang {
  if (!header) return 'en';
  const ranked = header
    .split(',')
    .map((part, i) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag: tag.toLowerCase(), weight: Number.isFinite(weight) ? weight : 0, i };
    })
    .filter((x) => x.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.i - b.i);
  for (const { tag } of ranked) {
    const base = tag.split('-')[0] as Lang;
    if ((LANGS as readonly string[]).includes(base)) return base;
  }
  return 'en';
}

const html = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function expiredPage(lang: Lang): string {
  const t = EXPIRED[lang];
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${html(t.title)}</title></head>
<body><main><h1>${html(t.title)}</h1><p>${html(t.body)}</p></main></body>
</html>
`;
}

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

/** The day a pack was made, from its key `x/<runId>.zip`: a UUIDv7's first 48 bits are its
 * creation time in milliseconds (RFC 9562). */
export function packDay(key: string): string {
  const hex = /^x\/([0-9a-f]{8})-([0-9a-f]{4})-7/.exec(key);
  const ms = hex ? Number.parseInt(`${hex[1]}${hex[2]}`, 16) : Date.now();
  return new Date(ms).toISOString().slice(0, 10);
}

function gone(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const lang = langOf(req.headers['accept-language']);
  return reply
    .code(410)
    .header('content-type', 'text/html; charset=utf-8')
    .header('content-language', lang)
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .header('x-robots-tag', 'noindex')
    .send(expiredPage(lang));
}

export async function serveClaimPack(
  deps: { pools: Pick<Pools, 'system'>; files: FileStorage | null },
  token: string,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (!deps.files || !TOKEN.test(token)) return gone(req, reply);
  let found: { storage_key: string; bytes: string } | undefined;
  try {
    found = await withSystem(deps.pools.system, async (_tx, c) => {
      const { rows } = await c.query<{ storage_key: string; bytes: string }>(
        'SELECT d.storage_key, d.bytes::text AS bytes FROM kept.export_download($1) d',
        [tokenHash(token)],
      );
      return rows[0];
    });
  } catch (err) {
    if (pgErrorOf(err)?.code === '42501') return gone(req, reply);
    throw err;
  }
  if (!found) return gone(req, reply);
  let body: import('node:stream').Readable;
  try {
    body = await deps.files.blobs.stream(found.storage_key);
  } catch (err) {
    if (err instanceof BlobNotFoundError) return gone(req, reply);
    throw err;
  }
  const day = packDay(found.storage_key);
  return reply
    .header('content-type', 'application/zip')
    .header('content-length', found.bytes)
    .header('content-disposition', contentDisposition('attachment', `kept-claim-${day}.zip`))
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .header('x-robots-tag', 'noindex')
    .send(body);
}
