/**
 * Paperwork (plan T23; D39, D155, D172, screens §5): every receipt, invoice, manual, warranty
 * document and location or place document across your locations with Paperwork on, found by a
 * word inside them (the file's text, step 3), under the list standard: the filter strip (location,
 * kind, what it's on, expiry) with saved views (D205), and the Display button's layout, a list or
 * a grid (D211). Each row opens the file and links to what it belongs to.
 *
 * What runs out soon has its own screen, Expiring, linked from the header.
 */
import { effectiveModules } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import * as z from 'zod/mini';
import { usePaperwork } from '@/api/household/queries';
import type { PaperworkParams, PaperworkRow } from '@/api/household/types';
import { useLocations } from '@/api/queries';
import type { FilterDef } from '@/components/filters/types';
import { BoxIcon, ClockIcon, DocumentIcon, HomeIcon } from '@/components/icons';
import { ListSurface } from '@/components/list-surface';
import { StepFourRouteError } from '@/components/notifications/route-error';
import { EmptyState, LinkButton, Page } from '@/components/page';
import { PaperworkListRow, PaperworkTile } from '@/components/paperwork/rows';
import { useRoleLabels } from '@/components/things/labels';
import { useLocationName } from '@/lib/labels';
import { firstOf, listSearch, useListState } from '@/lib/url-state';

/** The roles the library lists: paperwork, never photos or condition photos. */
const LIBRARY_ROLES = [
  'receipt',
  'invoice',
  'manual',
  'warranty_doc',
  'registration',
  'document',
] as const;

export const Route = createFileRoute('/_app/paperwork')({
  validateSearch: listSearch(['location', 'role', 'subject', 'expiry'], {
    view: z.optional(z.catch(z.enum(['list', 'grid']), 'list')),
  }),
  component: PaperworkPage,
  errorComponent: (p) => <StepFourRouteError {...p} page="paperwork" />,
});

function PaperworkPage() {
  const { t } = useLingui();
  const [list] = useListState();
  const locations = useLocations();
  const nameOf = useLocationName();
  const roles = useRoleLabels();
  const withPaperwork = (locations.data ?? []).filter((l) =>
    (
      l.effectiveModules ?? [
        ...effectiveModules(l.modules, { providerResolved: l.providerResolved }),
      ]
    ).includes('paperwork'),
  );
  const grid = list.layout === 'grid';

  const location = firstOf(list, 'location');
  const role = firstOf(list, 'role');
  const subject = firstOf(list, 'subject') as PaperworkParams['subjectType'];
  const expiry = firstOf(list, 'expiry') as PaperworkParams['expiry'];
  const params: PaperworkParams = {
    ...(list.q ? { q: list.q } : {}),
    ...(location ? { locationId: location } : {}),
    ...(role ? { role } : {}),
    ...(subject ? { subjectType: subject } : {}),
    ...(expiry ? { expiry } : {}),
  };
  const query = usePaperwork(params);

  const filters: FilterDef[] = [
    ...(withPaperwork.length > 1
      ? [
          {
            key: 'location',
            label: t`Location`,
            icon: <HomeIcon />,
            kind: 'single' as const,
            values: {
              from: 'static' as const,
              options: withPaperwork.map((l) => ({ value: l.id, label: nameOf(l) })),
            },
          },
        ]
      : []),
    {
      key: 'role',
      label: t`Kind`,
      icon: <DocumentIcon />,
      kind: 'single',
      values: {
        from: 'static',
        options: LIBRARY_ROLES.map((r) => ({ value: r, label: roles[r] })),
      },
    },
    {
      key: 'subject',
      label: t`On`,
      icon: <BoxIcon />,
      kind: 'single',
      values: {
        from: 'static',
        options: [
          { value: 'thing', label: t`Things` },
          { value: 'place', label: t`Places` },
          { value: 'location', label: t`Whole locations` },
        ],
      },
    },
    {
      key: 'expiry',
      label: t`Expiry`,
      icon: <ClockIcon />,
      kind: 'single',
      values: {
        from: 'static',
        options: [
          { value: 'expiring', label: t`Runs out soon` },
          { value: 'expired', label: t`Ran out` },
        ],
      },
    },
  ];

  return (
    <Page
      title={t`Paperwork`}
      wide
      actions={
        <LinkButton to="/expiring" size="small" variant="secondary">
          <ClockIcon className="size-4" />
          <Trans>Expiring</Trans>
        </LinkButton>
      }
    >
      <ListSurface<PaperworkRow>
        label={t`Paperwork`}
        search={{
          label: t`Search your paperwork`,
          placeholder: t`A word inside, or what it's for`,
        }}
        filters={filters}
        surface="paperwork"
        layouts={[
          { value: 'list', label: t`List` },
          { value: 'grid', label: t`Grid`, short: t`grid` },
        ]}
        tiles={grid}
        query={query}
        getKey={(r) => `${r.attachment.id}:${r.expiring?.id ?? ''}`}
        renderRow={(r) => (grid ? <PaperworkTile row={r} /> : <PaperworkListRow row={r} />)}
        empty={
          <EmptyState icon={<DocumentIcon />} title={<Trans>No paperwork yet</Trans>}>
            {withPaperwork.length === 0 ? (
              <Trans>
                Paperwork is off in every location. An admin turns it on in What to track.
              </Trans>
            ) : (
              <Trans>
                Receipts, manuals and warranty cards added to things, and the lease or insurance
                added to a location or a room, all show here.
              </Trans>
            )}
          </EmptyState>
        }
      />
    </Page>
  );
}
