/**
 * What each location tells you, and how (plan T25; D29, step-4 Q8, Q10): a table of kinds ×
 * channels, one card per location. Channels are the columns: In Kept (the notification centre;
 * off silences the kind entirely, Q10), Email, Push (every device with push on) and, when you
 * have one, Webhook. A row still on Kept's default says so; a change stores only what differs
 * (the server deletes a value equal to the default).
 *
 * Kinds whose module is off in the location are left out: their reminders pause (D113). A
 * viewer's locations list only Membership (Q8), as the server sends them.
 */
import {
  type ModuleId,
  NOTIFY_KINDS,
  type NotifyKind,
  type PreferenceChannel,
  SOURCE_MODULE,
  type SourceType,
} from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { householdApi, householdKeys } from '@/api/household/queries';
import type { KindPreference, NotificationSettings } from '@/api/household/types';
import { useLocations } from '@/api/queries';
import { useErrorText } from '@/components/page';
import { accessOf } from '@/components/schedules/access';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';

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
  return { inapp: t`In Kept`, email: t`Email`, webpush: t`Push`, webhook: t`Webhook` };
}

/** The module a kind belongs to, if any: off in a location, the kind pauses there. */
const moduleOf = (kind: NotifyKind): ModuleId | null =>
  kind in SOURCE_MODULE ? SOURCE_MODULE[kind as SourceType] : null;

export function KindsByLocation({ settings }: { settings: NotificationSettings }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const locations = useLocations();
  const nameOf = useLocationName();
  const kindLabels = useNotifyKindLabels();
  const channelLabels = useChannelLabels();
  const errorText = useErrorText();
  const online = useOnline();
  const hasWebhook = settings.channels.some((c) => c.kind === 'webhook');
  const channels: PreferenceChannel[] = [
    'inapp',
    'email',
    'webpush',
    ...(hasWebhook ? (['webhook'] as const) : []),
  ];

  const set = async (
    locationId: string,
    kind: NotifyKind,
    channel: PreferenceChannel,
    enabled: boolean,
  ) => {
    try {
      const next = await householdApi.putPreferences({
        items: [{ locationId, kind, channel, enabled }],
      });
      qc.setQueryData(householdKeys.notificationSettings, next);
    } catch (e) {
      toast({ title: t`Couldn't save that`, description: errorText(e), tone: 'danger' });
    }
  };

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {settings.locations.map((loc) => {
        const detail = (locations.data ?? []).find((l) => l.id === loc.locationId);
        const access = accessOf(detail);
        const name = detail ? nameOf(detail) : loc.name;
        const kinds = NOTIFY_KINDS.filter((k) => {
          if (!loc.kinds[k]) return false;
          const m = moduleOf(k);
          return !detail || m === null || access.moduleOn(m);
        });
        return (
          <section
            key={loc.locationId}
            aria-label={name}
            className="grid min-w-0 content-start gap-2 rounded-[10px] border border-line bg-surface p-3.5"
          >
            <h3 className="m-0 font-semibold text-[15px] [overflow-wrap:anywhere]">
              <bdi>{name}</bdi>
            </h3>
            <table className="w-full border-collapse text-small">
              <thead>
                <tr>
                  <th scope="col" className="py-1.5 text-start font-normal text-ink-3">
                    <Trans>What</Trans>
                  </th>
                  {channels.map((c) => (
                    <th
                      key={c}
                      scope="col"
                      className="w-12 px-0.5 py-1.5 text-center font-normal text-[12px] text-ink-3 leading-tight"
                    >
                      {channelLabels[c]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {kinds.map((kind) => {
                  const pref = loc.kinds[kind] as KindPreference;
                  const what = kindLabels[kind];
                  return (
                    <tr key={kind} className="border-t border-line">
                      <th scope="row" className="py-1 pe-2 text-start font-normal text-ink">
                        <span className="[overflow-wrap:anywhere]">{what}</span>
                        {pref.isDefault ? (
                          <span className="block text-[12px] text-ink-3">
                            <Trans>Default</Trans>
                          </span>
                        ) : null}
                      </th>
                      {channels.map((c) => {
                        const how = channelLabels[c];
                        return (
                          <td key={c} className="px-0.5 text-center">
                            <Switch
                              aria-label={t`${what} by ${how} in ${name}`}
                              isSelected={pref[c]}
                              isDisabled={!online}
                              onChange={(on) => void set(loc.locationId, kind, c, on)}
                              className="justify-center gap-0"
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      })}
    </div>
  );
}
