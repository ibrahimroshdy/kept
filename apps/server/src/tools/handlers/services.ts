import type pg from 'pg';
import { invalid } from '../../http/errors.js';
import { createService, type LineInput, type VendorInput } from '../../schedules/services.js';
import { locationOfRef, placeIn, thingIn } from '../resolve.js';
import type { Handler, Op } from '../types.js';
import { eventOf } from './household.js';

// `log_service` (step 5; §2.5, D124): calls step 4's "Log a service" operation
// (schedules/services.ts createService, the one POST /api/v1/service-records calls), so a service
// by the assistant or MCP meets the route's rules: `logs.add`, the money gate and an enabled
// currency for a total or a priced line, `schedules-claims.manage` and Schedules on for
// `completes`, and a vendor of the location's account. It records a **confirmed** service
// record, never a draft: a draft is an invoice being read by AI, which only the person confirms
// on the Log a service form (T9, Q12), and the assistant never runs a write tool until the person
// confirms its card (step-6 plan T13, D22). Undoable for 7 days when it completes a schedule,
// as the route's is (D150); a plain log is removed by DELETE.

const locationOf = (op: Op) => {
  if (!op.location) throw new Error('a write tool always runs in one location');
  return op.location;
};

/** A vendor as the model names it: one of the location's account by that name (so "Bay Motors"
 * twice is one vendor), else a new one by name, created inline as the route would (D11). */
async function vendorOf(
  client: pg.ClientBase,
  locationId: string,
  raw: string,
): Promise<VendorInput> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT v.id FROM public.vendors v
       JOIN public.locations l ON l.owner_account_id = v.owner_account_id
      WHERE l.id = $1 AND kept.normalize(v.name) = kept.normalize($2)
      ORDER BY v.created_at, v.id LIMIT 1`,
    [locationId, raw],
  );
  return rows[0] ? { id: rows[0].id } : { name: raw };
}

export const logServiceTool: Handler<'log_service'> = {
  action: 'logs.add',
  subjectLocation: (client, input) => locationOfRef(client, input.thing_id ?? input.place_id),
  run: async (op, input) => {
    const loc = locationOf(op);
    if ((input.thing_id === undefined) === (input.place_id === undefined)) {
      throw invalid('Give thing_id or place_id (one of them).');
    }
    const subject = input.thing_id
      ? { thingId: await thingIn(op.client, loc.id, input.thing_id) }
      : { placeId: await placeIn(op.client, loc.id, input.place_id as string) };

    // One currency for the total and the priced lines, each 0 or more.
    const amounts = [input.total, ...(input.lines ?? []).map((l) => l.amount)].filter(
      (m) => m !== undefined,
    );
    if (amounts.some((m) => m.amount.startsWith('-'))) throw invalid('Amounts are 0 or more.');
    const currencies = new Set(amounts.map((m) => m.currency));
    if (currencies.size > 1) throw invalid('Give the total and the lines in one currency.');
    const [currency] = currencies;

    const lines: LineInput[] = (input.lines ?? []).map((l) => ({
      kind: 'other',
      description: l.description,
      ...(l.amount ? { quantity: '1', unitCost: l.amount.amount } : {}),
    }));
    const vendor = input.vendor?.trim();
    const record = await createService(op, {
      subject,
      servicedOn: input.serviced_on,
      ...(vendor ? { vendor: await vendorOf(op.client, loc.id, vendor) } : {}),
      ...(input.total ? { total: input.total.amount } : {}),
      ...(currency ? { currency } : {}),
      lines,
      ...(input.completes?.length ? { completes: input.completes } : {}),
    });
    return {
      data: { ...(await eventOf(op, 'service_record', record.id)), service_id: record.id },
    };
  },
};
