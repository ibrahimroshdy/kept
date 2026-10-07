import type { KeptApp } from '../http/app.js';
import type { InventoryDeps } from '../http/routes.js';
import { centreRoutes } from './centre.js';
import { channelRoutes } from './channel-routes.js';

// Step 4: channels, push subscriptions, preferences (T15, channel-routes.ts) and the notification
// centre (T16, centre.ts). Registered in http/routes.ts; each task adds its own module here and never edits
// that file.

export async function notifyRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  await channelRoutes(app, deps);
  await centreRoutes(app, deps);
}
