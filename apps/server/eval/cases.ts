/**
 * The evaluation cases in a folder (plan T11). Two layouts, and a folder may use both:
 *
 * 1. **A manifest**, `cases.json` at the folder's top: `{"cases": [{id, file, mode, languages,
 *    locationCurrency?, meter?, notes?, regressions?, expected}]}`, with each `file` relative to
 *    the folder. The committed synthetic set uses it, and it is the easy way to add a folder of
 *    your own photos: drop them in and write one JSON file.
 * 2. **One folder per case** (the plan's format): `<dir>/<case>/{image.jpg|image.jpeg|image.png|
 *    image.webp|image.heic|doc.pdf, expected.json, meta.json}`, where `meta.json` is
 *    `{mode, languages, locationCurrency?, meter?, notes?}` and `expected.json` the values.
 *
 * Expected values are described in score.ts. `mode` is a capture mode, or `multi` for the V2
 * probe (multi.ts).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { CAPTURE_MODES } from '@kept/shared';
import { z } from 'zod';

export const EVAL_MODES = [...CAPTURE_MODES, 'multi'] as const;
export type EvalMode = (typeof EVAL_MODES)[number];

const Meta = z.object({
  mode: z.enum(EVAL_MODES),
  languages: z
    .array(z.string().regex(/^[a-z]{2,3}$/))
    .min(1)
    .default(['en']),
  locationCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  meter: z.object({ kind: z.string(), unit: z.string() }).nullable().optional(),
  notes: z.string().optional(),
  regressions: z.array(z.string()).optional(),
});

const ManifestCase = Meta.extend({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i),
  file: z.string().min(1),
  expected: z.record(z.string(), z.unknown()),
});

const Manifest = z.object({
  set: z.string().optional(),
  synthetic: z.boolean().optional(),
  cases: z.array(ManifestCase),
});

export type EvalCase = z.output<typeof Meta> & {
  id: string;
  /** Absolute path of the photo or PDF. */
  file: string;
  expected: Record<string, unknown>;
};

export type CaseSet = {
  dir: string;
  /** The manifest's `set` name, else the folder's name. */
  name: string;
  /** Whether every case is synthetic (the manifest says so). */
  synthetic: boolean;
  cases: EvalCase[];
};

const IMAGE_NAMES = ['image.jpg', 'image.jpeg', 'image.png', 'image.webp', 'image.heic', 'doc.pdf'];

export function loadCases(dir: string): CaseSet {
  const cases: EvalCase[] = [];
  let name = path.basename(dir);
  let synthetic = false;
  const manifestPath = path.join(dir, 'cases.json');
  if (existsSync(manifestPath)) {
    const m = Manifest.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
    if (m.set) name = m.set;
    synthetic = m.synthetic ?? false;
    for (const c of m.cases) {
      const { file, ...rest } = c;
      cases.push({ ...rest, file: path.resolve(dir, file) });
    }
  }
  for (const entry of readdirSync(dir).sort()) {
    const sub = path.join(dir, entry);
    if (!statSync(sub).isDirectory() || !existsSync(path.join(sub, 'meta.json'))) continue;
    const meta = Meta.parse(JSON.parse(readFileSync(path.join(sub, 'meta.json'), 'utf8')));
    const image = IMAGE_NAMES.map((n) => path.join(sub, n)).find((p) => existsSync(p));
    if (!image) throw new Error(`${entry}: no image.* or doc.pdf`);
    const expectedPath = path.join(sub, 'expected.json');
    const expected = existsSync(expectedPath)
      ? z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(expectedPath, 'utf8')))
      : {};
    cases.push({ ...meta, id: entry, file: image, expected });
  }
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`case id ${c.id} appears twice`);
    ids.add(c.id);
    if (!existsSync(c.file)) throw new Error(`${c.id}: ${path.basename(c.file)} is missing`);
  }
  return { dir, name, synthetic, cases };
}
