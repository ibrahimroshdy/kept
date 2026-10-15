/**
 * What reaches you, and how (plan T25; D29, D113, D227, D232; 1.5.x D239): one table for every
 * location. Rows are the kinds, grouped (due dates, lending, stock, people, AI); columns are the
 * channels you have: In Kept (the notification centre; off silences the kind entirely, Q10),
 * Email, Push, and one column per kind of channel you added (webhook, ntfy, Telegram, Apprise:
 * every channel of that kind follows its column). A notice (membership, AI caps, the AI monthly
 * summary) only lands in Kept and goes by email, so its other cells are empty.
 *
 * Above the table, the location picker: **All locations** edits your choices for every location,
 * those you add later too; one location shows what it gets, dots the cells set for it alone (they
 * differ from all locations) and offers "Reset this location to all locations". There, a kind
 * whose module is off is shown paused (D113), a viewer sees only Membership (Q8), and the AI
 * summary says it's account-wide. A change stores only what differs from the layer below.
 *
 * On a phone each kind is a row with its channels as labelled switches beneath it, never a wide
 * grid: nothing scrolls sideways and nothing is cut off.
 */
import {
  kindChannels,
  type ModuleId,
  NOTIFY_KINDS,
  type NotifyKind,
  type PreferenceChannel,
  type Role,
  SOURCE_MODULE,
  type SourceType,
  sourceModuleOn,
} from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { householdApi, householdKeys } from '@/api/household/queries';
import type { Channel, KindPreference, NotificationSettings } from '@/api/household/types';
import { useLocations } from '@/api/queries';
import { useErrorText } from '@/components/page';
import { accessOf } from '@/components/schedules/access';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { useLocationName, useModuleLabels } from '@/lib/labels';
import { useMediaQuery, WIDE } from '@/lib/media';
import { useOnline } from '@/lib/online';
import { cn } from '@/lib/utils';

export function useNotifyKindLabels(): Record<NotifyKind, string> {
  const { t } = useLingui();
  return {
    schedule: t`Schedules due`,
    warranty: t`Warranties running out`,
    registration: t`Warranty registration deadlines`,
    document: t`Documents running out`,
    loan: t`Overdue loans`,
    thing_expiry: t`Things that expire`,
    reading_stale: t`Meters not read lately`,
    stock: t`Low stock`,
    membership: t`Members joining and leaving`,
    ai_cap: t`AI spending caps`,
    ai_summary: t`AI monthly summary`,
  };
}

export function useChannelLabels(): Record<PreferenceChannel, string> {
  const { t } = useLingui();
  return {
    inapp: t`In Kept`,
    email: t`Email`,
    webpush: t`Push`,
    webhook: t`Webhook`,
    ntfy: 'ntfy',
    telegram: 'Telegram',
    apprise: 'Apprise',
  };
}

/** The table's groups, in order (D239). */
export const KIND_GROUPS: ReadonlyArray<{ id: string; kinds: readonly NotifyKind[] }> = [
  {
    id: 'due',
    kinds: ['schedule', 'warranty', 'registration', 'document', 'thing_expiry', 'reading_stale'],
  },
  { id: 'lending', kinds: ['loan'] },
  { id: 'stock', kinds: ['stock'] },
  { id: 'people', kinds: ['membership'] },
  { id: 'ai', kinds: ['ai_cap', 'ai_summary'] },
];

/** The columns: In Kept, Email and Push always; each added kind of channel once you have one. */
export function columnsFor(channels: readonly Channel[]): PreferenceChannel[] {
  const has = (kind: Channel['kind']) => channels.some((c) => c.kind === kind);
  return [
    'inapp',
    'email',
    'webpush',
    ...(['webhook', 'ntfy', 'telegram', 'apprise'] as const).filter((k) => has(k)),
  ];
}

const ALL = 'all';

type Row = {
  kind: NotifyKind;
  /** Null: shown paused, with `reason` instead of switches. */
  pref: KindPreference | null;
  reason: ReactNode;
};

