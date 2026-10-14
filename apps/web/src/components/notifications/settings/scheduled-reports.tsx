/**
 * Settings → Me → Notifications → Scheduled reports (1.3, D228): the reports Kept mails this
 * person weekly (Mondays) or monthly (the 1st), made from Print inventory's "Send it again". Each
 * says when it last went, or why it couldn't, and can be stopped. Nothing shows until there is one.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { reportKeys, reportsApi } from '@/api/inventory/reports';
import type { ReportSchedule } from '@/api/inventory/types';
import { DocumentIcon } from '@/components/icons';
import { IconTile, List, Row, Section, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';

export function ScheduledReports() {
  const { t } = useLingui();
  const f = useFormat();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const online = useOnline();
  const list = useQuery({ queryKey: reportKeys.schedules, queryFn: reportsApi.schedules });
  const schedules = list.data?.schedules ?? [];
  if (schedules.length === 0) return null;

  const why = (s: ReportSchedule) => {
    switch (s.lastError) {
      case 'rate_limited':
        return t`Skipped: you'd made five reports that hour.`;
      case 'module_off':
        return t`Skipped: that part of Kept is off in this location.`;
      default:
        return t`Skipped: you can't make this report there any more.`;
    }
  };

  const stop = async (s: ReportSchedule) => {
    const ok = await confirm({
      title: t`Stop this report?`,
      body: t`Kept stops emailing it. You can print it any time.`,
      confirmLabel: t`Stop`,
      destructive: true,
    });
    if (!ok) return;
    try {
      await reportsApi.unschedule(s.id);
      await qc.invalidateQueries({ queryKey: reportKeys.schedules });
    } catch (e) {
      toast({ title: t`Couldn't stop it`, description: errorText(e), tone: 'danger' });
    }
  };

  return (
    <Section title={<Trans>Scheduled reports</Trans>}>
      <List>
        {schedules.map((s) => {
          const name = s.locationName;
          return (
            <li key={s.id}>
              <Row
                leading={
                  <IconTile>
                    <DocumentIcon />
                  </IconTile>
                }
                title={
                  s.kind === 'inventory' ? (
                    <Trans>
                      Inventory of <bdi>{name}</bdi>
                    </Trans>
                  ) : (
                    <Trans>
                      Insurance report of <bdi>{name}</bdi>
                    </Trans>
                  )
                }
                subtitle={
                  <>
                    {s.cadence === 'weekly' ? (
                      <Trans>Every Monday</Trans>
                    ) : (
                      <Trans>On the 1st of every month</Trans>
                    )}
                    {s.lastRunOn ? (
                      <>
                        {' · '}
                        {s.lastError ? why(s) : <Trans>Last sent {f.day(s.lastRunOn)}</Trans>}
                      </>
                    ) : null}
                  </>
                }
                trailing={
                  <Button
                    size="small"
                    variant="secondary"
                    isDisabled={!online}
                    onPress={() => void stop(s)}
                  >
                    <Trans>Stop</Trans>
                  </Button>
                }
              />
            </li>
          );
        })}
      </List>
    </Section>
  );
}
