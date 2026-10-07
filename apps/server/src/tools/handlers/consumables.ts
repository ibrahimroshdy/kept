import { adjustStock } from '../../consumables/service.js';
import { liveThing } from '../../things/service.js';
import { thingRefOf } from '../output.js';
import { locationOfRef, thingIn } from '../resolve.js';
import type { Handler, Op } from '../types.js';
import { writeResult } from './write.js';

// Step 7's tool (§2.5, D124; plan T17): `adjust_stock` calls the Adjust route's own operation
// (consumables/service.ts adjustStock), so a change by the assistant or MCP meets the same rules:
// `things.edit`, the Consumables module (runTool's gate, the contract's `module`), the thing's
// version (D156) and quantity rules (D10: never below 0, D183). It is the thing's own
// `thing.update`, undoable for 7 days as the route's is.

const locationOf = (op: Op) => {
  if (!op.location) throw new Error('a write tool always runs in one location');
  return op.location;
};

export const adjustStockTool: Handler<'adjust_stock'> = {
  action: 'things.edit',
  subjectLocation: (client, input) => locationOfRef(client, input.thing_id),
  run: async (op, input) => {
    const loc = locationOf(op);
    const id = await thingIn(op.client, loc.id, input.thing_id);
    const expected = op.ifMatch ?? (await liveThing(op.client, id)).row_version;
    const row = await adjustStock(op, id, expected, { delta: input.delta });
    return {
      data: {
        ...(await writeResult(op, 'thing', id)),
        thing: thingRefOf(row, loc.name),
        quantity: row.quantity,
      },
    };
  },
};
