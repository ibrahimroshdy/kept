// Step-4 spike T0: renders insurance.typ for 60 and 500 things, in English and Arabic, through the
// D201 renderer's own child process (apps/server/src/reports/render/child.mjs), and records wall
// time, PDF size and the child's peak resident memory (sampled every 20 ms with `ps`, as
// render.ts samples it off Linux) against the 512 MB child limit. Synthetic data; the real view
// is T18's. Run from apps/server: pnpm exec tsx ../../docs/spikes/code/step4/insurance/run.ts
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { convert, type FxRate, formatMoney } from '../../../../../packages/shared/src/money.ts';
import { CHILD_ENTRY } from '../../../../../apps/server/src/reports/render/render.ts';
import { ensureFonts } from '../../../../../apps/server/src/reports/render/fonts.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRequire = createRequire(path.resolve(here, '../../../../../apps/server/package.json'));
const sharp = serverRequire('sharp') as typeof import('sharp');
const run = promisify(execFile);

type Lang = 'en' | 'ar';
const L = {
  en: { title: 'Insurance report', totals: 'Totals', converted: 'In EGP:', subtotal: 'Subtotal', thing: 'Thing', purchase: 'Bought', value: 'Value now', receipts: 'Receipts', serial: 'Serial', page: 'Page', of: 'of' },
  ar: { title: 'تقرير التأمين', totals: 'الإجماليات', converted: 'بالجنيه المصري:', subtotal: 'المجموع الفرعي', thing: 'الشيء', purchase: 'الشراء', value: 'القيمة الآن', receipts: 'الإيصالات', serial: 'الرقم التسلسلي', page: 'صفحة', of: 'من' },
};
const rates: FxRate[] = [{ fromCcy: 'USD', toCcy: 'EGP', rate: '48.5', validFrom: '2026-09-01' }];

function money(amount: string, ccy: string, lang: Lang) {
  return formatMoney(amount, ccy, { locale: lang, digits: lang === 'ar' ? 'eastern' : 'western' });
}
const num = (n: number, lang: Lang) => new Intl.NumberFormat(lang, { numberingSystem: lang === 'ar' ? 'arab' : 'latn' }).format(n);
const day = (iso: string, lang: Lang) => new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeZone: 'UTC', numberingSystem: lang === 'ar' ? 'arab' : 'latn' }).format(new Date(`${iso}T00:00:00Z`));

