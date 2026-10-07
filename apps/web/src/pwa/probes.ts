/**
 * The on-device diagnostics probes (D188, L87, L96; plan T23; the device checklist
 * docs/spikes/2026-09-26-step3-devices.md). Each probe answers ok / not ok / for information,
 * with technical facts (`key=value`) that go into the copied report as they are. Nothing is
 * sent anywhere; the report is text the person copies.
 *
 * The camera probe asks for permission, which is why the panel only runs on "Run the checks".
 * The dictation probe (V13, spike S6.6) only looks: whether the browser has a recogniser, the
 * language it would be given, and the last error a mic tap met. It never starts listening; that
 * happens only when the person taps a mic.
 */
import { dictationLang, dictationSupport, lastDictationError } from '@/assistant/dictation';
import heicUrl from './probe.heic?url';

export type ProbeStatus = 'ok' | 'fail' | 'info';
export type ProbeKey =
  | 'secure'
  | 'standalone'
  | 'serviceWorker'
  | 'storage'
  | 'indexedDb'
  | 'barcode'
  | 'camera'
  | 'heic'
  | 'geolocation'
  | 'dictation'
  | 'print';
export type ProbeResult = { key: ProbeKey; status: ProbeStatus; facts: string[] };

/** The order the panel shows them in. */
export const PROBE_KEYS: readonly ProbeKey[] = [
  'secure',
  'standalone',
  'serviceWorker',
  'storage',
  'indexedDb',
  'barcode',
  'camera',
  'heic',
  'geolocation',
  'dictation',
  'print',
];

const mb = (bytes: number | undefined) =>
  bytes === undefined ? '?' : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const errorName = (err: unknown) =>
  err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 160) : String(err).slice(0, 160);

type Probe = () => Promise<Omit<ProbeResult, 'key'>>;

