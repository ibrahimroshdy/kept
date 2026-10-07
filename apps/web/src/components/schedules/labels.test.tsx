import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Schedule } from '@/api/household/types';
import { renderUI } from '@/test/render';
import { useScheduleText } from './labels';

const oil = (next: Schedule['next']): Schedule => ({
  id: 's1',
  locationId: 'l1',
  subject: { type: 'thing', id: 't1', name: 'Toyota Corolla', path: 'Garage' },
  name: 'Oil change',
  everyMonths: 12,
  everyUnits: '10000',
  meter: { id: 'm1', label: 'Odometer', unit: 'km' },
  dueOn: null,
  leadDays: 14,
  leadUnits: null,
  anchorOn: '2026-03-14',
  anchorValue: '41000',
  next,
  snoozedUntil: null,
  snoozedUntilValue: null,
  skipNext: false,
  active: true,
  lastService: null,
  rowVersion: 1,
});

function Due({ s }: { s: Schedule }) {
  return <p>{useScheduleText().due(s, '2026-09-30')}</p>;
}

describe('a schedule due by the day or the meter (T29)', () => {
  it('overdue by the meter while the day is ahead: says the reading passed it', async () => {
    await renderUI(
      <Due s={oil({ dueOn: '2027-03-14', dueValue: '51000', state: 'overdue', basis: 'both' })} />,
    );
    expect(screen.getByText('Past 51,000 km')).toBeInTheDocument();
  });

  it('upcoming: the day and the reading, whichever comes first', async () => {
    await renderUI(
      <Due s={oil({ dueOn: '2027-03-14', dueValue: '51000', state: 'upcoming', basis: 'both' })} />,
    );
    expect(screen.getByText('In 165 days or at 51,000 km')).toBeInTheDocument();
  });
});
