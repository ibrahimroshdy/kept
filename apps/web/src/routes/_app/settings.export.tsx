/**
 * Settings → Export (plan T21; D68, D69, D149, D159): export a location you own or administer, or
 * your own data, and the list of your exports with their downloads. `?sheet=me` opens "Export my
 * data" (Settings → Me links here); the list's search and filters are in the URL. Its chunk loads
 * on demand from assets/household/ (vite.config.ts): exports need a connection (screens §4).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import * as z from 'zod/mini';
import type { ExportRun } from '@/api/portability/types';
import { useLocations } from '@/api/queries';
import { ExportList } from '@/components/export/export-list';
import { type ExportScopeChoice, ExportSheet } from '@/components/export/export-sheet';
import { ErrorState, LoadingRows, Notice, Page } from '@/components/page';
import { ExportRouteError } from '@/components/portability/route-error';
import { SettingsTabs } from '@/components/settings-tabs';
import { Button } from '@/components/ui/button';
import { useOnline } from '@/lib/online';
import { listSearch } from '@/lib/url-state';

export const Route = createFileRoute('/_app/settings/export')({
  validateSearch: listSearch(['state', 'location'], {
    sheet: z.optional(z.catch(z.optional(z.enum(['me', 'location'])), undefined)),
  }),
  component: ExportPage,
  errorComponent: ExportRouteError,
});

type Open = { scope: ExportScopeChoice; options?: ExportRun['options'] } | null;

function ExportPage() {
  const { t } = useLingui();
  const online = useOnline();
  const navigate = useNavigate();
  const search = Route.useSearch() as { sheet?: 'me' | 'location' };
  const locations = useLocations();
  const [again, setAgain] = useState<Open>(null);
  const exportable = (locations.data ?? []).filter(
    (l) => (l.role === 'owner' || l.role === 'admin') && l.kind !== 'personal',
  );
  const close = () => {
    setAgain(null);
    if (search.sheet)
      void navigate({
        to: '/settings/export',
        search: (s: object) => ({ ...s, sheet: undefined }),
      } as never);
  };
  const openSheet = (sheet: 'me' | 'location') =>
    void navigate({ to: '/settings/export', search: (s: object) => ({ ...s, sheet }) } as never);

  const open: Open =
    again ??
    (search.sheet === 'me'
      ? { scope: { me: true } }
      : search.sheet === 'location' && exportable[0]
        ? { scope: { locationId: exportable[0].id } }
        : null);

  return (
    <Page title={t`Export`}>
      <SettingsTabs />
      {locations.isPending ? (
        <LoadingRows rows={3} />
      ) : locations.isError ? (
        <ErrorState error={locations.error} />
      ) : (
        <>
          <p className="m-0 text-ink-2">
            <Trans>
              One file per location: everything in it, the original photos and documents, and a copy
              you can read without Kept. Import it into this Kept or another one.
            </Trans>
          </p>
          <div className="flex flex-wrap gap-2">
            {exportable.length > 0 ? (
              <Button isDisabled={!online} onPress={() => openSheet('location')}>
                <Trans>Export a location</Trans>
              </Button>
            ) : null}
            <Button variant="secondary" isDisabled={!online} onPress={() => openSheet('me')}>
              <Trans>Export my data</Trans>
            </Button>
          </div>
          {!online ? <Notice tone="warn" title={<Trans>Needs a connection</Trans>} /> : null}
          <ExportList
            locations={locations.data ?? []}
            personalId={(locations.data ?? []).find((l) => l.kind === 'personal')?.id}
            onAgain={(run) =>
              setAgain({
                scope:
                  run.scope === 'me' || !run.locationId
                    ? { me: true }
                    : { locationId: run.locationId },
                options: run.options,
              })
            }
          />
          <p className="m-0 text-small text-ink-2">
            <Trans>
              Each download link is made when you click Download and lasts 5 minutes; Kept checks
              you're still an owner or admin every time. Exports are kept 7 days.
            </Trans>
          </p>
          {open ? (
            <ExportSheet
              key={JSON.stringify(open.scope)}
              isOpen
              onClose={close}
              scope={open.scope}
              locations={exportable}
              {...(open.options ? { options: open.options } : {})}
            />
          ) : null}
        </>
      )}
    </Page>
  );
}
