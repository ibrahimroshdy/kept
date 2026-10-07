// SPIKE (step 3, T0, V18): one driver.js 1.8.0 hint on a button in an RTL page.
// API from driver.js dist/hints.d.mts: hints({hints, overlay, ...}) → {show, open, dismiss, ...};
// DriverHint {element, id, beacon: {side, align}, popover: {title, description, side, align,
// buttonText}}. driver.js positions with physical sides (left/right) and physical alignment
// (start = left edge), so `?mirror=1` flips the alignment for RTL the way use-hint.ts would.
import { type Alignment, type Hints, hints } from 'driver.js/hints';
import 'driver.js/dist/hints.css';

declare global {
  interface Window {
    __hints?: Hints;
    __hintEvents?: string[];
  }
}

// CSSOM, not a style attribute: the page runs under Kept's CSP (no 'unsafe-inline' styles).
(document.querySelector('main') as HTMLElement).style.padding = '48px';

// `?dir=ltr` renders the same page left-to-right, as the reference the RTL result must mirror.
if (new URLSearchParams(location.search).get('dir') === 'ltr') {
  document.documentElement.dir = 'ltr';
  document.documentElement.lang = 'en';
}
const rtl = document.documentElement.dir === 'rtl';
const mirror = new URLSearchParams(location.search).get('mirror') === '1';
const overlay = new URLSearchParams(location.search).get('overlay') === '1';
/** Logical → physical: in RTL, "start" is the right edge. */
const flip = (a: Alignment): Alignment =>
  mirror && rtl ? (a === 'start' ? 'end' : a === 'end' ? 'start' : a) : a;

const events: string[] = [];
window.__hintEvents = events;

const h = hints({
  overlay,
  hints: [
    {
      id: 'capture.mode_strip',
      element: '#mode-strip',
      beacon: { side: 'top', align: flip('end') },
      popover: {
        title: 'اختر الوضع',
        description: 'شيء أو إيصال أو ملصق أو قراءة. يمكنك التبديل في أي وقت.',
        side: 'bottom',
        align: flip('start'),
        buttonText: 'فهمت',
      },
      onOpen: () => events.push('open'),
      onDismiss: () => events.push('dismiss'),
    },
  ],
});
window.__hints = h;
h.show();
