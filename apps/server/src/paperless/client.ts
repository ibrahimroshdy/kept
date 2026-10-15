/**
 * Kept's Paperless-ngx client (1.x, D248). Every call goes through the server: the browser never
 * sees the token, and never talks to Paperless except through "Open in Paperless" links.
 *
 * The API, as Paperless-ngx documents it (docs/api.md and the source at v2.16.0 and v3.3.1):
 * - **Version 9**, asked for on every call with `Accept: application/json; version=9`. Paperless
 *   2.16.0 added it and 3.x still serves it (ALLOWED_VERSIONS ["9", "10"] in 3.3.1); an older
 *   server answers 406, which reads as `too_old`. Version 9's `created` is a date.
 * - **Token auth**, `Authorization: Token <token>` (the token from the person's Paperless
 *   profile). An authenticated answer carries `X-Api-Version` and `X-Version` (the server's
 *   version, which "Test connection" shows).
 * - `GET /api/documents/?page=&page_size=&fields=…` lists, newest first with `ordering=-created`;
 *   `query=` adds Paperless's full-text search (title, content, correspondent, type and tags).
 *   `fields=` trims each document to what the picker shows.
 * - `GET /api/documents/<id>/?fields=…`: one document's metadata.
 * - `GET /api/document_types/`, `/api/correspondents/`, `/api/tags/` with `id__in=1,2,3`: the
 *   names behind a page of documents' ids.
 * - `GET /api/documents/<id>/thumb/` (an image, WebP on current servers), `…/preview/` (the
 *   archived PDF, or the original, inline) and `…/download/` (the same, as an attachment).
 *
 * Every call is SSRF-guarded (net/ssrf.ts: private addresses only with the admin's switch,
 * redirects refused), has CALL_TIMEOUT_MS for the whole answer, and reads at most a capped number
 * of bytes. Plain http is accepted only for an address on the local network (D248): the token
 * would otherwise cross the internet in the clear. Nothing here logs; an error names what went
 * wrong (`paperlessError`), never the token.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { guardedFetch, isPrivateAddress, PrivateAddressError } from '../net/ssrf.js';
import type { PaperlessConfig } from './config.js';

export const PAPERLESS_API_VERSION = 9;
export const PAPERLESS_ACCEPT = `application/json; version=${PAPERLESS_API_VERSION}`;
/** The oldest Paperless-ngx that serves API version 9. */
export const PAPERLESS_MIN_VERSION = '2.16.0';
/** One call's time limit, connection to last byte. */
export const CALL_TIMEOUT_MS = 10_000;
/** The most of one JSON answer read: a page of 25 trimmed documents is a few KiB. */
export const MAX_JSON_BYTES = 2 << 20;
/** The most of one thumbnail read. */
export const MAX_THUMB_BYTES = 2 << 20;
/** Documents a page of the picker shows. */
export const PAGE_SIZE = 24;

export const PAPERLESS_ERRORS = [
  'private_address',
  'http_public',
  'unreachable',
  'timeout',
  'redirect',
  'auth_failed',
  'not_paperless',
  'too_old',
  'not_found',
  'too_large',
  'failed',
] as const;
export type PaperlessErrorCode = (typeof PAPERLESS_ERRORS)[number];

const HINTS: Record<PaperlessErrorCode, string> = {
  private_address:
    'That address is on a private network. An instance admin can allow private addresses (Admin → Settings).',
  http_public:
    'Use https:// for a Paperless outside your network: over http the token would travel unencrypted.',
  unreachable: "Kept couldn't reach Paperless at that address.",
  timeout: "Paperless didn't answer within 10 seconds.",
  redirect: 'That address answered with a redirect. Use the address it leads to.',
  auth_failed: 'Paperless refused the token, or its user may not see this document.',
  not_paperless: "That address doesn't answer like Paperless-ngx.",
  too_old: `Kept needs Paperless-ngx ${PAPERLESS_MIN_VERSION} or later.`,
  not_found: 'Paperless has no such document any more, or its user may not see it.',
  too_large: 'That document is larger than Kept takes.',
  failed: "Paperless couldn't answer that.",
};

