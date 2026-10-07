/**
 * Step 3's e2e fixtures outside the step-1/2 instance list (plan T32): the fake camera's flags,
 * and the instance the capture flows run on (e2e/step3.spec.ts).
 */
import { fileURLToPath } from 'node:url';
import type { Instance } from './instances';

/** A y4m file in e2e/fixtures (made by e2e/fixtures/make-y4m.mjs). */
export const fixtureVideo = (name: 'camera-qr' | 'camera-thing') =>
  fileURLToPath(new URL(`./fixtures/${name}.y4m`, import.meta.url));

/** A still in e2e/fixtures, picked from the Gallery (receipt-usd.jpg: make-receipt.mjs). */
export const fixtureFile = (name: 'receipt-usd.jpg') =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/**
 * Chromium's fake camera, granted without a prompt, playing `video` in a loop. The projects use
 * camera-thing (Capture's shutter); the scan test launches a browser of its own on camera-qr.
 */
export const fakeCameraArgs = (video = fixtureVideo('camera-thing')) => [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-video-capture=${video}`,
];

/**
 * The capture flows' instance: seeded with `households`, every AI call answered by the mock
 * provider (KEPT_AI_MOCK=1; e2e/serve.mjs `--ai-mock` then runs it with NODE_ENV=development,
 * since production refuses the mock). Both projects share it, each test on its own things.
 * Its key for KEPT_E2E_INSTANCES is `capture`.
 */
export const CAPTURE_INSTANCE: Instance & { aiMock: true } = {
  name: 'capture',
  port: 8187,
  seed: true,
  aiMock: true,
};
