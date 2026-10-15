import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { textPdf } from './pdf.js';

// A stand-in Paperless-ngx for the D248 tests, on 127.0.0.1. It answers the calls Kept makes the
// way Paperless-ngx 3.3.1 answered them when recorded against a real server (test/fixtures/
// paperless/README.md): DRF pages `{count, next, previous, all, results}`, `X-Api-Version` and
// `X-Version` on authenticated answers only, 401 `{"detail": …}` for a bad token, 406 for an API
// version it doesn't serve and for a file asked for as `image/*` (DRF's content negotiation), a
// WebP thumbnail, and the PDF for preview and download.

export type FakeDoc = {
  id: number;
  title: string;
  created: string;
  document_type: number | null;
  correspondent: number | null;
  tags: number[];
  mime_type: string;
  content: string;
};

export class FakePaperless {
  token = 'f'.repeat(40);
  version = '3.3.1';
  /** The API versions it serves (3.3.1: 9 and 10). */
  versions = ['9', '10'];
  /** Every request, for asserting what Kept sent. */
  requests: { path: string; query: URLSearchParams; headers: IncomingMessage['headers'] }[] = [];
  /** When true, every connection is cut before an answer. */
  down = false;
  documentTypes = new Map<number, string>([
    [1, 'Receipt'],
    [2, 'Manual'],
    [3, 'Invoice'],
  ]);
  correspondents = new Map<number, string>([
    [1, 'Hardware Store'],
    [2, 'Bosch'],
  ]);
  tags = new Map<number, string>([
    [1, 'tools'],
    [2, 'Warranty'],
  ]);
  docs = new Map<number, FakeDoc>();
  #server: Server | null = null;
  #thumb: Buffer | null = null;
  #pdf = textPdf([['Bosch GSB 18V', 'Receipt total 1450.00']]);

  constructor() {
    for (const d of [
      {
        id: 12,
        title: 'Drill receipt',
        created: '2026-03-14',
        document_type: 1,
        correspondent: 1,
        tags: [1],
      },
      {
        id: 13,
        title: 'Bosch GSB 18V manual',
        created: '2025-11-02',
        document_type: 2,
        correspondent: 2,
        tags: [1],
      },
      {
        id: 14,
        title: 'Drill guarantee card',
        created: '2026-03-14',
        document_type: null,
        correspondent: 2,
        tags: [2],
      },
      {
        id: 21,
        title: 'Fridge invoice',
        created: '2025-08-30',
        document_type: 3,
        correspondent: null,
        tags: [],
      },
    ]) {
      this.docs.set(d.id, { ...d, mime_type: 'application/pdf', content: `${d.title} text` });
    }
  }

  get url(): string {
    const address = this.#server?.address() as AddressInfo | null | undefined;
    if (!address) throw new Error('FakePaperless: start() first');
    const port = address.port;
    return `http://127.0.0.1:${port}`;
  }

  get pdf(): Buffer {
    return this.#pdf;
  }

