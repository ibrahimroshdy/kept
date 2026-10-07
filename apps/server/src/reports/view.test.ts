import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Gathered, GatheredThing, ReportOptions } from './gather.js';
import { renderPdf, writeData } from './render/render.js';
import { buildView } from './view.js';

// How the report prints what the app also shows: short IDs as the chip prints them (D134,
// "5KJ‑JZK" around U+2011) and place paths pointing the reader's way ("›" left to right, "‹"
// right to left, as the web's breadcrumbs do). Checked in the view, then in a rendered PDF read
// back with poppler's pdftotext where it is installed.

const OPTIONS: ReportOptions = {
  filters: { placeIds: [], typeIds: [], tagIds: [], includeEnded: false, includeTrashed: false },
  include: { photos: false, qr: false, money: false },
  locale: 'en',
  digits: 'western',
};
const AR: ReportOptions = { ...OPTIONS, locale: 'ar', digits: 'eastern' };
const CTX = {
  instance: 'kept.example',
  now: new Date('2026-09-26T09:00:00Z'),
  withPhoto: new Set<string>(),
  withQr: new Set<string>(),
};

function thing(i: number, name: string, path: string[], shortCode: string | null): GatheredThing {
  return {
    id: `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    locationId: 'loc',
    name,
    typeName: null,
    brand: null,
    model: null,
    serial: null,
    condition: null,
    lifecycle: 'in_use',
    quantity: '1',
    shortCode,
    trashed: false,
    thumbKey: null,
    path: path.map((p, depth) => ({
      id: `p-${path.slice(0, depth + 1).join('-')}`,
      name: p,
      kind: 'place',
      isUnplaced: false,
    })),
    money: null,
  };
}

function gathered(locale: 'en' | 'ar'): Gathered {
  const [kitchen, shelf, hall] =
    locale === 'ar' ? ['المطبخ', 'الخزانة العلوية', 'الممر'] : ['Kitchen', 'Upper shelf', 'Hall'];
  return {
    locations: [{ id: 'loc', name: locale === 'ar' ? 'البيت' : 'Home' }],
    accountOwnerName: null,
    requesterName: locale === 'ar' ? 'بروس' : 'Bruce',
    requesterTimezone: 'Africa/Cairo',
    moneyShown: false,
    moneyHidden: false,
    things: [
      thing(1, locale === 'ar' ? 'تلفزيون' : 'Television', [kitchen, shelf], '5KJJZK'),
      thing(2, locale === 'ar' ? 'مكنسة' : 'Vacuum', [hall], '7KQ4MZ'),
      thing(3, locale === 'ar' ? 'مصباح' : 'Lamp', [hall], null),
    ],
    filterNames: { places: [], types: [], tags: [] },
  };
}

describe('the view', () => {
  it('prints short IDs as the chip does, 3 + 3 around a non-breaking hyphen', () => {
    for (const [g, o] of [
      [gathered('en'), OPTIONS],
      [gathered('ar'), AR],
    ] as const) {
      const ids = buildView(g, o, CTX).places.flatMap((p) => p.things.map((t) => t.shortId));
      expect(ids.sort()).toEqual(['', '5KJ‑JZK', '7KQ‑4MZ']);
    }
  });

  it('joins place paths with "›" in English and "‹" in Arabic', () => {
    const en = buildView(gathered('en'), OPTIONS, CTX);
    expect(en.pathSeparator).toBe('›');
    expect(en.places.map((p) => p.pathText)).toContain('Kitchen › Upper shelf');
    const ar = buildView(gathered('ar'), AR, CTX);
    expect(ar.dir).toBe('rtl');
    expect(ar.pathSeparator).toBe('‹');
    expect(ar.places.map((p) => p.pathText)).toContain('المطبخ ‹ الخزانة العلوية');
    expect(JSON.stringify(ar)).not.toContain('›');
  });
});

let hasPoppler = true;
try {
  execFileSync('pdftotext', ['-v'], { stdio: 'ignore', timeout: 30_000 });
} catch {
  hasPoppler = false;
}
const pdfText = (pdf: Buffer) =>
  execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', '-', '-'], {
    input: pdf,
    timeout: 30_000,
  }).toString('utf8');

describe.skipIf(!hasPoppler)('the rendered PDF', () => {
  let scratch: string;
  beforeAll(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'kept-view-'));
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function render(locale: 'en' | 'ar'): Promise<string> {
    const dir = await mkdtemp(path.join(scratch, `${locale}-`));
    await writeData(dir, buildView(gathered(locale), locale === 'ar' ? AR : OPTIONS, CTX));
    const { file } = await renderPdf(dir);
    return pdfText(await readFile(file));
  }

  it('prints the short IDs with their hyphen, in English and Arabic', async () => {
    for (const locale of ['en', 'ar'] as const) {
      const text = await render(locale);
      expect(text, locale).toContain('5KJ‑JZK');
      expect(text, locale).toContain('7KQ‑4MZ');
      expect(text, locale).not.toContain('5KJJZK');
    }
  }, 60_000);

  it('points Arabic paths right to left, in the contents and the headings', async () => {
    const ar = await render('ar');
    // The contents line and the place heading: both carry the two-step path.
    expect(ar.match(/‹/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(ar).not.toContain('›');
    const en = await render('en');
    expect(en.match(/›/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(en).not.toContain('‹');
  }, 60_000);
});
