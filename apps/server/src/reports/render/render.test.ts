import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { renderSVG } from 'uqr';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Gathered, GatheredThing, ReportOptions } from '../gather.js';
import { addDecimal, buildView } from '../view.js';
import { FONT_FILES, fontDir, woffToSfnt } from './fonts.js';
import { RenderError, renderPdf, writeData } from './render.js';

// T32 (D201): the renderer on its own, outside any database: the child process, its limits, and
// the budget the V34 spike measured (500 things with photos, in Arabic, well under 512 MB).

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'kept-render-'));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const OPTIONS: ReportOptions = {
  filters: { placeIds: [], typeIds: [], tagIds: [], includeEnded: false, includeTrashed: false },
  include: { photos: true, qr: true, money: true },
  locale: 'ar',
  digits: 'eastern',
};

/** `n` things over n/20 places, every one with a photo, a short ID and a price. */
function synthetic(n: number): Gathered {
  const things: GatheredThing[] = Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    locationId: 'loc',
    name: i % 2 ? `تلفزيون Samsung TV ${i} بوصة` : `مكنسة كهربائية ${i}`,
    typeName: 'أجهزة',
    brand: 'Samsung',
    model: `QA${i}`,
    serial: `SN-${i}`,
    condition: 'good',
    lifecycle: 'in_use',
    quantity: '1',
    shortCode: `A${String(i).padStart(5, '0')}`.slice(0, 6),
    trashed: false,
    thumbKey: null,
    path: [
      {
        id: `p${Math.floor(i / 20)}`,
        name: `الغرفة ${Math.floor(i / 20)}`,
        kind: 'place',
        isUnplaced: false,
      },
    ],
    money: {
      purchasedOn: '2025-03-01',
      unitPrice: '1250.5',
      currency: i % 3 ? 'EGP' : 'USD',
      value: '1250.5',
    },
  }));
  return {
    locations: [{ id: 'loc', name: 'البيت' }],
    accountOwnerName: null,
    requesterName: 'ألفريد',
    requesterTimezone: 'Africa/Cairo',
    moneyShown: true,
    moneyHidden: false,
    things,
    filterNames: { places: [], types: [], tags: [] },
  };
}

async function jobDir(n: number): Promise<string> {
  const dir = await mkdtemp(path.join(scratch, 'job-'));
  await mkdir(path.join(dir, 'thumbs'));
  await mkdir(path.join(dir, 'qr'));
  const g = synthetic(n);
  const colours = ['#c9b79c', '#9fb4c7', '#d6c38b', '#b7c9a8', '#c7a9a0'];
  for (const [i, t] of g.things.entries()) {
    await sharp({
      create: {
        width: 200,
        height: 200,
        channels: 3,
        background: colours[i % colours.length] as string,
      },
    })
      .jpeg({ quality: 72 })
      .toFile(path.join(dir, 'thumbs', `${t.id}.jpg`));
    await writeFile(
      path.join(dir, 'qr', `${t.id}.svg`),
      renderSVG(`https://kept.example/l/${t.shortCode}`, { ecc: 'M', border: 1 }),
    );
  }
  const ids = new Set(g.things.map((t) => t.id));
  await writeData(
    dir,
    buildView(g, OPTIONS, {
      instance: 'kept.example',
      now: new Date(),
      withPhoto: ids,
      withQr: ids,
    }),
  );
  return dir;
}

describe('fonts', () => {
  it('converts the eight faces the template asks for, WOFF to TTF byte-exact', async () => {
    const { readFile } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    await (await import('./fonts.js')).ensureFonts();
    expect(FONT_FILES).toHaveLength(8);
    for (const f of FONT_FILES) expect(existsSync(path.join(fontDir(), f)), f).toBe(true);
    const ttf = await readFile(path.join(fontDir(), 'IBMPlexSansArabic-Regular.ttf'));
    expect(ttf.readUInt32BE(0)).toBe(0x00010000); // TrueType
    expect(() => woffToSfnt(Buffer.from('not a font'))).toThrow(/WOFF/);
  });
});

describe('renderPdf', () => {
  it('renders 500 Arabic things with photos and QR codes within the spike budget', async () => {
    const dir = await jobDir(500);
    const result = await renderPdf(dir);
    console.info(
      `render 500 things (ar, photos, qr): ${result.ms} ms, peak ${result.peakMb} MB, ${Math.round(result.bytes / 1024)} KB`,
    );
    expect(result.bytes).toBeGreaterThan(100_000);
    expect(result.peakMb).toBeLessThan(512);
  }, 120_000);

  it('kills a child past its memory limit (memory)', async () => {
    const dir = await jobDir(40);
    await expect(renderPdf(dir, { memoryMb: 8 })).rejects.toMatchObject({ code: 'memory' });
  });

  it('kills a child past its time limit (timeout)', async () => {
    const dir = await jobDir(40);
    const err = await renderPdf(dir, { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RenderError);
    expect((err as RenderError).code).toBe('timeout');
  });

  it("reports the template's error when the data doesn't fit it (render)", async () => {
    const dir = await mkdtemp(path.join(scratch, 'bad-'));
    await writeFile(path.join(dir, 'data.json'), '{"labels": {}}');
    const err = (await renderPdf(dir).catch((e: unknown) => e)) as RenderError;
    expect(err.code).toBe('render');
    expect(err.message).toMatch(/renderer failed/);
  });
});

describe('view', () => {
  it('adds decimal strings exactly', () => {
    expect(addDecimal('0', '0.1')).toBe('0.1');
    expect(addDecimal('0.1', '0.2')).toBe('0.3');
    expect(addDecimal('1250.5000000', '30000')).toBe('31250.5000000');
    expect(addDecimal('999999999999.9999', '0.0001')).toBe('1000000000000.0000');
  });

  it('leaves every money string out when money is hidden', () => {
    const g = { ...synthetic(3), moneyShown: false };
    g.things = g.things.map((t) => ({ ...t, money: null }));
    const v = buildView(
      g,
      { ...OPTIONS, locale: 'en', digits: 'western' },
      {
        instance: 'kept.example',
        now: new Date('2026-09-26T09:00:00Z'),
        withPhoto: new Set(),
        withQr: new Set(),
      },
    );
    expect(v.showMoney).toBe(false);
    expect(v.totals).toEqual([]);
    for (const p of v.places) {
      expect(p.subtotals).toEqual([]);
      for (const t of p.things) expect([t.value, t.purchased]).toEqual(['', '']);
    }
    expect(JSON.stringify(v)).not.toMatch(/EGP|US\$|1,250/);
  });

  it('writes Arabic in Eastern digits, and keeps short IDs and serials Western', () => {
    const v = buildView(synthetic(2), OPTIONS, {
      instance: 'kept.example',
      now: new Date('2026-09-26T09:00:00Z'),
      withPhoto: new Set(),
      withQr: new Set(),
    });
    expect(v.dir).toBe('rtl');
    expect(v.digits).toBe('arab');
    expect(v.counts.things).toBe('٢');
    const t = v.places[0]?.things[0];
    expect(t?.value).toMatch(/[٠-٩]/);
    expect(t?.shortId).toMatch(/^[0-9A-Z]{3}\u2011[0-9A-Z]{3}$/);
    expect(t?.serial).toMatch(/^SN-\d+$/);
  });
});
