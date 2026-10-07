/**
 * One incident (D158, plan T26): what happened and when, the police and insurer references, the
 * notes and documents, the things it affected and the claims under it; then what the insurer asks
 * for: the insurance report for it and a claim pack.
 *
 * Owners and admins (`incidents.manage`) edit it, delete it (a hard delete with Undo, Q25), take
 * a thing out of it (Undo), and "Mark these stolen" (destroyed, lost, by the kind): each thing
 * still in use ends with the incident's day, one undoable `thing.lifecycle` each, as when the
 * things were added with it. Things go in from a location's list: select them, Add to incident.
 * Everyone who can see the location reads it; the insurance report shows only where money does.
 */
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Link, useNavigate } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { householdApi, useIncident } from '@/api/household/queries';
import type { Incident } from '@/api/household/types';
import { inventoryApi } from '@/api/inventory/queries';
import type { ThingRow } from '@/api/inventory/types';
import { useLocations } from '@/api/queries';
import { useClaimStatusLabels } from '@/components/claims/labels';
import { useOfferUndo } from '@/components/history/undo';
import { DocumentIcon, PencilIcon, PrinterIcon, TrashIcon } from '@/components/icons';
import {
  ErrorState,
  List,
  LoadingRows,
  Notice,
  Page,
  Pill,
  Section,
  useErrorText,
} from '@/components/page';
import { FileOpenButton } from '@/components/paperwork/rows';
import { ThingRowView } from '@/components/places/rows';
import { accessOf } from '@/components/schedules/access';
import { useRoleLabels } from '@/components/things/labels';
import { UploadButton } from '@/components/things/upload';
import { Button, buttonClass } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import { EditIncidentSheet, useInvalidateIncidents } from './incident-sheet';
import { lifecycleFor, useIncidentName, useMarkLabels } from './labels';

/** Ends each thing still in use with `lifecycle`, one undoable event each; returns their ids. */
async function endEach(
  things: ThingRow[],
  lifecycle: 'stolen' | 'destroyed' | 'lost',
  on: string,
): Promise<string[]> {
  const events: string[] = [];
  for (const thing of things) {
    // The list row has no version: read the thing for its If-Match.
    const view = await inventoryApi.thing(thing.id);
    if (view.lifecycle !== 'in_use') continue;
    const { auditEvents } = await inventoryApi.lifecycle(
      thing.id,
      { lifecycle, endedOn: on },
      view.rowVersion,
    );
    events.push(...auditEvents);
  }
  return events;
}

