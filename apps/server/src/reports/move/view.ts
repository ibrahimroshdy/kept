import type { BoxState } from '@kept/shared';
import type { ReportLocale } from '../labels.js';
import type { GatheredMove, MoveReportOptions } from './gather.js';

// A move's contents sheets as template/move.typ reads them (`/data.json`; 1.x, D251). As for the
// other reports, every string is final here, in the sheet's language and digits (D143), so the
// template only lays them out. A box's QR code is its label's (`/l/<short ID>`): scanning the
// sheet taped to the box opens it in Kept, where it is unpacked.

type Words = {
  title: string;
  box: (n: string) => string;
  goesTo: string;
  noRoom: string;
  contents: (n: string) => string;
  empty: string;
  quantity: string;
  id: string;
  holds: (n: string) => string;
  more: (n: string) => string;
  states: Record<BoxState, string>;
  route: (from: string, to: string) => string;
  scan: string;
  generated: (who: string, when: string) => string;
  none: string;
};

const EN: Words = {
  title: 'Contents sheets',
  box: (n) => `Box ${n}`,
  goesTo: 'Goes to',
  noRoom: 'No room chosen yet',
  contents: (n) => `Contents (${n})`,
  empty: 'Nothing in this box yet.',
  quantity: 'Qty',
  id: 'ID',
  holds: (n) => `holds ${n}`,
  more: (n) => `${n} more in Kept`,
  states: { packed: 'Packed', in_transit: 'In transit', unpacked: 'Unpacked' },
  route: (from, to) => `${from} → ${to}`,
  scan: 'Scan the code to see this box in Kept and unpack it.',
  generated: (who, when) => `Printed by ${who} · ${when}`,
  none: 'No boxes to print.',
};

const AR: Words = {
  title: 'قوائم محتويات الصناديق',
  box: (n) => `صندوق ${n}`,
  goesTo: 'يذهب إلى',
  noRoom: 'لم تُحدَّد الغرفة بعد',
  contents: (n) => `المحتويات (${n})`,
  empty: 'لا شيء في هذا الصندوق بعد.',
  quantity: 'الكمية',
  id: 'المعرّف',
  holds: (n) => `فيه ${n}`,
  more: (n) => `${n} أخرى في Kept`,
  states: { packed: 'مُعبّأ', in_transit: 'في الطريق', unpacked: 'تم تفريغه' },
  route: (from, to) => `${from} ← ${to}`,
  scan: 'امسح الرمز لترى هذا الصندوق في Kept وتفرغه.',
  generated: (who, when) => `طبعه ${who}، ${when}`,
  none: 'لا صناديق للطباعة.',
};

export type MoveView = {
  lang: ReportLocale;
  dir: 'ltr' | 'rtl';
  title: string;
  move: string;
  route: string;
  generatedLine: string;
  footer: string;
  none: string;
  labels: { goesTo: string; quantity: string; id: string; scan: string };
  boxes: {
    heading: string;
    name: string;
    state: string;
    room: string;
    hasRoom: boolean;
    contentsTitle: string;
    empty: string;
    qr: string;
    code: string;
    lines: { name: string; quantity: string; id: string; note: string }[];
    more: string;
  }[];
};

export type MoveViewContext = {
  /** KEPT_PUBLIC_URL's host, for the footer. */
  instance: string;
  now: Date;
  /** Which boxes' QR codes were written to the job directory (by container id). */
  withQr: ReadonlySet<string>;
};

function safeTimeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** Builds the template's data from what gatherMove() read. */
export function buildMoveView(
  g: GatheredMove,
  options: MoveReportOptions,
  ctx: MoveViewContext,
): MoveView {
  const ar = options.locale === 'ar';
  const w = ar ? AR : EN;
  const sep = ar ? '، ' : ' · ';
  const intl = ar ? 'ar-EG' : 'en-GB';
  const numberingSystem: 'latn' | 'arab' = ar && options.digits === 'eastern' ? 'arab' : 'latn';
  const nf = new Intl.NumberFormat(intl, { numberingSystem, maximumFractionDigits: 3 });
  const when = new Intl.DateTimeFormat(intl, {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: safeTimeZone(g.requesterTimezone),
    numberingSystem,
  }).format(ctx.now);
  return {
    lang: options.locale,
    dir: ar ? 'rtl' : 'ltr',
    title: w.title,
    move: g.name,
    route: g.toLocationName ? w.route(g.locationName, g.toLocationName) : g.locationName,
    generatedLine: w.generated(g.requesterName, when),
    footer: ['Kept', ctx.instance, when].filter((x) => x !== '').join(sep),
    none: w.none,
    labels: { goesTo: w.goesTo, quantity: w.quantity, id: w.id, scan: w.scan },
    boxes: g.boxes.map((b) => ({
      heading: w.box(nf.format(b.number)),
      name: b.name,
      state: w.states[b.state],
      room: b.room ?? w.noRoom,
      hasRoom: b.room !== null,
      contentsTitle: w.contents(nf.format(b.lines.length + b.moreLines)),
      empty: w.empty,
      qr: ctx.withQr.has(b.containerId) ? `/qr/${b.containerId}.svg` : '',
      code: b.shortCode ?? '',
      lines: b.lines.map((l) => ({
        name: l.name,
        quantity: nf.format(Number(l.quantity)),
        id: l.shortCode ?? '',
        note: l.inside !== null ? w.holds(nf.format(l.inside)) : '',
      })),
      more: b.moreLines > 0 ? w.more(nf.format(b.moreLines)) : '',
    })),
  };
}
