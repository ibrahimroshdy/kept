# Spike S6.6 (V13): browser dictation

Date: 2026-09-30. Step-6 plan, Task 0 (it feeds T19; D25, D213). Result: **PASS for detection and
for the probe's event handling in desktop Chromium, which are the parts that need no microphone.
Real recognition is a maintainer check.**
- **Detection, in Chrome 154.0.8037.92 (installed) and Chrome for Testing 153.0.8010.12:**
  - both expose `SpeechRecognition` (unprefixed) **and** `webkitSpeechRecognition`, and a static
    `SpeechRecognition.available` function;
  - the page is a secure context on `http://127.0.0.1`;
  - `lang` keeps the bare interface language as set: `en`, `ar`, `fr`, `de`, `it` (and `ar-EG`).
- **The probe's handling** was run against a stubbed recogniser installed before the page ran:
  - interim results then a final result in English and Arabic;
  - `stop()` ending cleanly;
  - a permission denial as `error: 'not-allowed'` then `end`.
- **Not proven here: real speech turned into text.** It needs a microphone. It is on the device
  checklist ("maintainer check pending"), with the Chromium desktop row added next to the iPhone rows.

Code: `docs/spikes/code/step6/dictation/`:
- `probe.html` (the probe T19 puts on the diagnostics page, standalone);
- `dictation.spike.mjs`: detection in real browsers **without calling `start()`**, and the
  stubbed runs;
- `results-2026-09-30.json`.

## What went wrong first, and the rule it produced

The first version called `start()` on the real recogniser. Chrome and Chrome for Testing were
launched through Playwright with `--use-fake-device-for-media-stream`, and a WAV file as the fake
source. **Chrome's speech recogniser opened the Mac's real microphone anyway**: the maintainer
saw the microphone in use.

- **Why (inferred):** the fake-device flag feeds `getUserMedia`, and the speech recogniser captures
  audio by another path. It never produced text from the synthetic phrases. The fragments it
  returned came from whatever the real microphone heard, and Chrome's recogniser sends audio to
  its speech service.
- **Cleanup:** those browsers were closed (their processes killed), and the results file holding
  the fragments was deleted, not committed.

**The rule for T19 and T26:** never call `start()` on a real `SpeechRecognition` in an automated
test, fake-media flags or not. Test with a stub (as here), and leave real recognition to the
device checklist (D213: "Tests never use the Mac's real microphone").

## Stubbed runs (what T19's handling must do)

| Case | Events, in order | Interim | Final | Error |
|---|---|---|---|---|
| speech, `en` | start, audiostart, speechstart, result ×4, speechend, end | "where", "where is", "where is the drill" | "where is the drill" | none |
| speech, `ar` | start, audiostart, speechstart, result ×3, speechend, end | "أين", "أين المثقاب" | "أين المثقاب" | none |
| `stop()` after 15 ms | start, audiostart, end | none | "" | none |
| permission denied | start, error, end | none | "" | `not-allowed` |

The stub follows the Web Speech API's event names and the `results[i].isFinal` / `[0].transcript`
shape the probe reads. It is a model of the API, not a recording of Chrome's behaviour.

## Findings for T19

1. **Feature-detect with `window.SpeechRecognition ?? window.webkitSpeechRecognition`**, as planned.
   Chromium has both names.
2. **`lang`:** set the bare interface language; Chromium keeps it as given. Whether the recogniser
   *recognises* Arabic from a bare `ar` or needs a region (`ar-EG`, `ar-SA`) is unknown without a
   microphone. It goes on the device checklist with both values.
3. **`SpeechRecognition.available` exists in Chrome 153/154.** Its signature wasn't read (no
   typings for it in the repo), so it isn't used. If T19 wants "is Arabic available on this
   device" before showing the mic, read its current spec or Chrome's documentation first.
4. **Show "denied" once:** `not-allowed` arrives as an `error` event followed by `end`. The composer
   says so once and hides the mic for the session.
5. **Tests:** a stub like `installStub()` in `dictation.spike.mjs` covers interim, final, stop and
   denial in unit and e2e tests. Never the real object's `start()`.

## What changes in the plan

- **T19:** findings 1–5. The diagnostics probe reports `available`, the kept `lang` and the last
  error. It calls `start()` only when the person taps the mic.
- **T26:** the e2e test uses the stub; nothing in CI touches a microphone.
- **Device checklist:** V13 gains a Chromium desktop row (real speech in `en` and `ar`) beside the
  iPhone rows.
