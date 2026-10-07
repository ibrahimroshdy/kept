import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import sharp from 'sharp';
import { z } from 'zod';
import { audited } from '../audit/audited.js';
import type { KeptApp } from '../http/app.js';
import { AppError, forbidden, invalid, notFound } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { ImageLimiter } from '../storage/derivatives.js';

// Brand logos (step-4 plan T9; §1.3; D157, D172: uploads only; step-2 Q9, plan Q33):
//
// PUT    /api/v1/brands/:id/logo  (the image as the body) → 200 BrandLogo
// GET    /api/v1/brands/:id/logo  → image/png
// DELETE /api/v1/brands/:id/logo  → 204
//
// A brand is its account's, so its logo is too: a brand_logos row (0057, 0058), never a `files`
// row (a location's). The upload may be PNG, JPEG, WebP or SVG, told by its bytes (sharp's own
// sniffing), never by the declared type. It is rendered from the buffer to a PNG of at most
// 256 px a side, and only that PNG is kept: an SVG's bytes are never stored or served back
// (Q33). The step-4 T0 spike (docs/spikes/2026-09-30-step4-svg-logo.md) showed an SVG rendered
// from a buffer loads no external, `file:` or relative resource, refuses external entities and
// entity expansion, and fails a huge canvas on `limitInputPixels`; anything sharp can't render
// is a 415. Rendering runs in its own image limiter (one at a time).
//
// Set and removed by the account's admins (0058's policies), who manage its brands; read by
// whoever sees its brands. Each change is an account-level `brand` event (0044's policy lets an
// account's writers audit its brands).

const Id = z.object({ id: z.uuid() });
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_SIDE = 256;
const ACCEPTED = new Set(['png', 'jpeg', 'webp', 'svg']);

export const BrandLogoSchema = z.object({
  brandId: z.uuid(),
  width: z.number(),
  height: z.number(),
  sha256: z.string(),
  updatedAt: z.string(),
});
export type BrandLogo = z.infer<typeof BrandLogoSchema>;

const refused = () =>
  new AppError('unsupported_media_type', 415, 'Add a logo as a PNG, JPEG, WebP or SVG image.');

/** The brand's account, 404 unless the caller sees it; with `admin`, 403 unless they manage it. */
async function brandAccount(
  client: pg.ClientBase,
  brandId: string,
  admin: boolean,
): Promise<string> {
  const { rows } = await client.query<{ owner_account_id: string; manages: boolean }>(
    `SELECT b.owner_account_id,
            b.owner_account_id IN (SELECT kept.admin_account_ids()) AS manages
       FROM public.brands b WHERE b.id = $1`,
    [brandId],
  );
  const row = rows[0];
  if (!row) throw notFound();
  if (admin && !row.manages) throw forbidden('Only owners and admins change a brand’s logo.');
  return row.owner_account_id;
}

/** The PNG Kept keeps of an upload, or 415. */
export async function renderLogo(
  input: Buffer,
): Promise<{ png: Buffer; width: number; height: number }> {
  try {
    const opts = { limitInputPixels: 4096 * 4096, density: 72 } as const;
    const meta = await sharp(input, opts).metadata();
    if (!meta.format || !ACCEPTED.has(meta.format)) throw refused();
    const { data, info } = await sharp(input, opts)
      .rotate()
      .resize(LOGO_SIDE, LOGO_SIDE, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true });
    return { png: data, width: info.width, height: info.height };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw refused();
  }
}

type LogoRow = { width: number; height: number; sha256: string; updated_at: Date };

const view = (brandId: string, r: LogoRow): BrandLogo => ({
  brandId,
  width: r.width,
  height: r.height,
  sha256: r.sha256,
  updatedAt: r.updated_at.toISOString(),
});