export function KindsByLocation({ settings }: { settings: NotificationSettings }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const locations = useLocations();
  const nameOf = useLocationName();
  const moduleLabels = useModuleLabels();
  const kindLabels = useNotifyKindLabels();
  const channelLabels = useChannelLabels();
  const errorText = useErrorText();
  const online = useOnline();
  const wide = useMediaQuery(WIDE);
  const [scope, setScope] = useState<string>(ALL);
  const [busy, setBusy] = useState(false);

  const located = settings.locations.map((loc) => {
    const detail = (locations.data ?? []).find((l) => l.id === loc.locationId);
    return { ...loc, detail, label: detail ? nameOf(detail) : loc.name };
  });
  const current = located.find((l) => l.locationId === scope) ?? null;
  const where = current ? current.label : t`all locations`;

  const columns = columnsFor(settings.channels);
  const header = (c: PreferenceChannel) => {
    const n = settings.channels.filter((x) => x.kind === c).length;
    const how = channelLabels[c];
    return c !== 'email' && c !== 'webpush' && n > 1 ? t`${how} (${n})` : how;
  };

  const rowFor = (kind: NotifyKind): Row => {
    if (!current) return { kind, pref: settings.account.kinds?.[kind] ?? null, reason: null };
    if (kind === 'ai_summary') {
      const reason = <Trans>For your whole account: set it under All locations.</Trans>;
      return { kind, pref: null, reason };
    }
    const pref = current.kinds[kind];
    if (!pref) {
      const reason =
        current.role === 'viewer' ? (
          <Trans>Viewers hear only about members.</Trans>
        ) : (
          <Trans>Not sent here.</Trans>
        );
      return { kind, pref: null, reason };
    }
    const module = moduleOf(kind);
    if (current.detail && module) {
      const access = accessOf(current.detail);
      // A vehicle's documents still remind while Vehicles is on (sourceModuleOn).
      if (!sourceModuleOn(kind as SourceType, access.moduleOn, { vehicle: true })) {
        const name = moduleLabels[module];
        return { kind, pref: null, reason: <Trans>Paused: {name} is off here.</Trans> };
      }
    }
    return { kind, pref, reason: null };
  };
  const rows: Row[] = NOTIFY_KINDS.map(rowFor);
  const anySet = current ? rows.some((r) => (r.pref?.set ?? []).length > 0) : false;

  const save = async (kind: NotifyKind, channel: PreferenceChannel, enabled: boolean) => {
    try {
      const next = await householdApi.putPreferences({
        items: [{ locationId: current?.locationId ?? null, kind, channel, enabled }],
      });
      qc.setQueryData(householdKeys.notificationSettings, next);
    } catch (e) {
      toast({ title: t`Couldn't save that`, description: errorText(e), tone: 'danger' });
    }
  };

  const reset = async () => {
    if (!current) return;
    setBusy(true);
    try {
      const next = await householdApi.resetLocationPreferences(current.locationId);
      qc.setQueryData(householdKeys.notificationSettings, next);
      toast({ title: t`${where} follows all locations again`, tone: 'ok' });
    } catch (e) {
      toast({ title: t`Couldn't save that`, description: errorText(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  /** One switch, or null where the kind doesn't go that way. */
  const cell = (row: Row, c: PreferenceChannel, labelled: boolean) => {
    const pref = row.pref as KindPreference;
    if (!kindChannels(row.kind).includes(c)) return null;
    const what = kindLabels[row.kind];
    const how = header(c);
    const here = current !== null && (pref.set ?? []).includes(c);
    // In Kept off silences the kind entirely (Q10): the others wait for it.
    const silenced = c !== 'inapp' && !pref.inapp;
    const label = here
      ? t`${what} by ${how} in ${where}, set for this location only`
      : t`${what} by ${how} in ${where}`;
    return (
      <span className="inline-flex items-center gap-1.5">
        <Switch
          aria-label={label}
          isSelected={pref[c] ?? false}
          isDisabled={!online || silenced}
          onChange={(on) => void save(row.kind, c, on)}
          className={labelled ? 'min-w-0' : 'justify-center gap-0'}
        >
          {labelled ? <span className="[overflow-wrap:anywhere]">{how}</span> : null}
        </Switch>
        <SetDot on={here} />
      </span>
    );
  };

  const kindHead = (row: Row) => (
    <>
      <span className="[overflow-wrap:anywhere]">{kindLabels[row.kind]}</span>
      {row.reason ? (
        <span className="block text-[12px] text-ink-3">{row.reason}</span>
      ) : row.pref && !row.pref.inapp ? (
        <span className="block text-[12px] text-ink-3">
          <Trans>In Kept is off, so nothing is sent.</Trans>
        </span>
      ) : row.kind === 'ai_summary' ? (
        <span className="block text-[12px] text-ink-3">
          <Trans>Once a month: what AI did for you and what it used.</Trans>
        </span>
      ) : null}
    </>
  );

  const groupLabels: Record<string, string> = {
    due: t`Due dates`,
    lending: t`Lending`,
    stock: t`Stock`,
    people: t`People`,
    ai: t`AI`,
  };
  const groups = KIND_GROUPS.map((g) => ({
    ...g,
    label: groupLabels[g.id] ?? g.id,
    rows: g.kinds.flatMap((k) => rows.filter((r) => r.kind === k)),
  }));

  const options = [
    { id: ALL, label: t`All locations` },
    ...located.map((l) => ({ id: l.locationId, label: l.label })),
  ];

  return (
    <div className="grid gap-3 rounded-[10px] border border-line bg-surface p-3.5">
      {options.length <= 4 ? (
        <Segmented
          label={t`Where`}
          value={scope}
          onChange={setScope}
          options={options.map((o) => ({ id: o.id, label: <bdi>{o.label}</bdi> }))}
        />
      ) : (
        <Combobox
          label={t`Where`}
          items={options}
          selectedKey={scope}
          onSelectionChange={(k) => {
            if (k !== null) setScope(String(k));
          }}
        />
      )}
      <ScopeNote role={current?.role ?? null} />
      {current ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="m-0 flex items-center gap-1.5 text-small text-ink-2">
            <SetDot on />
            <Trans>Set for this location only</Trans>
          </p>
          <Button
            variant="secondary"
            size="small"
            isDisabled={!online || !anySet}
            isPending={busy}
            onPress={() => void reset()}
          >
            <Trans>Reset this location to all locations</Trans>
          </Button>
        </div>
      ) : null}

      {wide ? (
        <table className="w-full border-collapse text-small">
          <thead>
            <tr>
              <th scope="col" className="py-1.5 text-start font-normal text-ink-3">
                <Trans>What</Trans>
              </th>
              {columns.map((c) => (
                <th
                  key={c}
                  scope="col"
                  className="w-16 px-1 py-1.5 text-center font-normal text-[12px] text-ink-3 leading-tight [overflow-wrap:anywhere]"
                >
                  {header(c)}
                </th>
              ))}
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.id}>
              <tr>
                <th
                  scope="colgroup"
                  colSpan={columns.length + 1}
                  className="eyebrow pt-3 pb-1 text-start"
                >
                  {g.label}
                </th>
              </tr>
              {g.rows.map((row) => (
                <tr key={row.kind} className="border-t border-line">
                  <th scope="row" className="py-1.5 pe-2 text-start font-normal text-ink">
                    {kindHead(row)}
                  </th>
                  {columns.map((c) => (
                    <td key={c} className="px-1 text-center">
                      {row.pref ? (cell(row, c, false) ?? <NotThisWay />) : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      ) : (
        <div className="grid gap-3">
          {groups.map((g) => (
            <section key={g.id} aria-label={g.label} className="grid gap-1">
              <h3 className="eyebrow m-0">{g.label}</h3>
              <ul className="m-0 grid list-none p-0 [&>li+li]:border-t [&>li+li]:border-line">
                {g.rows.map((row) => (
                  <li key={row.kind} className="grid gap-1 py-2">
                    <div className="text-[15px] text-ink">{kindHead(row)}</div>
                    {row.pref ? (
                      <div className="grid grid-cols-2 gap-x-3">
                        {columns.map((c) => {
                          const sw = cell(row, c, true);
                          return sw ? <div key={c}>{sw}</div> : null;
                        })}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <p className="m-0 text-small">
        <a href="#channels" className="text-info underline-offset-2 hover:underline">
          <Trans>Add more channels</Trans>
        </a>
      </p>
    </div>
  );
}

/** What the picker's choice means, in a line. */
function ScopeNote({ role }: { role: Role | null }) {
  const text =
    role === null ? (
      <Trans>
        Applies to every location, ones you add later too. Pick a location to change it there only.
      </Trans>
    ) : role === 'member' ? (
      <Trans>You're a member here: Kept starts with only the loans you record.</Trans>
    ) : role === 'viewer' ? (
      <Trans>You're a viewer here: only members joining and leaving.</Trans>
    ) : null;
  return text ? <p className="m-0 text-small text-ink-2 [text-wrap:pretty]">{text}</p> : null;
}

/** An empty cell: the kind doesn't go this way. */
function NotThisWay() {
  return (
    <span className="text-ink-3">
      <span aria-hidden="true">—</span>
      <span className="sr-only">
        <Trans>Not sent this way</Trans>
      </span>
    </span>
  );
}

/** The mark of a cell set for one location only. */
function SetDot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        on ? 'bg-info' : 'bg-transparent',
      )}
    />
  );
}

/** The module a kind belongs to, if any: off in a location, the kind pauses there. */
const moduleOf = (kind: NotifyKind): ModuleId | null =>
  kind in SOURCE_MODULE ? SOURCE_MODULE[kind as SourceType] : null;
