import type { Proposal } from '@kept/shared';
import { describe, expect, it } from 'vitest';
import { rowsOf } from './confirm-rows';

const LOC = '0192f0c3-7c55-7000-8000-000000000001';
const CAR = '0192f0c3-7c55-7000-8000-000000000002';
const OIL = '0192f0c3-7c55-7000-8000-000000000003';

const proposal = (args: Record<string, unknown>, refs: Proposal['refs']): Proposal => ({
  id: 'p1',
  batchId: 'b1',
  turnId: 't1',
  locationId: LOC,
  tool: 'log_service',
  args,
  argsHash: '0',
  before: {},
  refs: { [LOC]: { kind: 'location', name: 'Home', path: [] }, ...refs },
  status: 'open',
  expiresAt: '2026-10-15T00:00:00Z',
});

describe('log_service rows', () => {
  it('names each line that takes stock (D236): how much, 1 unless said, of what', () => {
    const [row] = rowsOf(
      proposal(
        {
          thing_id: CAR,
          serviced_on: '2026-10-14',
          lines: [
            { description: 'Oil change', consumable_thing_id: 'k7d-2qx', consumed_quantity: 4.5 },
            { description: 'Oil filter', consumable_thing_id: 'H4M9TR' },
            { description: 'Check-up' },
          ],
        },
        {
          [CAR]: { kind: 'thing', name: 'Corolla', path: [] },
          'k7d-2qx': { kind: 'thing', name: 'Engine oil', path: [] },
          [OIL]: { kind: 'thing', name: 'Engine oil', path: [] },
        },
      ),
    );
    expect(row?.verb).toBe('service');
    expect(row?.fields.filter((f) => f.key === 'stock').map((f) => f.after)).toEqual([
      { t: 'take', n: 4.5, name: 'Engine oil' },
      // Not in refs (not found when proposed): shown without a name, never the raw id.
      { t: 'take', n: 1 },
    ]);
    expect(row?.fields.find((f) => f.key === 'lines')?.after).toEqual({
      t: 'list',
      v: ['Oil change', 'Oil filter', 'Check-up'],
    });
  });
});
