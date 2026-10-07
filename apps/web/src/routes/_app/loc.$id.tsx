/**
 * A location's page (screens §5 Location, frames 02 · 1–2): what it is, "Add here" (Thing · Box /
 * container · Room or spot), the Unplaced area with Sort them, then its places and every thing in
 * it under the list standard, its Paperwork (D155, plan T23), and the settings links and Leave (D180). Personal has no Members,
 * Invite or Leave (D114). "Print inventory" (D201) sits under the location's name, with the
 * insurance report where money shows and Incidents for owners and admins (D158, T26).
 *
 * Controls follow screens §3: what the role can't do is hidden (a viewer browses only).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useLocation } from '@/api/queries';
import type { LocationDetail } from '@/api/types';
import { PeopleCount, ThingCount } from '@/components/counts';
import { SubjectPaperwork } from '@/components/documents/subject-paperwork';
import {
  AlertIcon,
  ChevronEndIcon,
  ClockIcon,
  GearIcon,
  PeopleIcon,
  PrinterIcon,
  ShieldIcon,
} from '@/components/icons';
import { KindIcon } from '@/components/kind-icon';
import { LeaveLocation } from '@/components/leave-location';
import {
  ErrorState,
  IconTile,
  List,
  LoadingRows,
  Notice,
  Page,
  Pill,
  Row,
  Section,
} from '@/components/page';
import { AddHere } from '@/components/places/add-here-sheet';
import { usePlaceTree } from '@/components/places/api';
import { ContentsList } from '@/components/places/contents-list';
import { contentsSearch } from '@/components/places/contents-search';
import { PlaceTree } from '@/components/places/tree';
import { UnplacedCard } from '@/components/places/unplaced-sort';
import { PrintInventory } from '@/components/reports/print-sheet';
import { accessOf } from '@/components/schedules/access';
import { buttonClass } from '@/components/ui/button';
import { sep, useFormat } from '@/lib/format';
import { useKindLabels, useLocationName, usePresetCopy, useRoleLabels } from '@/lib/labels';

export const Route = createFileRoute('/_app/loc/$id')({
  validateSearch: contentsSearch,
  component: LocationPage,
});

function LocationPage() {
  const { id } = Route.useParams();
  const { t } = useLingui();
  const location = useLocation(id);
  if (location.isPending)
    return (
      <Page title={t`Location`} back="/">
        <LoadingRows />
      </Page>
    );
  if (location.error)
    return (
      <Page title={t`Location`} back="/">
        <ErrorState error={location.error} onRetry={() => void location.refetch()} />
      </Page>
    );
  return <LocationBody location={location.data} />;
}

function LocationBody({ location }: { location: LocationDetail }) {
  const kinds = useKindLabels();
  const roles = useRoleLabels();
  const presets = usePresetCopy();
  const nameOf = useLocationName();
  const f = useFormat();
  const tree = usePlaceTree(location.id);
  const personal = location.kind === 'personal';
  const admin = location.role === 'owner' || location.role === 'admin';
  const canEdit = location.role !== 'viewer';
  const until = location.membershipExpiresAt ? f.day(location.membershipExpiresAt) : null;
  const preset = presets[location.preset].name;
  const name = nameOf(location);
  const places = tree.data?.places ?? [];
  const unplaced = places.find((pl) => pl.isUnplaced) ?? null;
  const access = accessOf(location);

  const link =
    'block outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info';

  return (
    <Page title={name} back="/" wide>
      <div className="flex items-start gap-3">
        <IconTile className="size-12 [&_svg]:size-6">
          <KindIcon kind={location.kind} />
        </IconTile>
        <div className="grid gap-1.5">
          <div className="text-ink-2">
            {personal ? <Trans>Only you</Trans> : kinds[location.kind]}
            {sep()}
            <ThingCount n={location.thingCount} />
            {personal ? null : (
              <>
                {sep()}
                <PeopleCount n={location.memberCount} />
              </>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Pill>{roles.you[location.role]}</Pill>
            <Pill>{preset}</Pill>
            {until ? (
              <Pill tone="warn" icon={<ClockIcon />}>
                <Trans>Your access ends {until}</Trans>
              </Pill>
            ) : null}
            {location.require2fa ? (
              <Pill icon={<ShieldIcon />}>
                <Trans>Two-factor required</Trans>
              </Pill>
            ) : null}
          </div>
          {/* D201: every role that can see the location, viewers too. */}
          <div className="flex flex-wrap items-center gap-2">
            <PrintInventory scope={{ locationId: location.id }} locationIds={[location.id]} />
            {/* D158 (T26): the insurance report where money shows; incidents for their managers. */}
            {access.money ? (
              <Link
                to="/reports/$kind"
                params={{ kind: 'insurance' }}
                search={{ loc: location.id }}
                className={buttonClass('secondary', 'small')}
              >
                <PrinterIcon className="size-4" />
                <Trans>Insurance report</Trans>
              </Link>
            ) : null}
            {access.moduleOn('warranties') && access.can('incidents.manage') ? (
              <Link
                to="/incidents"
                search={{ 'f.location': location.id }}
                className={buttonClass('secondary', 'small')}
              >
                <AlertIcon className="size-4" />
                <Trans>Incidents</Trans>
              </Link>
            ) : null}
          </div>
        </div>
      </div>

      {canEdit && unplaced ? (
        <AddHere
          locationId={location.id}
          thingTarget={{ placeId: unplaced.id }}
          placeParentId={null}
          hereName={name}
        />
      ) : null}

      {unplaced ? (
        <UnplacedCard
          unplaced={unplaced}
          locationId={location.id}
          locationName={name}
          canEdit={canEdit}
        />
      ) : null}

      <ContentsList
        parent={{
          kind: 'location',
          locationId: location.id,
          name,
          unplacedId: unplaced?.id ?? null,
        }}
        canEdit={canEdit}
      />

      <PlaceTree places={places} />

      {/* D155: the whole home's documents (the lease, the insurance), while Paperwork is on. */}
      {(location.effectiveModules ?? location.modules).includes('paperwork') ? (
        <SubjectPaperwork
          subject={{ type: 'location', locationId: location.id, name }}
          role={location.role}
        />
      ) : null}

      {admin ? (
        <Section title={<Trans>Settings</Trans>}>
          <List>
            {personal ? null : (
              <li>
                <Link
                  to="/settings/location/$id/members"
                  params={{ id: location.id }}
                  className={link}
                >
                  <Row
                    leading={
                      <IconTile>
                        <PeopleIcon />
                      </IconTile>
                    }
                    title={<Trans>Members and roles</Trans>}
                    subtitle={<Trans>Who can see this location, and what each person can do</Trans>}
                    trailing={<ChevronEndIcon className="size-5 text-ink-3" />}
                  />
                </Link>
              </li>
            )}
            <li>
              <Link to="/settings/location/$id/track" params={{ id: location.id }} className={link}>
                <Row
                  leading={
                    <IconTile>
                      <GearIcon />
                    </IconTile>
                  }
                  title={<Trans>What to track</Trans>}
                  subtitle={presets[location.preset].outcome}
                  trailing={<ChevronEndIcon className="size-5 text-ink-3" />}
                />
              </Link>
            </li>
          </List>
        </Section>
      ) : null}

      {!personal && location.role !== 'owner' ? <LeaveLocation location={location} /> : null}
      {personal ? (
        <Notice tone="info">
          <Trans>
            Personal is yours alone: it has no members, invites or share links. Move a thing into a
            shared home when it becomes shared.
          </Trans>
        </Notice>
      ) : null}
    </Page>
  );
}