async function job(n: number, lang: Lang, incident: boolean) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kept-ins-'));
  await mkdir(path.join(dir, 'thumbs'));
  await mkdir(path.join(dir, 'qr'));
  const colours = ['#c9b79c', '#9fb4c7', '#d6c38b', '#b7c9a8', '#c7a9a0'];
  const places: { path: string[]; count: string; things: object[]; totals: string[] }[] = [];
  const all: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const id = `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`;
    await sharp({ create: { width: 200, height: 200, channels: 3, background: colours[i % 5] as string } })
      .jpeg({ quality: 72 })
      .toFile(path.join(dir, 'thumbs', `${id}.jpg`));
    const pi = Math.floor(i / 20);
    if (!places[pi]) places[pi] = { path: lang === 'ar' ? ['بيت العائلة', `الغرفة ${num(pi + 1, lang)}`] : ['Home', `Room ${pi + 1}`], count: '', things: [], totals: [] };
    const ccy = i % 3 ? 'EGP' : 'USD';
    const price = ccy === 'EGP' ? String(12500 + i * 10) : String(250 + i);
    const value = ccy === 'EGP' ? String(9000 + i * 7) : String(180 + i);
    all[ccy] = (all[ccy] ?? 0) + Number(value);
    (places[pi] as { things: object[] }).things.push({
      photo: `/thumbs/${id}.jpg`,
      name: lang === 'ar' ? (i % 2 ? `تلفزيون ${num(i, lang)} بوصة` : `مكنسة كهربائية ${num(i, lang)}`) : i % 2 ? `TV ${i} inch` : `Vacuum cleaner ${i}`,
      brand: 'Samsung',
      model: `QA${i}`,
      serial: `SN-${i}`,
      purchasedOn: day('2025-03-01', lang),
      price: money(price, ccy, lang),
      value: money(value, ccy, lang),
      valuedOn: i % 4 ? day('2026-06-01', lang) : '',
      receipts: num(i % 3, lang),
    });
  }
  for (const p of places) {
    p.count = num(p.things.length, lang);
    p.totals = [money('123456.5', 'EGP', lang), money('2400', 'USD', lang)];
  }
  const usdInEgp = convert(String(all.USD ?? 0), 'USD', 'EGP', '2026-09-30', rates);
  const convertedTotal = 'amount' in usdInEgp ? String(Number(usdInEgp.amount) + (all.EGP ?? 0)) : '';
  const data = {
    lang, dir: lang === 'ar' ? 'rtl' : 'ltr', digits: lang === 'ar' ? 'arab' : 'latn', labels: L[lang],
    scopeName: lang === 'ar' ? 'بيت العائلة' : 'Home', generatedBy: lang === 'ar' ? 'ألفريد' : 'Ibrahim',
    asOfLine: lang === 'ar' ? `حتى ${day('2026-09-30', lang)}` : `As of ${day('2026-09-30', lang)}`,
    generatedLine: lang === 'ar' ? 'أنشأه ألفريد' : 'Made by Ibrahim',
    footer: 'kept.example', pathSeparator: lang === 'ar' ? '‹' : '›',
    incident: incident ? { title: lang === 'ar' ? 'سرقة' : 'Burglary', lines: [day('2026-09-20', lang), 'Police ref 2026/1182', 'Insurer ref CLM-55-0192'] } : null,
    totals: Object.entries(all).map(([ccy, v]) => money(String(v), ccy, lang)),
    converted: convertedTotal ? money(convertedTotal, 'EGP', lang) : '',
    moneyNote: '',
    places,
  };
  await writeFile(path.join(dir, 'data.json'), JSON.stringify(data));
  return dir;
}

async function rssMb(pid: number): Promise<number | null> {
  try {
    const { stdout } = await run('ps', ['-o', 'rss=', '-p', String(pid)]);
    const kb = Number(stdout.trim());
    return Number.isFinite(kb) && kb > 0 ? kb / 1024 : null;
  } catch {
    return null;
  }
}

async function render(dir: string) {
  const fonts = await ensureFonts();
  const started = performance.now();
  const child = spawn(process.execPath, ['--max-old-space-size=64', CHILD_ENTRY, dir, path.join(here, 'insurance.typ'), fonts], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  child.stdout.resume();
  let peak = 0;
  const poll = setInterval(() => { if (child.pid) void rssMb(child.pid).then((mb) => { if (mb) peak = Math.max(peak, mb); }); }, 20);
  const code = await new Promise<number | null>((r) => child.once('exit', r));
  clearInterval(poll);
  if (code !== 0) throw new Error(`render failed ${code}: ${err.slice(0, 500)}`);
  const { size } = await stat(path.join(dir, 'out.pdf'));
  return { ms: Math.round(performance.now() - started), peakMb: Math.round(peak), kb: Math.round(size / 1024) };
}

const keep = process.argv[2]; // a directory to copy the 60-thing PDFs to, for a look
for (const n of [60, 500]) {
  for (const lang of ['en', 'ar'] as const) {
    const dir = await job(n, lang, n === 60);
    try {
      const r = await render(dir);
      console.log(`${n} things, ${lang}${n === 60 ? ', with an incident' : ''}: ${r.ms} ms, peak ${r.peakMb} MB, ${r.kb} KB`);
      if (keep && n === 60) await run('cp', [path.join(dir, 'out.pdf'), path.join(keep, `insurance-60-${lang}.pdf`)]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
