/**
 * A stub for the Web Speech API's recogniser (spike S6.6's `installStub()`, as a class). Tests of
 * dictation install it as `window.SpeechRecognition`; nothing automated ever starts a real
 * recogniser, which opens the real microphone even with fake-media flags (agent rules, S6.6).
 * It follows the API's event names and the `results[i].isFinal` / `[0].transcript` shape.
 */
import { vi } from 'vitest';

type Result = { isFinal: boolean; length: number; 0: { transcript: string } };

export class StubRecognition {
  static instances: StubRecognition[] = [];
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  started = false;
  onresult: ((e: { resultIndex: number; results: Result[] }) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;

  constructor() {
    StubRecognition.instances.push(this);
  }
  start() {
    this.started = true;
  }
  stop() {
    this.started = false;
    this.onend?.();
  }
  abort() {
    this.stop();
  }
  /** What the recogniser heard so far: the phrases, the last one final or not. */
  hear(phrases: string[], final: boolean) {
    this.onresult?.({
      resultIndex: 0,
      results: phrases.map((p, i) => ({
        isFinal: final || i < phrases.length - 1,
        length: 1,
        0: { transcript: p },
      })),
    });
  }
  /** The person refused the microphone: `not-allowed`, then `end`. */
  deny() {
    this.onerror?.({ error: 'not-allowed' });
    this.started = false;
    this.onend?.();
  }
  static get last(): StubRecognition {
    const r = StubRecognition.instances.at(-1);
    if (!r) throw new Error('no recogniser was made');
    return r;
  }
}

/** Install the stub; `vi.unstubAllGlobals()` (test/app.tsx) takes it away. */
export function installSpeechStub(
  name: 'SpeechRecognition' | 'webkitSpeechRecognition' = 'SpeechRecognition',
) {
  StubRecognition.instances = [];
  vi.stubGlobal(name, StubRecognition);
  return StubRecognition;
}