/** A call that failed: 502 `paperless_unreachable`, or 404 for a document Paperless doesn't have. */
export class PaperlessError extends AppError {
  constructor(readonly reason: PaperlessErrorCode) {
    super(
      reason === 'not_found' ? 'not_found' : 'paperless_unreachable',
      reason === 'not_found' ? 404 : 502,
      HINTS[reason],
      { paperlessError: reason },
    );
    this.name = 'PaperlessError';
  }
}

export type ClientOptions = {
  allowPrivate: boolean;
  /** Tests: a stubbed DNS answer for both the http rule and the guard. */
  resolve?: (host: string) => Promise<string[]>;
};

const systemResolve = async (host: string) =>
  (await dnsLookup(host, { all: true })).map((a) => a.address);

/** Plain http only to an address on the local network (every address the name resolves to). */
async function requireSecureOrLocal(url: URL, resolve: ClientOptions['resolve']): Promise<void> {
  if (url.protocol === 'https:') return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host) !== 0) addresses = [host];
  else {
    try {
      addresses = await (resolve ?? systemResolve)(host);
    } catch {
      throw new PaperlessError('unreachable');
    }
  }
  if (addresses.length === 0 || !addresses.every(isPrivateAddress)) {
    throw new PaperlessError('http_public');
  }
}

/** Whether `e` (or its cause) is a refused redirect (undici: "unexpected redirect"). */
function isRedirect(e: unknown): boolean {
  for (let c: unknown = e, i = 0; c && i < 4; c = (c as { cause?: unknown }).cause, i++) {
    if (/redirect/i.test(String((c as { message?: unknown }).message ?? ''))) return true;
  }
  return false;
}

