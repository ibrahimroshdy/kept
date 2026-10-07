import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId } from '@kept/shared';
import type { LightMyRequestResponse } from 'fastify';
import type { TestApp } from './app.js';
import { sha256 } from './files.js';
import { call, freshIp } from './people.js';

// Archive imports through the front door (step-7 plan T8–T10): declare an archive, upload its
// bytes the way the web's import stepper does (one raw PUT with X-Kept-Sha256), and the Homebox
// fixtures from spike H1 (test/fixtures/homebox/README.md).

const HOMEBOX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'homebox');

/** A committed Homebox v0.26.2 export: `home` (Home) or `family` (بيت العائلة). */
export const homeboxZip = (name: 'home' | 'family') =>
  readFile(path.join(HOMEBOX, `homebox-0.26.2-${name}.zip`));

type As = { cookie: string };

/** POST /api/v1/imports/archive for `bytes`. */
export function declareArchive(
  t: TestApp,
  as: As,
  bytes: Buffer,
  opts: { id?: string; source?: 'homebox_zip' | 'kept_zip'; size?: number; sha?: string } = {},
): Promise<LightMyRequestResponse> {
  return call(t, '/api/v1/imports/archive', {
    as,
    body: {
      id: opts.id ?? newId(),
      source: opts.source ?? 'homebox_zip',
      bytes: opts.size ?? bytes.length,
      sha256: opts.sha ?? sha256(bytes),
    },
  });
}

/** PUT /api/v1/imports/:id/archive with `bytes` (X-Kept-Sha256 their own unless given). */
export function putArchive(
  t: TestApp,
  as: As,
  id: string,
  bytes: Buffer,
  opts: { sha?: string } = {},
): Promise<LightMyRequestResponse> {
  return t.app.inject({
    method: 'PUT',
    url: `/api/v1/imports/${id}/archive`,
    headers: {
      origin: t.publicUrl,
      cookie: as.cookie,
      'content-type': 'application/zip',
      'x-kept-sha256': opts.sha ?? sha256(bytes),
    },
    remoteAddress: freshIp(),
    payload: bytes,
  });
}

/** Declares and uploads `bytes`; answers the run's id. Throws unless both succeed. */
export async function uploadArchive(
  t: TestApp,
  as: As,
  bytes: Buffer,
  source: 'homebox_zip' | 'kept_zip' = 'homebox_zip',
): Promise<string> {
  const id = newId();
  const made = await declareArchive(t, as, bytes, { id, source });
  if (made.statusCode !== 201) throw new Error(`declare: ${made.statusCode} ${made.body}`);
  const put = await putArchive(t, as, id, bytes);
  if (put.statusCode !== 200) throw new Error(`upload: ${put.statusCode} ${put.body}`);
  return id;
}
