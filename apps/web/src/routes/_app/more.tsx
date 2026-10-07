/** More (phone): screens §1's list. The desktop has the same entries in the sidebar. */
import { Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useLocations } from '@/api/queries';
import { useNavEntries, VersionFooter } from '@/components/app-shell';
import { SoonBadge } from '@/components/coming-later';
import { ChevronEndIcon, PlusIcon } from '@/components/icons';
import { KindIcon } from '@/components/kind-icon';
import { IconTile, List, Page, Row, Section } from '@/components/page';
import { SignOutButton } from '@/components/sign-out';
import { useLocationName } from '@/lib/labels';

export const Route = createFileRoute('/_app/more')({ component: MorePage });

function MorePage() {
  const { t } = useLingui();
  const locations = useLocations();
  const nameOf = useLocationName();
  const entries = useNavEntries().filter((e) => e.key !== 'home' && e.key !== 'inbox');
  return (
    <Page title={t`More`}>
      <Section title={<Trans>Locations</Trans>}>
        <List>
          {(locations.data ?? []).map((l) => (
            <li key={l.id}>
              <Link
                to="/loc/$id"
                params={{ id: l.id }}
                className="block outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info"
              >
                <Row
                  leading={
                    <IconTile>
                      <KindIcon kind={l.kind} />
                    </IconTile>
                  }
                  title={nameOf(l)}
                  trailing={<ChevronEndIcon className="size-5 text-ink-3" />}
                />
              </Link>
            </li>
          ))}
          <li>
            <Link
              to="/locations/new"
              className="block outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info"
            >
              <Row
                leading={
                  <IconTile>
                    <PlusIcon />
                  </IconTile>
                }
                title={<Trans>New location</Trans>}
              />
            </Link>
          </li>
        </List>
      </Section>
      <Section title={<Trans>Everything else</Trans>}>
        <List>
          {entries.map((e) =>
            e.to ? (
              <li key={e.key}>
                <Link
                  to={e.to}
                  className="block outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info"
                >
                  <Row
                    leading={<IconTile>{e.icon}</IconTile>}
                    title={e.label}
                    trailing={<ChevronEndIcon className="size-5 text-ink-3" />}
                  />
                </Link>
              </li>
            ) : (
              <li key={e.key} aria-disabled="true" className="cursor-not-allowed">
                <Row
                  leading={<IconTile className="opacity-60">{e.icon}</IconTile>}
                  title={<span className="opacity-60">{e.label}</span>}
                  trailing={<SoonBadge />}
                />
              </li>
            ),
          )}
        </List>
      </Section>
      <SignOutButton />
      <VersionFooter className="justify-center" />
    </Page>
  );
}