/** An answer's bytes, at most `max`. */
async function readCapped(res: Response, max: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new PaperlessError('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** A Paperless document as version 9 answers it, trimmed to what Kept reads. */
const Doc = z.object({
  id: z.number().int().positive(),
  title: z.string().max(10_000),
  created: z.string().nullable().optional(),
  document_type: z.number().int().nullable().optional(),
  correspondent: z.number().int().nullable().optional(),
  tags: z.array(z.number().int()).optional(),
  mime_type: z.string().max(200).nullable().optional(),
});
export type PaperlessDocument = z.infer<typeof Doc>;

const Page = z.object({ count: z.number().int(), results: z.array(Doc) });
const Names = z.object({
  results: z.array(z.object({ id: z.number().int(), name: z.string().max(10_000) })),
});

/** The fields the picker and the cache read: `fields=` keeps the answers small. */
const DOC_FIELDS = 'id,title,created,document_type,correspondent,tags,mime_type';

export type FileAnswer = {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  length: number | null;
};

export class PaperlessClient {
  readonly #root: URL;
  readonly #token: string;
  readonly #opts: ClientOptions;
  readonly #fetch: typeof fetch;

  constructor(config: PaperlessConfig, opts: ClientOptions) {
    this.#root = new URL(config.baseUrl);
    this.#token = config.token;
    this.#opts = opts;
    const resolve = opts.resolve;
    this.#fetch = guardedFetch({
      allowPrivate: opts.allowPrivate,
      ...(resolve
        ? {
            resolve: (host, cb) =>
              void resolve(host).then(
                (addrs) =>
                  cb(
                    null,
                    addrs.map((a) => ({ address: a, family: isIP(a) || 4 })),
                  ),
                (err: Error) => cb(err, []),
              ),
          }
        : {}),
    });
  }

  /** The URL of `path` (`/api/…`, with a trailing slash) under the root, with `query`. */
  url(path: string, query: Record<string, string | number> = {}): URL {
    const url = new URL(this.#root.href);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    return url;
  }

  /** One GET; the answer is checked for its status, not yet read. `signal` ends it early. */
  async #get(url: URL, accept: string, signal?: AbortSignal): Promise<Response> {
    await requireSecureOrLocal(url, this.#opts.resolve);
    const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
    const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method: 'GET',
        headers: { authorization: `Token ${this.#token}`, accept },
        signal: both,
      });
    } catch (e) {
      if (e instanceof PrivateAddressError) throw new PaperlessError('private_address');
      if (timeout.aborted) throw new PaperlessError('timeout');
      if (isRedirect(e)) throw new PaperlessError('redirect');
      throw new PaperlessError('unreachable');
    }
    if (res.status >= 200 && res.status < 300) return res;
    await res.body?.cancel().catch(() => {});
    if (res.status === 401 || res.status === 403) throw new PaperlessError('auth_failed');
    if (res.status === 404) throw new PaperlessError('not_found');
    if (res.status === 406) throw new PaperlessError('too_old');
    throw new PaperlessError('failed');
  }

  async #json<T>(url: URL, schema: z.ZodType<T>): Promise<{ data: T; headers: Headers }> {
    const res = await this.#get(url, PAPERLESS_ACCEPT);
    let json: unknown;
    try {
      json = JSON.parse((await readCapped(res, MAX_JSON_BYTES)).toString('utf8'));
    } catch (e) {
      if (e instanceof PaperlessError) throw e;
      throw new PaperlessError('not_paperless');
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new PaperlessError('not_paperless');
    return { data: parsed.data, headers: res.headers };
  }

  /** "Test connection": an authenticated call, and the server's own version from `X-Version`. */
  async ping(): Promise<{ version: string }> {
    const { headers } = await this.#json(
      this.url('/api/documents/', { page_size: 1, fields: 'id' }),
      Page.pick({ count: true }).passthrough(),
    );
    const apiVersion = Number(headers.get('x-api-version'));
    const version = headers.get('x-version')?.trim();
    // Only an authenticated answer carries the headers; one without is not Paperless's.
    if (!version || !Number.isFinite(apiVersion)) throw new PaperlessError('not_paperless');
    if (apiVersion < PAPERLESS_API_VERSION) throw new PaperlessError('too_old');
    return { version: version.slice(0, 40) };
  }

  /** A page of documents, newest first, or Paperless's full-text matches for `q`. */
  async search(q: string, page: number): Promise<{ count: number; results: PaperlessDocument[] }> {
    const query: Record<string, string | number> = {
      page,
      page_size: PAGE_SIZE,
      fields: DOC_FIELDS,
    };
    if (q) query.query = q;
    else query.ordering = '-created';
    const { data } = await this.#json(this.url('/api/documents/', query), Page);
    return data;
  }

  /** One document's metadata. */
  async document(id: number): Promise<PaperlessDocument> {
    const { data } = await this.#json(
      this.url(`/api/documents/${id}/`, { fields: DOC_FIELDS }),
      Doc,
    );
    return data;
  }

  /** The names of these document types, correspondents or tags, by id. */
  async names(
    kind: 'document_types' | 'correspondents' | 'tags',
    ids: readonly number[],
  ): Promise<Map<number, string>> {
    const unique = [...new Set(ids)].filter((i) => i > 0).slice(0, 100);
    if (unique.length === 0) return new Map();
    const { data } = await this.#json(
      this.url(`/api/${kind}/`, { id__in: unique.join(','), page_size: 100 }),
      Names,
    );
    return new Map(data.results.map((r) => [r.id, r.name]));
  }

  /** A document's thumbnail, read whole (it is small). */
  async thumb(id: number): Promise<{ bytes: Buffer; contentType: string }> {
    const res = await this.#get(this.url(`/api/documents/${id}/thumb/`), '*/*');
    const contentType = imageType(res.headers.get('content-type'));
    if (!contentType) {
      await res.body?.cancel().catch(() => {});
      throw new PaperlessError('not_paperless');
    }
    return { bytes: await readCapped(res, MAX_THUMB_BYTES), contentType };
  }

  /** A document's preview (`inline`) or download, as a stream the caller reads and caps. */
  async file(id: number, which: 'preview' | 'download', signal?: AbortSignal): Promise<FileAnswer> {
    const res = await this.#get(this.url(`/api/documents/${id}/${which}/`), '*/*', signal);
    if (!res.body) throw new PaperlessError('failed');
    const length = Number(res.headers.get('content-length'));
    return {
      body: res.body as ReadableStream<Uint8Array>,
      contentType:
        (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]?.trim() ??
        'application/octet-stream',
      length: Number.isFinite(length) && length > 0 ? length : null,
    };
  }
}

/** The thumbnail types passed on to the browser; anything else is refused. */
function imageType(raw: string | null): string | null {
  const type = raw?.split(';')[0]?.trim().toLowerCase() ?? '';
  return ['image/webp', 'image/png', 'image/jpeg'].includes(type) ? type : null;
}
