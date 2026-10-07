import { z } from 'zod';
import { rateLimited, requireScope } from '../auth/http.js';
import { limiterKey, reserveInWindow } from '../auth/sign-in-limiter.js';
import type { KeptApp } from '../http/app.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead } from '../http/write.js';
import {
  BarcodeLookupSchema,
  LOOKUPS_PER_MINUTE,
  lookupBarcode,
  readBarcodeSettings,
} from './barcode.js';
import { type ResolveDeps, ResolveScanBody, resolveScan, ScanOutcomeSchema } from './resolve.js';

// Scan (plan T17; D40, D104, D120, D126, D137, D146; engineering spec §2.4, §3.2; Q22).
// The web contract is apps/web/src/api/capture/{paths,types}.ts "scan, barcodes and box checks".
//
// POST /api/v1/scan/resolve {text, format?} → ScanOutcome (read-only: on the route catalogue's
//                                             allowlist; nothing is marked seen, D40)
// GET  /api/v1/barcodes/:code               → {enabled: false} | {enabled: true, found, product?,
//                                             attribution}; 429 past 15 lookups a minute
//
// Mark seen is step 2's `POST /api/v1/things/:id/seen`, which the phone calls after opening.
// Neither route is a module route: a scan answers in every location, and barcode lookup is an
// instance setting (D126).

export async function scanRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  const settings = () => readBarcodeSettings(pools.system, deps.env);
  const resolveDeps: ResolveDeps = {
    lookupEnabled: async () => (await settings()).lookup.value,
  };

  app.post(
    '/api/v1/scan/resolve',
    { schema: { body: ResolveScanBody, response: { 200: ScanOutcomeSchema } } },
    (req) => scopedRead(pools, req, (_tx, client) => resolveScan(client, req.body, resolveDeps)),
  );

  app.get(
    '/api/v1/barcodes/:code',
    {
      schema: {
        params: z.object({ code: z.string().min(1).max(64) }),
        response: { 200: BarcodeLookupSchema },
      },
    },
    async (req, reply) => {
      requireScope(req);
      return lookupBarcode(
        req.params.code.trim(),
        {
          settings: await settings(),
          reserve: () =>
            reserveInWindow(
              pools.auth,
              limiterKey('barcode-lookup', 'instance'),
              LOOKUPS_PER_MINUTE,
              60,
            ),
        },
        (retryAfter) => rateLimited(reply, retryAfter),
      );
    },
  );
}
