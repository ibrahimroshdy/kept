import type { ToolName } from '@kept/mcp';
import { adjustStockTool } from './handlers/consumables.js';
import {
  addWarranty,
  borrowThing,
  completeScheduleTool,
  lendThing,
  openClaim,
  returnThing,
  snoozeScheduleTool,
  upcoming,
  updateClaimTool,
} from './handlers/household.js';
import {
  capabilities,
  findDocuments,
  getThing,
  listContents,
  listLocations,
  searchThings,
  thingHistoryTool,
  whereIs,
} from './handlers/read.js';
import { logServiceTool } from './handlers/services.js';
import { logFuelTool } from './handlers/vehicles.js';
import {
  addThing,
  attachLink,
  createPlaceTool,
  logReading,
  markSeenTool,
  moveThing,
  updateThingTool,
} from './handlers/write.js';
import type { Handler, HandlerTable } from './types.js';

// The handlers, one per TOOL_DEFS entry whose service exists (step-6 plan T9, Q10). A contract
// without a handler is never offered (`capabilities`, toolsFor()) and answers
// `tool_unavailable`. Step 4's services exist, so its tools are here; step 5's join with their
// services (log_service with schedules/services.ts, log_fuel with fuel/service.ts), and step 7's
// adjust_stock with consumables/service.ts.

const HANDLERS: HandlerTable = {
  capabilities,
  list_locations: listLocations,
  search_things: searchThings,
  where_is: whereIs,
  get_thing: getThing,
  list_contents: listContents,
  thing_history: thingHistoryTool,
  find_documents: findDocuments,
  add_thing: addThing,
  update_thing: updateThingTool,
  move_thing: moveThing,
  mark_seen: markSeenTool,
  create_place: createPlaceTool,
  attach_link: attachLink,
  log_reading: logReading,
  // Step 4's services (lending, schedules, warranties and claims, the agenda).
  upcoming,
  lend_thing: lendThing,
  return_thing: returnThing,
  borrow_thing: borrowThing,
  complete_schedule: completeScheduleTool,
  snooze_schedule: snoozeScheduleTool,
  add_warranty: addWarranty,
  open_claim: openClaim,
  update_claim: updateClaimTool,
  // Step 5's services (services, fuel).
  log_service: logServiceTool,
  log_fuel: logFuelTool,
  // Step 7's service (consumables).
  adjust_stock: adjustStockTool,
};

export function handlerOf<N extends ToolName>(name: N): Handler<N> | undefined {
  return HANDLERS[name] as Handler<N> | undefined;
}

/** The tools with a handler, in TOOL_DEFS order. */
export function handledTools(): ToolName[] {
  return Object.keys(HANDLERS) as ToolName[];
}
