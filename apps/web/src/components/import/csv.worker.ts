/**
 * Parses a large CSV off the main thread (plan T30: "worker: true for large files"). A module
 * worker served from Kept's own origin: papaparse's own `worker: true` builds its worker from a
 * blob: URL, which the CSP (`worker-src 'self'`) refuses. Receives the file's text, answers with
 * the rows or the parser's first error.
 */
import Papa from 'papaparse';
import { PARSE_CONFIG, type WorkerAnswer } from './parse-config';

self.onmessage = (event: MessageEvent<string>) => {
  const result = Papa.parse<string[]>(event.data, PARSE_CONFIG);
  const answer: WorkerAnswer = {
    rows: result.data,
    error: result.errors.find((e) => e.type === 'Quotes')?.row ?? null,
  };
  self.postMessage(answer);
};
