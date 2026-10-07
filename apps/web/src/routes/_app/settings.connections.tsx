/**
 * Settings → Connections (step-6 plan T21; D58, D63, D124, D179, screens §5): personal tokens and
 * connected apps (OAuth) on one list with a location filter, New token (shown once, with the
 * client configs), each location's webhooks for those who manage it, and recent changes by
 * connections with undo. Its chunk loads on demand from assets/household/ (vite.config.ts).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute, type ErrorComponentProps } from '@tanstack/react-router';
import { useState } from 'react';
import * as z from 'zod/mini';
import { useLocations } from '@/api/queries';
import { RecentChanges } from '@/components/connections/recent-changes';
import { TokenCreateSheet } from '@/components/connections/token-create';
import { CONNECTION_FILTERS, ConnectionsList } from '@/components/connections/tokens';
import { LinkIcon, PlusIcon } from '@/components/icons';
import { HouseholdRouteError } from '@/components/notifications/route-error';
import { IconTile, LinkButton, List, Page, Row, Section } from '@/components/page';
import { SettingsTabs } from '@/components/settings-tabs';
import { Button } from '@/components/ui/button';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import { listSearch } from '@/lib/url-state';

export const Route = createFileRoute('/_app/settings/connections')({
  validateSearch: listSearch(CONNECTION_FILTERS, { changes: z.optional(z.string()) }),
  component: ConnectionsPage,
  errorComponent: RouteError,
});

function ConnectionsPage() {
  const { t } = useLingui();
  const online = useOnline();
  const [creating, setCreating] = useState(false);
  return (
    <Page title={t`Connections`}>
      <SettingsTabs />
      <p className="m-0 text-ink-2">
        <Trans>
          Tokens and connected apps let AI apps like Claude, and your own scripts, find and add your
          things. Each is limited to the locations you choose, and every change it makes is listed
          below with undo.
        </Trans>
      </p>
      <Section title={<Trans>Tokens and connected apps</Trans>}>
        <ConnectionsList
          action={
            <Button size="small" isDisabled={!online} onPress={() => setCreating(true)}>
              <PlusIcon />
              <Trans>New token</Trans>
            </Button>
          }
        />
        {!online ? (
          <p className="m-0 text-ink-2 text-small">
            <Trans>Needs a connection</Trans>
          </p>
        ) : null}
      </Section>
      <TokenCreateSheet isOpen={creating} onOpenChange={setCreating} />
      <WebhooksLinks />
      <RecentChanges />
    </Page>
  );
}

/** Webhooks live in each location's settings; those you manage are listed here (screens §5). */
function WebhooksLinks() {
  const locations = useLocations();
  const nameOf = useLocationName();
  const managed = (locations.data ?? []).filter((l) => l.role === 'owner' || l.role === 'admin');
  if (managed.length === 0) return null;
  return (
    <Section title={<Trans>Webhooks</Trans>}>
      <List>
        {managed.map((l) => (
          <li key={l.id}>
            <Row
              leading={
                <IconTile>
                  <LinkIcon />
                </IconTile>
              }
              title={<bdi>{nameOf(l)}</bdi>}
              subtitle={<Trans>Tell your own server when things change here.</Trans>}
              trailing={
                <LinkButton
                  to="/settings/location/$id/webhooks"
                  params={{ id: l.id }}
                  size="small"
                  variant="secondary"
                >
                  <Trans>Open</Trans>
                </LinkButton>
              }
            />
          </li>
        ))}
      </List>
    </Section>
  );
}

/** Offline before the page's first load: "Needs a connection", in the page's frame. */
function RouteError(props: ErrorComponentProps) {
  const { t } = useLingui();
  return <HouseholdRouteError {...props} title={t`Connections`} />;
}