export async function logoRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  const limiter = new ImageLimiter(1);

  app.get('/api/v1/brands/:id/logo', { schema: { params: Id } }, async (req, reply) => {
    const brandId = req.params.id.toLowerCase();
    const logo = await scopedRead(pools, req, async (_tx, client) => {
      await brandAccount(client, brandId, false);
      const { rows } = await client.query<{ png: Buffer; sha256: string }>(
        'SELECT png, sha256 FROM public.brand_logos WHERE brand_id = $1',
        [brandId],
      );
      return rows[0] ?? null;
    });
    if (!logo) throw notFound('This brand has no logo.');
    const etag = `"${logo.sha256}"`;
    reply.header('etag', etag).header('cache-control', 'private, max-age=86400, must-revalidate');
    reply.header('x-content-type-options', 'nosniff');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type('image/png').send(logo.png);
  });

  app.delete('/api/v1/brands/:id/logo', { schema: { params: Id } }, (req, reply) =>
    scopedWrite(pools, req, reply, async (tx, client, scope) => {
      const brandId = req.params.id.toLowerCase();
      const accountId = await brandAccount(client, brandId, true);
      const { rows } = await client.query<{ sha256: string }>(
        'DELETE FROM public.brand_logos WHERE brand_id = $1 RETURNING sha256',
        [brandId],
      );
      if (!rows[0]) throw notFound('This brand has no logo.');
      await audited(tx, {
        locationId: null,
        ownerAccountId: accountId,
        actor: { type: 'user', id: scope.userId },
        action: 'brand.logo_remove',
        entity: { type: 'brand', id: brandId },
        before: { logo_sha256: rows[0].sha256 },
        after: { logo_sha256: null },
        requestId: req.id,
      });
      return { status: 204, body: undefined };
    }),
  );

  // The upload, in a context of its own: its body is the image's bytes, buffered up to 2 MB.
  await app.register(async (scope) => {
    const child = scope.withTypeProvider<ZodTypeProvider>();
    child.removeAllContentTypeParsers();
    child.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: MAX_LOGO_BYTES },
      (_req: FastifyRequest, body: Buffer, done: (err: Error | null, body?: Buffer) => void) =>
        done(null, body),
    );
    child.put(
      '/api/v1/brands/:id/logo',
      { schema: { params: Id, response: { 200: BrandLogoSchema } } },
      async (req, reply) => {
        const body = req.body as Buffer | undefined;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          throw invalid('Send the logo image as the request body.');
        }
        const brandId = req.params.id.toLowerCase();
        // Who may set it is checked before the image is rendered, and again by the policy.
        await scopedRead(pools, req, (_tx, client) => brandAccount(client, brandId, true));
        if (limiter.full) {
          throw new AppError('internal', 503, 'Kept is busy with other images. Try again soon.', {
            retryAfter: 5,
          });
        }
        const logo = await limiter.run(() => renderLogo(body));
        const sha256 = createHash('sha256').update(logo.png).digest('hex');
        return scopedWrite(pools, req, reply, async (tx, client, s) => {
          const accountId = await brandAccount(client, brandId, true);
          const { rows: was } = await client.query<{ sha256: string }>(
            'DELETE FROM public.brand_logos WHERE brand_id = $1 RETURNING sha256',
            [brandId],
          );
          const { rows } = await client.query<LogoRow>(
            `INSERT INTO public.brand_logos (brand_id, owner_account_id, png, width, height, sha256,
                                             created_by)
             VALUES ($1, $2, $3, $4, $5, $6, kept.current_user_id())
             RETURNING width, height, sha256, updated_at`,
            [brandId, accountId, logo.png, logo.width, logo.height, sha256],
          );
          await audited(tx, {
            locationId: null,
            ownerAccountId: accountId,
            actor: { type: 'user', id: s.userId },
            action: 'brand.logo_set',
            entity: { type: 'brand', id: brandId },
            before: { logo_sha256: was[0]?.sha256 ?? null },
            after: { logo_sha256: sha256 },
            requestId: req.id,
          });
          return { status: 200, body: view(brandId, rows[0] as LogoRow) };
        });
      },
    );
  });
}
