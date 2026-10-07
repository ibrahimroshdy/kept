/**
 * Settings → Locations: each location's settings, for the ones you run, and your recently
 * deleted locations with Restore until they are purged (D149, 30 days).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { restoreLocation } from '@/api/locations';
import { keys, useDeletedLocations, useLocations } from '@/api/queries';
import type { DeletedLocation } from '@/api/types';
import { ChevronEndIcon } from '@/components/icons';
import { KindIcon } from '@/components/kind-icon';
import { SettingsRouteError } from '@/components/on-demand-route-error';
import {
  ErrorState,
  IconTile,
  LinkButton,
  List,
  LoadingRows,
  Page,
  Row,
  Section,
  useErrorText,
} from '@/components/page';
import { SettingsTabs } from '@/components/settings-tabs';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { sep, useFormat } from '@/lib/format';
import { useKindLabels, useLocationName, useRoleLabels } from '@/lib/labels';

export const Route = createFileRoute('/_app/settings/locations')({
  component: LocationsSettings,
  errorComponent: SettingsRouteError,
});

function LocationsSettings() {
  const { t } = useLingui();
  const locations = useLocations();
  const kinds = useKindLabels();
  const roles = useRoleLabels();
  const nameOf = useLocationName();
  return (
    <Page title={t`Settings`}>
      <SettingsTabs />
      {locations.isPending ? (
        <LoadingRows />
      ) : locations.error ? (
        <ErrorState error={locations.error} onRetry={() => void locations.refetch()} />
      ) : (
        <List>
          {locations.data.map((l) => {
            const runs = l.role === 'owner' || l.role === 'admin';
            return (
              <li key={l.id}>
                <Link
                  {...(runs
                    ? { to: '/settings/location/$id/track' as const, params: { id: l.id } }
                    : { to: '/loc/$id' as const, params: { id: l.id } })}
                  className="block outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info"
                >
                  <Row
                    leading={
                      <IconTile>
                        <KindIcon kind={l.kind} />
                      </IconTile>
                    }
                    title={nameOf(l)}
                    subtitle={
                      <>
                        {kinds[l.kind]}
                        {sep()}
                        {roles.you[l.role]}
                      </>
                    }
                    trailing={<ChevronEndIcon className="size-5 text-ink-3" />}
                  />
                </Link>
              </li>
            );
          })}
        </List>
      )}
      <LinkButton to="/locations/new" className="w-full">
        <Trans>New location</Trans>
      </LinkButton>
      <RecentlyDeleted />
    </Page>
  );
}

/**
 * Only the owner deletes a location, so the list holds only yours; the section is absent when it
 * is empty (and quietly absent if it fails to load: it's a side list, the page still works).
 */
function RecentlyDeleted() {
  const deleted = useDeletedLocations();
  if (!deleted.data || deleted.data.length === 0) return null;
  return (
    <Section title={<Trans>Recently deleted</Trans>}>
      <p className="m-0 text-small text-ink-2">
        <Trans>
          Only you see these. Restore one to bring it back with everything in it and everyone who
          had access.
        </Trans>
      </p>
      <List>
        {deleted.data.map((d) => (
          <li key={d.id}>
            <DeletedRow location={d} />
          </li>
        ))}
      </List>
    </Section>
  );
}

function DeletedRow({ location }: { location: DeletedLocation }) {
  const { t } = useLingui();
  const f = useFormat();
  const kinds = useKindLabels();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const name = location.name;
  const deletedOn = f.day(location.deletedAt);
  const purgeOn = f.day(location.purgeAfter);
  const restore = useMutation({
    mutationFn: () => restoreLocation(location.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.locations });
      await qc.invalidateQueries({ queryKey: keys.me });
      toast({ title: t`${name} restored`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  return (
    <Row
      leading={
        <IconTile>
          <KindIcon kind={location.kind} />
        </IconTile>
      }
      title={name}
      subtitle={
        <>
          {kinds[location.kind] ?? null}
          {sep()}
          <Trans>
            Deleted {deletedOn} · gone for good on {purgeOn}
          </Trans>
        </>
      }
      trailing={
        <Button
          size="small"
          variant="secondary"
          aria-label={t`Restore ${name}`}
          isPending={restore.isPending}
          onPress={() => restore.mutate()}
        >
          <Trans>Restore</Trans>
        </Button>
      }
    />
  );
}
