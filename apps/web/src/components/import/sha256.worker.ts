/**
 * Hashes an import archive off the main thread (plan T19 step 2): receives the File, answers
 * with progress and then the SHA-256 (sha256.ts). A module worker from Kept's own origin, like
 * csv.worker.ts (the CSP's `worker-src 'self'`); built into assets/household/ (vite.config.ts).
 */
import { type HashMessage, hashBlob } from './sha256';

const post = (m: HashMessage) => self.postMessage(m);

self.onmessage = (event: MessageEvent<Blob>) => {
  let last = 0;
  hashBlob(event.data, (fraction) => {
    // Every 2% is plenty for a progress bar, and keeps the messages few on a 5 GB file.
    if (fraction - last >= 0.02 || fraction === 1) {
      last = fraction;
      post({ kind: 'progress', fraction });
    }
  })
    .then((sha256) => post({ kind: 'done', sha256 }))
    .catch(() => post({ kind: 'error' }));
};
