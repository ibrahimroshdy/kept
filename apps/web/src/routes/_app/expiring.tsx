/**
 * Expiring (plan T23; D141, D172, screens §5 "Expiring: things, documents and warranties by
 * date"): read from the one agenda (`GET /api/v1/agenda`, T13), so what it lists is what Home's
 * rows count. By default it shows warranties (and their registration deadlines), expiring
 * documents and things that expire; Home's overdue and due rows open it with their state and,
 * when schedules or loans are among what they count, those sources too (`f.source`).
 *
 * Under the list standard: the filter strip (source, state, location, and a date range ahead,
 * a custom range only) with saved views (D205); the Display button groups by state (D211).
 * A document's row has Renew, with Undo (D150, D172).
 */
import { effectiveModules, parseDateRange } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useAgenda } from '@/api/household/queries';
import type { AgendaItem, AgendaParams } from '@/api/household/types';
import { useLocations } from '@/api/queries';
import { AgendaRow, useAgendaStateLabels } from '@/components/agenda/agenda-row';
import { sourcesOf } from '@/components/agenda/sources';
import { RenewSheet, type RenewTarget } from '@/components/documents/document-sheets';
import type { FilterDef } from '@/components/filters/types';
import { ActivityIcon, CalendarIcon, ClockIcon, HomeIcon } from '@/components/icons';
import { ListSurface } from '@/components/list-surface';
import { StepFourRouteError } from '@/components/notifications/route-error';
import { EmptyState, Page } from '@/components/page';
import { useLocationName } from '@/lib/labels';
import { firstOf, listSearch, useListState } from '@/lib/url-state';

export const Route = createFileRoute('/_app/expiring')({
  validateSearch: listSearch(['location', 'source', 'state', 'when']),
  component: ExpiringPage,
  errorComponent: (p) => <StepFourRouteError {...p} page="expiring" />,
});

const STATES = ['overdue', 'due', 'expiring', 'upcoming'] as const;

function ExpiringPage() {
  const { t } = useLingui();
  const [list] = useListState();
  const locations = useLocations();
  const nameOf = useLocationName();
  const states = useAgendaStateLabels();
  const [renewing, setRenewing] = useState<RenewTarget | null>(null);
  const all = locations.data ?? [];

  const location = firstOf(list, 'location');
  const state = firstOf(list, 'state') as AgendaParams['state'];
  const range = parseDateRange(firstOf(list, 'when') ?? '');
  const params: AgendaParams = {
    sourceType: sourcesOf(list.filters.source),
    ...(location ? { locationId: location } : {}),
    ...(state ? { state } : {}),
    ...(range?.from ? { from: range.from } : {}),
    ...(range?.to ? { to: range.to } : {}),
  };
  const query = useAgenda(params);

  const schedulesOn = all.some((l) =>
    (
      l.effectiveModules ?? [
        ...effectiveModules(l.modules, { providerResolved: l.providerResolved }),
      ]
    ).includes('schedules'),
  );
  const filters: FilterDef[] = [
    {
      key: 'source',
      label: t`What`,
      icon: <ClockIcon />,
      kind: 'multi',
      negatable: false,
      values: {
        from: 'static',
        options: [
          { value: 'warranty', label: t`Warranties` },
          { value: 'document', label: t`Documents` },
          { value: 'thing_expiry', label: t`Things that expire` },
          ...(schedulesOn ? [{ value: 'schedule', label: t`Schedules` }] : []),
          { value: 'loan', label: t`Loans` },
          { value: 'reading', label: t`Readings due` },
        ],
      },
    },
    {
      key: 'state',
      label: t`State`,
      icon: <ActivityIcon />,
      kind: 'single',
      values: {
        from: 'static',
        options: STATES.map((s) => ({ value: s, label: states[s] })),
      },
    },
    ...(all.length > 1
      ? [
          {
            key: 'location',
            label: t`Location`,
            icon: <HomeIcon />,
            kind: 'single' as const,
            values: {
              from: 'static' as const,
              options: all.map((l) => ({ value: l.id, label: nameOf(l) })),
            },
          },
        ]
      : []),
    { key: 'when', label: t`Date`, icon: <CalendarIcon />, kind: 'date-range', presets: false },
  ];

  const order: Record<string, number> = { overdue: 0, expired: 0, due: 1, expiring: 2 };
  return (
    <Page title={t`Expiring`} wide>
      <ListSurface<AgendaItem>
        label={t`Expiring`}
        search={false}
        filters={filters}
        surface="expiring"
        groups={[
          { value: 'state', label: t`State`, short: t`by state` },
          { value: 'none', label: t`None` },
        ]}
        query={query}
        getKey={(i) => i.key}
        renderRow={(i) => (
          <AgendaRow
            item={i}
            onRenew={(item, name) =>
              setRenewing({ id: item.sourceId, locationId: item.locationId, name })
            }
          />
        )}
        groupOf={(i, by) =>
          by === 'state'
            ? {
                key: String(order[i.state] ?? 3),
                label: states[i.state === 'expired' ? 'overdue' : i.state],
              }
            : null
        }
        empty={
          <EmptyState icon={<ClockIcon />} title={<Trans>Nothing runs out soon</Trans>}>
            <Trans>
              Warranties, documents like the lease or the home insurance, and things with an expiry
              date show here, soonest first.
            </Trans>
          </EmptyState>
        }
      />
      <RenewSheet target={renewing} onClose={() => setRenewing(null)} />
    </Page>
  );
}