function Details({ incident }: { incident: Incident }) {
  const locationName = useLocationName();
  const location = useLocations().data?.find((l) => l.id === incident.locationId);
  const row = (label: ReactNode, value: ReactNode) => (
    <div className="grid gap-0.5 px-3.5 py-3 not-first:border-t not-first:border-line">
      <dt className="text-small text-ink-2">{label}</dt>
      <dd className="m-0 [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
  return (
    <dl className="m-0 overflow-hidden rounded-[10px] border border-line bg-surface">
      {location
        ? row(
            <Trans>Location</Trans>,
            <Link
              to="/loc/$id"
              params={{ id: location.id }}
              className="font-medium underline-offset-2 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-info"
            >
              <bdi>{locationName(location)}</bdi>
            </Link>,
          )
        : null}
      {incident.policeReference
        ? row(<Trans>Police reference</Trans>, <bdi dir="auto">{incident.policeReference}</bdi>)
        : null}
      {incident.insurerReference
        ? row(<Trans>Insurer's reference</Trans>, <bdi dir="auto">{incident.insurerReference}</bdi>)
        : null}
      {incident.notes
        ? row(
            <Trans>Notes</Trans>,
            <bdi dir="auto" className="whitespace-pre-line">
              {incident.notes}
            </bdi>,
          )
        : null}
      {row(<Trans>Recorded by</Trans>, <bdi>{incident.createdBy.displayName}</bdi>)}
    </dl>
  );
}

export function IncidentScreen({ id }: { id: string }) {
  const { t } = useLingui();
  const query = useIncident(id);
  const incident = query.data;
  const nameOf = useIncidentName();
  const locations = useLocations();
  const access = accessOf(locations.data?.find((l) => l.id === incident?.locationId));
  const manage = access.moduleOn('warranties') && access.can('incidents.manage');
  const title = incident ? nameOf(incident) : t`Incident`;
  return (
    <Page title={title} back="/incidents">
      {query.isPending ? (
        <LoadingRows rows={4} />
      ) : query.isError || !incident ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <IncidentBody incident={incident} manage={manage} money={access.money} />
      )}
    </Page>
  );
}

function IncidentBody({
  incident,
  manage,
  money,
}: {
  incident: Incident;
  manage: boolean;
  money: boolean;
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const online = useOnline();
  const offerUndo = useOfferUndo();
  const invalidate = useInvalidateIncidents();
  const statuses = useClaimStatusLabels();
  const marks = useMarkLabels();
  const nameOf = useIncidentName();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const name = nameOf(incident);
  const lifecycle = lifecycleFor(incident.kind);
  const inUse = incident.things.filter((th) => th.lifecycle === 'in_use');
  const thingName = (thingId: string) =>
    incident.things.find((th) => th.id === thingId)?.name ?? t`A thing`;
  const location = useLocations().data?.find((l) => l.id === incident.locationId);
  // Originals for members and above (D117); a viewer gets the display copy.
  const mayOriginal = !!location && location.role !== 'viewer';
  const roles = useRoleLabels();

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      toast({ title: errorText(err), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  const remove = (thing: ThingRow) =>
    run(`remove:${thing.id}`, async () => {
      const { auditEvents } = await householdApi.incidentThings(
        incident.id,
        { remove: [thing.id] },
        incident.rowVersion,
      );
      await invalidate();
      const what = thing.name ?? '';
      offerUndo({ title: t`Took ${what} out of ${name}` }, auditEvents, { thingId: thing.id });
    });

  const markAll = () =>
    run('mark', async () => {
      const ok = await confirm({
        title: marks[lifecycle],
        body: plural(inUse.length, {
          one: 'The thing still in use ends on the day of the incident. It leaves your counts and totals, and stays in the history.',
          other:
            'The # things still in use end on the day of the incident. They leave your counts and totals, and stay in the history.',
        }),
        confirmLabel: marks[lifecycle],
      });
      if (!ok) return;
      const events = await endEach(inUse, lifecycle, incident.occurredOn);
      await invalidate();
      offerUndo(
        { title: plural(events.length, { one: 'Ended # thing', other: 'Ended # things' }) },
        events,
      );
    });

  const remove_ = () =>
    run('delete', async () => {
      const ok = await confirm({
        title: t`Delete ${name}?`,
        body: t`The things stay as they are; only the incident and its references go. You can undo this for 7 days from the history.`,
        confirmLabel: t`Delete`,
        destructive: true,
      });
      if (!ok) return;
      const { auditEvents } = await householdApi.deleteIncident(incident.id, incident.rowVersion);
      await invalidate();
      offerUndo({ title: t`Deleted ${name}` }, auditEvents, {
        onUndone: () => void navigate({ to: '/incidents/$id', params: { id: incident.id } }),
      });
      void navigate({ to: '/incidents' });
    });

  return (
    <div className="grid gap-6">
      {manage ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="small"
            variant="secondary"
            isDisabled={!online}
            onPress={() => setEditing(true)}
          >
            <PencilIcon className="size-4" />
            <Trans>Edit</Trans>
          </Button>
          <Button
            size="small"
            variant="secondary"
            isDisabled={!online}
            isPending={busy === 'delete'}
            onPress={() => void remove_()}
          >
            <TrashIcon className="size-4" />
            <Trans>Delete</Trans>
          </Button>
          {online ? null : (
            <span className="self-center text-small text-ink-3">
              <Trans>Needs a connection</Trans>
            </span>
          )}
        </div>
      ) : null}

      <Details incident={incident} />

      {money || manage ? (
        <Section title={<Trans>For the insurer</Trans>}>
          <div className="flex flex-wrap gap-2">
            {money ? (
              <Link
                to="/reports/$kind"
                params={{ kind: 'insurance' }}
                search={{ incident: incident.id }}
                className={buttonClass('secondary', 'small')}
              >
                <PrinterIcon className="size-4" />
                <Trans>Insurance report</Trans>
              </Link>
            ) : null}
            {manage ? (
              <Link
                to="/reports/$kind"
                params={{ kind: 'claim-pack' }}
                search={{ incident: incident.id }}
                className={buttonClass('secondary', 'small')}
              >
                <DocumentIcon className="size-4" />
                <Trans>Claim pack</Trans>
              </Link>
            ) : null}
          </div>
        </Section>
      ) : null}

      <Section title={<Trans>What it affected</Trans>}>
        {incident.things.length === 0 ? (
          <Notice tone="info">
            <Trans>
              Nothing yet. In the location's list, choose Select, pick the things, then Add to
              incident.
            </Trans>
          </Notice>
        ) : (
          <div className="grid gap-3">
            {manage && inUse.length > 0 ? (
              <div>
                <Button
                  size="small"
                  isDisabled={!online}
                  isPending={busy === 'mark'}
                  onPress={() => void markAll()}
                >
                  {marks[lifecycle]}
                </Button>
              </div>
            ) : null}
            <List aria-label={t`Things in ${name}`}>
              {incident.things.map((thing) => (
                <li key={thing.id} className="flex flex-wrap items-center gap-2 pe-2">
                  <div className="min-w-0 flex-1">
                    <ThingRowView thing={thing} showPath />
                  </div>
                  {manage ? (
                    <Button
                      size="small"
                      variant="ghost"
                      isDisabled={!online}
                      isPending={busy === `remove:${thing.id}`}
                      aria-label={t`Take ${thing.name ?? ''} out of the incident`}
                      onPress={() => void remove(thing)}
                    >
                      <Trans>Take out</Trans>
                    </Button>
                  ) : null}
                </li>
              ))}
            </List>
          </div>
        )}
      </Section>

      {incident.claims.length ? (
        <Section title={<Trans>Claims</Trans>}>
          <List aria-label={t`Claims under ${name}`}>
            {incident.claims.map((c) => (
              <li key={c.id}>
                <Link
                  to="/t/$id"
                  params={{ id: c.thingId }}
                  className="flex flex-wrap items-center gap-2 px-3.5 py-3 outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info"
                >
                  <span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">
                    <bdi>{thingName(c.thingId)}</bdi>
                    {c.reference ? (
                      <span className="block text-small font-normal text-ink-2">
                        <bdi dir="auto">{c.reference}</bdi>
                      </span>
                    ) : null}
                  </span>
                  <Pill
                    tone={
                      c.status === 'rejected' ? 'danger' : c.status === 'resolved' ? 'ok' : 'warn'
                    }
                  >
                    {statuses[c.status]}
                  </Pill>
                </Link>
              </li>
            ))}
          </List>
        </Section>
      ) : null}

      {incident.documents.length || manage ? (
        <Section title={<Trans>Documents</Trans>}>
          <div className="grid gap-3">
            {incident.documents.length ? (
              <List aria-label={t`Documents for ${name}`}>
                {incident.documents.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
                    <DocumentIcon className="size-5 shrink-0 text-ink-2" />
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{roles[d.role]}</span>
                    <FileOpenButton attachment={d} original={mayOriginal} what={name} />
                  </li>
                ))}
              </List>
            ) : null}
            {manage && online ? (
              <UploadButton
                locationId={incident.locationId}
                subject={{ incidentId: incident.id }}
                attachAs="document"
                label={t`Add a document`}
                accept={['application/pdf', 'image/*']}
                onUploaded={() => void invalidate()}
              />
            ) : null}
          </div>
        </Section>
      ) : null}

      {editing ? <EditIncidentSheet incident={incident} onClose={() => setEditing(false)} /> : null}
    </div>
  );
}
