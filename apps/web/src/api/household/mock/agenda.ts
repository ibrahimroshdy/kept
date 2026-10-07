/**
 * Mock handler for the agenda (T13; Q7, Q24): every reminder source as one list, from db.ts's
 * `agendaItems`, the same computation the schedules' `next` and the notification centre's live
 * state read, so a count always equals the list it opens. The Expiring screen reads
 * `sourceType=warranty,document,thing_expiry`.
 */

import { paginate } from '../../inventory/mock/db';
import type { MockState } from '../../mock/fixtures';
import { type MockRoute, route } from '../../mock/kit';
import { householdPaths as p } from '../paths';
import { agendaItems, ensureSeeded } from './db';

export function agendaRoutes(state: MockState): MockRoute[] {
  return [
    route('GET', p.agenda, ({ query }) => {
      ensureSeeded(state);
      const loc = query.get('locationId');
      const types = query.get('sourceType')?.split(',').filter(Boolean) ?? [];
      const want = query.get('state');
      const from = query.get('from');
      const to = query.get('to');
      const scoped = agendaItems(state).filter(
        (i) =>
          (!loc || i.locationId === loc) &&
          (types.length === 0 || types.includes(i.sourceType)) &&
          (!from || (i.dueOn ?? '') >= from) &&
          (!to || (i.dueOn ?? '9999') <= to),
      );
      const counts = {
        overdue: scoped.filter((i) => i.state === 'overdue').length,
        due: scoped.filter((i) => i.state === 'due').length,
        expiring: scoped.filter((i) => i.state === 'expiring').length,
      };
      const items = want ? scoped.filter((i) => i.state === want) : scoped;
      return { ...paginate(items, query, 20), counts };
    }),
  ];
}
