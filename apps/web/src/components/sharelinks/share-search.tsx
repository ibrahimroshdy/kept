/**
 * Share a search's list as a read-only link (1.5, D233; D39 item 7 "a filtered list"). The link
 * keeps the words and the place, type and tag filters (@kept/shared shareViewOf) and shows what
 * they find when it is opened, in one location. So the link never shows more than the list did,
 * it is offered only for a list narrowed to one location the person administers (not Personal),
 * without state or price filters; otherwise the button says what to change (screens §3: disabled
 * with the reason). Hidden for someone who administers no location that can share.
 */
import { shareViewOf } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { useLocations } from '@/api/queries';
import { ShareIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import type { ListState } from '@/lib/url-state';
import { ShareLinkSheet } from './share-sheet';

export function ShareSearch({ list }: { list: ListState }) {
  const { t } = useLingui();
  const online = useOnline();
  const locations = useLocations();
  const nameOf = useLocationName();
  const [open, setOpen] = useState(false);
  const sharing = (locations.data ?? []).filter(
    (l) => (l.role === 'owner' || l.role === 'admin') && l.kind !== 'personal',
  );
  if (!sharing.length) return null;
  const { view, locationId, unsupported } = shareViewOf(list);
  const location = sharing.find((l) => l.id === locationId);
  const reason = unsupported.some((k) => k !== 'location')
    ? t`Remove the state and price filters to share this list.`
    : !location
      ? t`Filter it to one location you run to share this list.`
      : !online
        ? t`Needs a connection`
        : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button size="small" variant="secondary" isDisabled={!!reason} onPress={() => setOpen(true)}>
        <ShareIcon />
        <Trans>Share this list</Trans>
      </Button>
      {reason ? <span className="text-small text-ink-2">{reason}</span> : null}
      {location ? (
        <ShareLinkSheet
          isOpen={open}
          onClose={() => setOpen(false)}
          locationId={location.id}
          target={{
            kind: 'view',
            view,
            title: view.q ?? '',
            locationName: nameOf(location),
          }}
        />
      ) : null}
    </div>
  );
}
