import type { FastifyBaseLogger } from 'fastify';
import { backupRoutes } from '../admin/backup-routes.js';
import { recoveryKitRoutes } from '../admin/recovery-kit-routes.js';
import { agendaRoutes } from '../agenda/routes.js';
import { type AiDeps, aiRoutes } from '../ai/routes.js';
import { assistantRoutes } from '../assistant/routes.js';
import type { Auth } from '../auth/auth.js';
import { boxCheckRoutes } from '../boxcheck/routes.js';
import { calendarRoutes } from '../calendar/routes.js';
import { captureRoutes } from '../capture/routes.js';
import { codeRoutes } from '../codes/routes.js';
import { consumableRoutes } from '../consumables/routes.js';
import type { SecretKeys } from '../crypto/keyring.js';
import { currencyRoutes } from '../currencies/routes.js';
import type { Pools } from '../db/pools.js';
import { enrichRoutes } from '../enrich/routes.js';
import { exportRoutes } from '../exports/routes.js';
import { extractionRoutes } from '../extraction/routes.js';
import { fileRoutes } from '../files/routes.js';
import { fuelRoutes } from '../fuel/routes.js';
import { historyRoutes } from '../history/routes.js';
import { homeRoutes } from '../home/routes.js';
import { archiveImportRoutes } from '../imports/archive.js';
import { importRoutes } from '../imports/routes.js';
import { inboxRoutes } from '../inbox/routes.js';
import { incidentRoutes } from '../incidents/routes.js';
import type { JobQueue } from '../jobs/queue.js';
import { labelRoutes } from '../labels/routes.js';
import { lendingRoutes } from '../lending/routes.js';
import { mcpRoutes } from '../mcp/routes.js';
import { meterRoutes } from '../meters/routes.js';
import { moneyRoutes } from '../money/routes.js';
import type { NotifyDeps } from '../notify/channels.js';
import { notifyRoutes } from '../notify/routes.js';
import { oauthRoutes } from '../oauth/routes.js';
import { paperworkRoutes } from '../paperwork/routes.js';
import { placeRoutes } from '../places/routes.js';
import { purchaseRoutes } from '../purchases/routes.js';
import { registryRoutes } from '../registries/routes.js';
import { reportRoutes } from '../reports/routes.js';
import { scanRoutes } from '../scan/routes.js';
import { scheduleRoutes } from '../schedules/routes.js';
import { searchRoutes } from '../search/routes.js';
import { secretRoutes } from '../secrets/routes.js';
import { serviceDraftRoutes } from '../services/routes.js';
import type { FileStorage } from '../storage/blob-store.js';
import { syncExtrasRoutes } from '../sync/extras.js';
import { syncRoutes } from '../sync/routes.js';
import { templateRoutes } from '../templates/routes.js';
import { thingRoutes } from '../things/routes.js';
import { tokenRoutes } from '../tokens/routes.js';
import { trashRoutes } from '../trash/routes.js';
import { typeRoutes } from '../types/routes.js';
import { undoRoutes } from '../undo/routes.js';
import { updateRoutes } from '../updates/routes.js';
import { vehicleRoutes } from '../vehicles/routes.js';
import { warrantyRoutes } from '../warranties/routes.js';
import { webhookRoutes } from '../webhooks/routes.js';
import type { AppEnv, KeptApp } from './app.js';

// The registry of step 2's route modules (T2). buildApp() calls registerInventoryRoutes() once;
// each Phase-B task owns one `src/<area>/routes.ts` and fills in its function there, so no task
// edits this file to add a route. A task that needs something new from the app (a service, a
// limit) adds an optional field to InventoryDeps and passes it from buildApp().
//
// What every route here must do (plan "API conventions"; the route-catalogue test enforces the
// audit rule):
// - run in scopedRead()/scopedWrite() (http/write.ts) on kept_app;
// - a non-GET route calls audited() (audit/audited.ts), and its test carries a
//   `// catalogue: <METHOD> <url>` marker above a case asserting the audit row
//   (test/route-catalogue.test.ts); a read-only POST (a `…/preview`) goes on its ALLOWLIST;
// - money and secrets leave only through serialize/gates.ts;
// - `config.module` for module routes, with a moduleLocation resolver (http/modules.ts,
//   locationOfThing() and co.) when the location isn't in the params, body or query.