const probes: Record<ProbeKey, Probe> = {
  async secure() {
    return {
      status: window.isSecureContext ? 'ok' : 'fail',
      facts: [`protocol=${location.protocol.replace(':', '')}`],
    };
  },

  async standalone() {
    const media = matchMediaSafe('(display-mode: standalone)');
    const ios = (navigator as Navigator & { standalone?: boolean }).standalone === true;
    return {
      status: media || ios ? 'ok' : 'info',
      facts: [
        `display-mode=${media ? 'standalone' : 'browser'}`,
        ...(ios ? ['ios-standalone'] : []),
      ],
    };
  },

  async serviceWorker() {
    if (!('serviceWorker' in navigator)) return { status: 'fail', facts: ['unsupported'] };
    const reg = await navigator.serviceWorker.getRegistration();
    const facts = [
      `active=${reg?.active?.state ?? 'none'}`,
      `waiting=${reg?.waiting ? 'yes' : 'no'}`,
      `controlled=${navigator.serviceWorker.controller ? 'yes' : 'no'}`,
    ];
    return { status: navigator.serviceWorker.controller ? 'ok' : 'fail', facts };
  },

  async storage() {
    const s = navigator.storage;
    if (!s?.persisted) return { status: 'fail', facts: ['unsupported'] };
    const persisted = await s.persisted();
    const est = await s.estimate?.();
    return {
      // Not persisted is the normal state before the first capture asks (V11).
      status: persisted ? 'ok' : 'info',
      facts: [`persisted=${persisted}`, `usage=${mb(est?.usage)}`, `quota=${mb(est?.quota)}`],
    };
  },

  async indexedDb() {
    if (!('indexedDB' in window)) return { status: 'fail', facts: ['unsupported'] };
    const name = 'kept-diagnostics';
    const value = `probe-${Date.now()}`;
    const read = await new Promise<unknown>((resolve, reject) => {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('probe');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('probe', 'readwrite');
        tx.objectStore('probe').put(value, 'k');
        tx.oncomplete = () => {
          const get = db.transaction('probe').objectStore('probe').get('k');
          get.onsuccess = () => {
            db.close();
            resolve(get.result);
          };
          get.onerror = () => reject(get.error);
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    indexedDB.deleteDatabase(name);
    return { status: read === value ? 'ok' : 'fail', facts: [`roundtrip=${read === value}`] };
  },

  async barcode() {
    const Detector = (
      window as Window & {
        BarcodeDetector?: { getSupportedFormats(): Promise<string[]> };
      }
    ).BarcodeDetector;
    // No native detector is expected on iPhone: the scanner uses its wasm instead (D101), so
    // that is what gets tried: a QR decoded twice, with timings (T26; V12).
    const formats = Detector ? await Detector.getSupportedFormats() : [];
    if (formats.includes('qr_code'))
      return { status: 'ok', facts: ['native=yes', `formats=${formats.join(',')}`] };
    const { probeWasmScanner } = await import('@/camera/scanner');
    const wasm = await probeWasmScanner();
    return {
      status: wasm.ok ? 'ok' : 'fail',
      facts: [Detector ? `native=${formats.join(',') || 'none'}` : 'native=no', ...wasm.facts],
    };
  },

  async camera() {
    if (!navigator.mediaDevices?.getUserMedia) return { status: 'fail', facts: ['unsupported'] };
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'environment', width: { ideal: 4096 }, height: { ideal: 2160 } },
    });
    try {
      const track = stream.getVideoTracks()[0];
      const s = track?.getSettings() ?? {};
      return {
        status: track ? 'ok' : 'fail',
        facts: [`best=${s.width ?? '?'}x${s.height ?? '?'}`, `facing=${s.facingMode ?? '?'}`],
      };
    } finally {
      for (const t of stream.getTracks()) t.stop();
    }
  },

  async heic() {
    if (typeof createImageBitmap !== 'function') return { status: 'fail', facts: ['unsupported'] };
    const blob = await (await fetch(heicUrl)).blob();
    const bitmap = await createImageBitmap(new Blob([blob], { type: 'image/heic' }));
    const facts = [`decoded=${bitmap.width}x${bitmap.height}`];
    bitmap.close();
    return { status: 'ok', facts };
  },

  async geolocation() {
    if (!('geolocation' in navigator)) return { status: 'fail', facts: ['unsupported'] };
    try {
      const p = await navigator.permissions.query({ name: 'geolocation' });
      return { status: p.state === 'denied' ? 'fail' : 'info', facts: [`permission=${p.state}`] };
    } catch {
      return { status: 'info', facts: ['permission=unknown'] };
    }
  },

  async dictation() {
    const api = dictationSupport();
    const lang = dictationLang(document.documentElement.lang || navigator.language || 'en');
    const error = lastDictationError();
    return {
      // Without it, typing (and the keyboard's own dictation) still works: for information.
      status: api ? 'ok' : 'info',
      facts: [`api=${api ?? 'none'}`, `lang=${lang}`, ...(error ? [`last-error=${error}`] : [])],
    };
  },

  async print() {
    // Whether @page sizes are honoured can only be seen on paper; this says the rule exists.
    return { status: 'info', facts: [`page-rule=${'CSSPageRule' in window ? 'yes' : 'no'}`] };
  },
};

function matchMediaSafe(query: string): boolean {
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** Runs one probe; a probe that throws is a failure with the error's name (never its stack). */
export async function runProbe(key: ProbeKey): Promise<ProbeResult> {
  try {
    return { key, ...(await probes[key]()) };
  } catch (err) {
    return { key, status: 'fail', facts: [`error=${errorName(err)}`] };
  }
}

/** The copied report: plain text, one line per probe. */
export function reportText(
  header: string[],
  rows: { label: string; result: ProbeResult }[],
): string {
  const mark: Record<ProbeStatus, string> = { ok: '✓', fail: '✗', info: '·' };
  return [
    ...header,
    '',
    ...rows.map(
      ({ label, result }) =>
        `${mark[result.status]} ${label}${result.facts.length ? `: ${result.facts.join(' ')}` : ''}`,
    ),
  ].join('\n');
}
