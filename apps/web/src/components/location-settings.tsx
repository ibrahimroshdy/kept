/**
 * The frame for Location settings pages (screens §5): the location's name, the section tabs
 * (General · What to track · Members; Personal has no Members, D114; Webhooks for its owner and
 * admins, step 6) and the owner/admin gate.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { useLocation } from '@/api/queries';
import type { LocationDetail } from '@/api/types';
import { LinkTabs } from '@/components/link-tabs';
import { ErrorState, LoadingRows, Notice, Page } from '@/components/page';
import { useLocationName } from '@/lib/labels';

export function LocationSettingsPage({
  id,
  title,
  section,
  children,
}: {
  id: string;
  /** Which tab a sub-page belongs to (Invite belongs to Members). */
  section?: 'general' | 'members' | 'track' | 'webhooks';
  /** The page title; defaults to "Location settings". */
  title?: (location: LocationDetail) => ReactNode;
  children: (location: LocationDetail) => ReactNode;
}) {
  const { t } = useLingui();
  const location = useLocation(id);
  const nameOf = useLocationName();
  const back = { to: '/loc/$id' as const, params: { id } };
  // Loading and error states fill like the loaded page, whose tabs make it fill (useSectionTabs),
  // so nothing jumps sideways when the location arrives.
  if (location.isPending)
    return (
      <Page title={t`Location settings`} back={back} fill>
        <LoadingRows />
      </Page>
    );
  if (location.error)
    return (
      <Page title={t`Location settings`} back={back} fill>
        <ErrorState error={location.error} onRetry={() => void location.refetch()} />
      </Page>
    );
  const loc = location.data;
  const admin = loc.role === 'owner' || loc.role === 'admin';
  const personal = loc.kind === 'personal';
  const name = nameOf(loc);
  return (
    <Page
      title={title ? title(loc) : t`Location settings`}
      eyebrow={<Trans>{name} · Location settings</Trans>}
      back={back}
    >
      <LinkTabs
        label={t`Location settings`}
        tabs={[
          {
            key: 'general',
            label: <Trans>General</Trans>,
            link: { to: '/settings/location/$id/general', params: { id } },
          },
          {
            key: 'track',
            label: <Trans>What to track</Trans>,
            link: { to: '/settings/location/$id/track', params: { id } },
          },
          ...(personal
            ? []
            : [
                {
                  key: 'members',
                  label: <Trans>Members</Trans>,
                  link: { to: '/settings/location/$id/members' as const, params: { id } },
                  current: section === 'members',
                },
              ]),
          // Webhooks (step 6, T23): owners and admins only, hidden for everyone else.
          ...(admin
            ? [
                {
                  key: 'webhooks',
                  label: <Trans>Webhooks</Trans>,
                  link: { to: '/settings/location/$id/webhooks' as const, params: { id } },
                },
              ]
            : []),
        ]}
      />
      {admin ? (
        children(loc)
      ) : (
        <Notice tone="info" title={<Trans>Only the owner and admins change this</Trans>}>
          <Trans>Ask an admin of {name} if something here should change.</Trans>
        </Notice>
      )}
    </Page>
  );
}