export type InventoryDeps = {
  pools: Pools;
  env: AppEnv;
  log: FastifyBaseLogger;
  /** Where routes enqueue jobs in their own transaction; null when the app has none (tests). */
  jobs: JobQueue | null;
  /** File storage (storage/); null when the app serves no files (tests that don't need it). */
  files: FileStorage | null;
  /** The keyring for secret values (crypto/keyring.ts, T19); absent: those routes answer 503. */
  secretKeys?: SecretKeys | null;
  /** Step 3's AI layer (ai/routes.ts AiDeps); absent: AI routes answer as if no provider were
   * set. The blob store the capture routes need is `files.blobs`. */
  ai?: AiDeps | null;
  /** The HMAC key that signs sync cursors (sync/cursor.ts syncCursorKey(KEPT_AUTH_SECRET), T12);
   * absent: the app signs with a key of its own, and cursors don't outlive it. */
  syncKey?: Buffer | null;
  /** Step 4 (T15): push, mail and the test transports for the channel routes (notify/). Absent:
   * push is unavailable and mail is logged. */
  notify?: NotifyDeps | null;
  /** Step 6 (T10): the key personal tokens' secrets are HMAC'd with (tokens/verify.ts). */
  tokenKey?: Buffer | null;
  /** Step 6 (T11, T12): Better Auth, for the OAuth connectors and `/mcp`'s OAuth tokens. Absent:
   * OAuth is off and `/mcp` takes personal tokens only. */
  auth?: Auth | null;
};

/** The route modules, in registration order. */
export const INVENTORY_ROUTE_MODULES = [
  currencyRoutes,
  registryRoutes,
  typeRoutes,
  placeRoutes,
  thingRoutes,
  purchaseRoutes,
  meterRoutes,
  fileRoutes,
  secretRoutes,
  searchRoutes,
  trashRoutes,
  historyRoutes,
  homeRoutes,
  // T32 (D201): the inventory report.
  reportRoutes,
  // Step 3 (T2): capture, offline sync, AI, review, labels and scan, import, templates, undo.
  syncRoutes,
  captureRoutes,
  aiRoutes,
  extractionRoutes,
  inboxRoutes,
  labelRoutes,
  scanRoutes,
  boxCheckRoutes,
  importRoutes,
  templateRoutes,
  // T17a (D208): own codes on things and places, and a location's numbering and format rule.
  codeRoutes,
  undoRoutes,
  // Step 4 (T2): household modules. Each Phase-B task fills in its own `src/<area>/routes.ts`.
  moneyRoutes,
  warrantyRoutes,
  lendingRoutes,
  scheduleRoutes,
  paperworkRoutes,
  agendaRoutes,
  notifyRoutes,
  calendarRoutes,
  incidentRoutes,
  // Step 5 (T2): service drafts from an invoice, fuel and charging, and vehicles. Each Phase-B task
  // fills in its own `src/<area>/routes.ts`; step 4's service-record routes stay in schedules/.
  serviceDraftRoutes,
  fuelRoutes,
  vehicleRoutes,
  // Step 7 (T2): exports, archive imports, alias enrichment and consumables. Each Phase-B task
  // fills in its own file.
  exportRoutes,
  archiveImportRoutes,
  enrichRoutes,
  consumableRoutes,
  // Step 6 (T2): tokens, MCP, OAuth connectors (and the root well-known paths), the assistant and
  // location webhooks. Each Phase-B task fills in its own `src/<area>/routes.ts`.
  tokenRoutes,
  mcpRoutes,
  oauthRoutes,
  assistantRoutes,
  webhookRoutes,
  // Step 8 (T2): Admin → Backups and the keep-offline extras. Each Phase-B task fills in its own
  // file (T10, T12).
  backupRoutes,
  syncExtrasRoutes,
  // T9: the recovery kit's download after re-authentication.
  recoveryKitRoutes,
  // T11 (D65): the update check's "Check now".
  updateRoutes,
] as const satisfies readonly ((app: KeptApp, deps: InventoryDeps) => Promise<void>)[];

export async function registerInventoryRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  for (const register of INVENTORY_ROUTE_MODULES) await register(app, deps);
}
