import type { FuelUnit } from '@kept/shared';
import { logFuel } from '../../fuel/service.js';
import { invalid } from '../../http/errors.js';
import { locationOfRef, thingIn } from '../resolve.js';
import type { Handler, Op } from '../types.js';

// Step 5's tools (§2.5, D124): `log_fuel` calls the fill route's own operation (fuel/service.ts
// logFuel), so a fill by the assistant or MCP meets the same rules: `logs.add`, the Fuel module
// (runTool's gate, the contract's `module`), the money gate and an enabled currency for a cost,
// and the odometer through the meters' entry (a value that runs backwards is refused, nothing
// written). The fill is undoable for 7 days, as the route's is.

const locationOf = (op: Op) => {
  if (!op.location) throw new Error('a write tool always runs in one location');
  return op.location;
};

/** The unit as a person or a model writes it, as Kept stores it (D76: never converted). */
const UNITS: Readonly<Record<string, FuelUnit>> = {
  l: 'L',
  litre: 'L',
  litres: 'L',
  liter: 'L',
  liters: 'L',
  kwh: 'kWh',
  gal: 'gal',
  gallon: 'gal',
  gallons: 'gal',
};

/** A number as a decimal string with at most 3 decimals, within [min, max]. */
function decimalOf(n: number, what: string, min: number, max: number): string {
  const milli = Math.round(n * 1000);
  if (milli < min * 1000 || milli > max * 1000) throw invalid(`Check ${what}.`);
  const whole = Math.floor(milli / 1000);
  const frac = String(milli % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

export const logFuelTool: Handler<'log_fuel'> = {
  action: 'logs.add',
  subjectLocation: (client, input) => locationOfRef(client, input.thing_id),
  run: async (op, input) => {
    const loc = locationOf(op);
    const thingId = await thingIn(op.client, loc.id, input.thing_id);
    const unit = UNITS[input.unit.trim().toLowerCase()];
    if (!unit) throw invalid('unit is L, kWh or gal.');
    if (input.cost?.amount.startsWith('-')) throw invalid('cost is 0 or more.');
    const res = await logFuel(op, thingId, {
      takenAt: new Date().toISOString(),
      amount: decimalOf(input.amount, 'amount: more than 0', 0.001, 9_999_999),
      unit,
      ...(input.cost ? { cost: input.cost.amount, currency: input.cost.currency } : {}),
      isFull: input.full ?? true,
      ...(input.reading !== undefined
        ? { reading: { value: decimalOf(input.reading, 'reading', 0, 99_999_999_999) } }
        : {}),
    });
    return {
      data: {
        audit_event_id: res.undo.eventId,
        undo_until: res.undo.until,
        fill_id: res.entry.id,
      },
    };
  },
};