  async start(): Promise<void> {
    this.#thumb = await sharp({
      create: { width: 300, height: 420, channels: 3, background: '#f4f1ea' },
    })
      .webp()
      .toBuffer();
    this.#server = createServer((req, res) => this.#handle(req, res));
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  count(path: string): number {
    return this.requests.filter((r) => r.path === path).length;
  }

  #json(res: ServerResponse, status: number, body: unknown, authed: boolean) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (authed) {
      headers['x-api-version'] = this.versions.at(-1) as string;
      headers['x-version'] = this.version;
    }
    res.writeHead(status, headers).end(JSON.stringify(body));
  }

  #docOut(d: FakeDoc, fields: string[] | null) {
    const full: Record<string, unknown> = {
      id: d.id,
      correspondent: d.correspondent,
      document_type: d.document_type,
      storage_path: null,
      title: d.title,
      content: d.content,
      tags: d.tags,
      created: d.created,
      created_date: d.created,
      modified: `${d.created}T10:00:00.000000Z`,
      added: `${d.created}T10:00:00.000000Z`,
      deleted_at: null,
      archive_serial_number: null,
      original_file_name: `${d.title}.pdf`,
      archived_file_name: `${d.title}.pdf`,
      owner: 3,
      user_can_change: true,
      is_shared_by_requester: false,
      notes: [],
      custom_fields: [],
      page_count: 1,
      mime_type: d.mime_type,
    };
    if (!fields) return full;
    return Object.fromEntries(Object.entries(full).filter(([k]) => fields.includes(k)));
  }

  #handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://fake');
    this.requests.push({ path: url.pathname, query: url.searchParams, headers: req.headers });
    if (this.down) {
      req.socket.destroy();
      return;
    }
    if (req.headers.authorization !== `Token ${this.token}`) {
      return this.#json(res, 401, { detail: 'Invalid token.' }, false);
    }
    const accept = String(req.headers.accept ?? '');
    const asked = /version=(\d+)/.exec(accept)?.[1];
    if (asked && !this.versions.includes(asked)) {
      return this.#json(res, 406, { detail: `Invalid version in "Accept" header.` }, true);
    }
    const fields = url.searchParams.get('fields')?.split(',') ?? null;
    const path = url.pathname;
    const one = /^\/api\/documents\/(\d+)\/(thumb|preview|download)?\/?$/.exec(path);
    if (path === '/api/documents/') {
      const q = (url.searchParams.get('query') ?? '').toLowerCase();
      const all = [...this.docs.values()]
        .filter((d) => {
          if (!q) return true;
          const words = [
            d.title,
            d.content,
            this.correspondents.get(d.correspondent ?? 0) ?? '',
            this.documentTypes.get(d.document_type ?? 0) ?? '',
            ...d.tags.map((t) => this.tags.get(t) ?? ''),
          ]
            .join(' ')
            .toLowerCase();
          return q.split(/\s+/).every((w) => words.includes(w));
        })
        .sort((a, b) => b.created.localeCompare(a.created) || b.id - a.id);
      const size = Number(url.searchParams.get('page_size') ?? 25);
      const page = Number(url.searchParams.get('page') ?? 1);
      if ((page - 1) * size >= all.length && page > 1) {
        return this.#json(res, 404, { detail: 'Invalid page.' }, true);
      }
      const slice = all.slice((page - 1) * size, page * size);
      return this.#json(
        res,
        200,
        {
          count: all.length,
          next: page * size < all.length ? `${this.url}${path}?page=${page + 1}` : null,
          previous: page > 1 ? `${this.url}${path}?page=${page - 1}` : null,
          all: all.map((d) => d.id),
          results: slice.map((d) => this.#docOut(d, fields)),
        },
        true,
      );
    }
    if (one) {
      const d = this.docs.get(Number(one[1]));
      if (!d) return this.#json(res, 404, { detail: 'No Document matches the given query.' }, true);
      if (!one[2]) return this.#json(res, 200, this.#docOut(d, fields), true);
      // Recorded: a file asked for with `Accept: image/*` is 406; `*/*` or JSON's is served.
      if (!/\*\/\*|application\/json/.test(accept)) {
        return this.#json(
          res,
          406,
          { detail: 'Could not satisfy the request Accept header.' },
          true,
        );
      }
      if (one[2] === 'thumb') {
        res.writeHead(200, { 'content-type': 'image/webp' }).end(this.#thumb);
        return;
      }
      res
        .writeHead(200, {
          'content-type': 'application/pdf',
          'content-length': String(this.#pdf.length),
          'content-disposition': `${one[2] === 'preview' ? 'inline' : 'attachment'}; filename="${d.title}.pdf"`,
        })
        .end(this.#pdf);
      return;
    }
    const names = /^\/api\/(document_types|correspondents|tags)\/$/.exec(path);
    if (names) {
      const map =
        names[1] === 'document_types'
          ? this.documentTypes
          : names[1] === 'correspondents'
            ? this.correspondents
            : this.tags;
      const ids = (url.searchParams.get('id__in') ?? '').split(',').filter(Boolean).map(Number);
      const results = [...map.entries()]
        .filter(([id]) => ids.length === 0 || ids.includes(id))
        .map(([id, name]) => ({ id, slug: name.toLowerCase(), name, document_count: 1 }));
      return this.#json(
        res,
        200,
        {
          count: results.length,
          next: null,
          previous: null,
          all: results.map((r) => r.id),
          results,
        },
        true,
      );
    }
    return this.#json(res, 404, { detail: 'Not found.' }, true);
  }
}
