/**
 * Browser dictation (D25, D213, V13; spike S6.6, docs/spikes/2026-09-30-step6-dictation.md): the
 * mic in the assistant's composer and in Capture's name field. It uses the browser's own
 * recogniser (`SpeechRecognition`, or `webkitSpeechRecognition` in Safari), so Kept sends nothing
 * to any server; the browser may use its own speech service.
 *
 * - The mic shows only where the API exists (finding 1).
 * - `lang` is the bare interface language (`en`, `ar`, …), which Chromium keeps as given (finding
 *   2); whether a bare `ar` is recognised is a device check (V13).
 * - Interim text shows in the field as it's heard, after what was already typed; the final text
 *   stays. Listening goes on until the person taps again or stops speaking, so a spoken list
 *   ("a drill, a ladder and two paint cans") arrives whole (D213).
 * - A denied microphone (`not-allowed`, then `end`) is said once and hides the mic for the rest of
 *   the session (finding 4).
 * - `start()` runs only when the person taps the mic. Tests replace the recogniser with a stub
 *   (`window.SpeechRecognition`); nothing automated ever starts a real one (agent rules, S6.6).
 *
 * The diagnostics probe (pwa/probes.ts) reads `dictationSupport()` and `lastDictationError()`.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

/** The parts of the Web Speech API this uses (no typings for it are relied on). */
export type RecognitionAlternative = { transcript: string };
export type RecognitionResult = {
  isFinal: boolean;
  readonly length: number;
  [i: number]: RecognitionAlternative;
};
export type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> };
export type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};
export type RecognitionCtor = new () => Recognition;

type SpeechWindow = Window & {
  SpeechRecognition?: RecognitionCtor;
  webkitSpeechRecognition?: RecognitionCtor;
};

/** The browser's recogniser, or null where there is none. */
export function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as SpeechWindow;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** For the diagnostics probe: which name the API has here. */
export function dictationSupport(): 'SpeechRecognition' | 'webkitSpeechRecognition' | null {
  if (typeof window === 'undefined') return null;
  const w = window as SpeechWindow;
  if (w.SpeechRecognition) return 'SpeechRecognition';
  if (w.webkitSpeechRecognition) return 'webkitSpeechRecognition';
  return null;
}

/** The interface language as the recogniser takes it: the bare language (finding 2). */
export const dictationLang = (locale: string): string => locale.split(/[-_]/)[0] || 'en';

// The session's denial and the last error, shared by every mic on the page.
let denied = false;
let lastError: string | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const lastDictationError = (): string | null => lastError;

/** Tests only: forget a denial. */
export function resetDictation(): void {
  denied = false;
  lastError = null;
  notify();
}

export type Dictation = {
  /** The mic can be shown: the API exists and the microphone wasn't refused this session. */
  available: boolean;
  listening: boolean;
  /** Set once, when the microphone is refused; the caller says so once. */
  deniedNow: boolean;
  /** Start listening, after `base` (the field's text now). */
  start: (base: string) => void;
  stop: () => void;
  toggle: (base: string) => void;
};

/**
 * Dictation into a field: `onText` gets the field's whole new value as words arrive (what was
 * typed, then what was heard so far).
 */
export function useDictation({
  locale,
  onText,
}: {
  locale: string;
  onText: (value: string) => void;
}): Dictation {
  const isDenied = useSyncExternalStore(
    subscribe,
    () => denied,
    () => denied,
  );
  const [listening, setListening] = useState(false);
  const [deniedNow, setDeniedNow] = useState(false);
  const rec = useRef<Recognition | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const stop = useCallback(() => {
    rec.current?.stop();
  }, []);

  const start = useCallback(
    (base: string) => {
      const Ctor = recognitionCtor();
      if (!Ctor || denied || rec.current) return;
      const r = new Ctor();
      r.lang = dictationLang(locale);
      r.continuous = true;
      r.interimResults = true;
      r.maxAlternatives = 1;
      const lead = base.trimEnd();
      r.onresult = (e) => {
        let heard = '';
        for (let i = 0; i < e.results.length; i++) heard += e.results[i]?.[0]?.transcript ?? '';
        heard = heard.trim();
        onTextRef.current(lead && heard ? `${lead} ${heard}` : lead || heard);
      };
      r.onerror = (e) => {
        lastError = e.error;
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          denied = true;
          setDeniedNow(true);
        }
        notify();
      };
      r.onend = () => {
        rec.current = null;
        setListening(false);
      };
      rec.current = r;
      lastError = null;
      setListening(true);
      try {
        r.start();
      } catch (err) {
        rec.current = null;
        setListening(false);
        lastError = err instanceof Error ? err.name : 'start-failed';
        notify();
      }
    },
    [locale],
  );

  // A field that goes away stops listening.
  useEffect(() => () => rec.current?.abort(), []);

  return {
    available: !!recognitionCtor() && !isDenied,
    listening,
    deniedNow,
    start,
    stop,
    toggle: (base) => (rec.current ? stop() : start(base)),
  };
}
