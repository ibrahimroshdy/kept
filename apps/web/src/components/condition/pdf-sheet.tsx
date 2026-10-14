/**
 * A condition report's PDF (1.x, D235): this report, or this one beside the report it is
 * compared with, room by room, for a landlord, an agent or a deposit dispute. Made on the server
 * (`POST /reports/condition`, the `condition` run kind) and followed with the reports' progress to
 * Open PDF, Share and Download (components/reports/progress.tsx). Anyone who can see the report
 * may make one, viewers too; a draft prints marked as not finished.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { isApiError } from '@/api/client';
import { conditionApi } from '@/api/condition/queries';
import type { ConditionPdfBody, ConditionReport } from '@/api/condition/types';
import { Notice, useErrorText } from '@/components/page';
import { ReportProgress, reportFilenameOf } from '@/components/reports/progress';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { useOnline } from '@/lib/online';
import { usePrefs } from '@/lib/prefs';

const filename = reportFilenameOf('condition-report');

export function ConditionPdfSheet({
  isOpen,
  onClose,
  report,
  compareWith,
}: {
  isOpen: boolean;
  onClose: () => void;
  report: ConditionReport;
  compareWith?: string | undefined;
}) {
  const { t } = useLingui();
  return (
    <Sheet isOpen={isOpen} onOpenChange={(o) => !o && onClose()} title={t`Condition report PDF`}>
      {isOpen ? <PdfForm onClose={onClose} report={report} compareWith={compareWith} /> : null}
    </Sheet>
  );
}

function PdfForm({
  onClose,
  report,
  compareWith,
}: {
  onClose: () => void;
  report: ConditionReport;
  compareWith?: string | undefined;
}) {
  const { t } = useLingui();
  const prefs = usePrefs();
  const online = useOnline();
  const errorText = useErrorText();
  const [photos, setPhotos] = useState(true);
  const [locale, setLocale] = useState<'en' | 'ar'>(prefs.locale === 'ar' ? 'ar' : 'en');
  const [runId, setRunId] = useState<string | null>(null);
  const body = (): ConditionPdfBody => ({
    reportId: report.id,
    ...(compareWith ? { compareWith } : {}),
    include: { photos },
    locale,
    digits: locale === 'ar' ? prefs.digits : 'western',
  });
  const start = useMutation({
    mutationFn: (b: ConditionPdfBody) => conditionApi.pdf(b),
    onSuccess: ({ id }) => setRunId(id),
  });
  const startError = (e: unknown) =>
    isApiError(e) && e.code === 'rate_limited'
      ? t`Kept makes at most five reports an hour. Try again later.`
      : errorText(e);

  if (runId)
    return (
      <div className="grid gap-4">
        <ReportProgress
          key={runId}
          runId={runId}
          filename={filename}
          onRetry={() => {
            setRunId(null);
            start.mutate(body());
          }}
        />
        {start.error ? <Notice tone="danger">{startError(start.error)}</Notice> : null}
        <DialogFooter>
          <Button variant="secondary" onPress={onClose}>
            <Trans>Close</Trans>
          </Button>
        </DialogFooter>
      </div>
    );

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        start.mutate(body());
      }}
    >
      <p className="m-0 text-small text-ink-2">
        {compareWith ? (
          <Trans>
            Both walk-throughs room by room, the earlier one first: each room's condition, note and
            photos, with the time Kept received each photo.
          </Trans>
        ) : (
          <Trans>
            Each room's condition, note and photos, with the time Kept received each photo.
          </Trans>
        )}
      </p>
      {report.finishedAt ? null : (
        <Notice tone="warn">
          <Trans>This report isn't finished, and the PDF says so.</Trans>
        </Notice>
      )}
      <Switch isSelected={photos} onChange={setPhotos}>
        <Trans>Photos</Trans>
      </Switch>
      <Segmented<'en' | 'ar'>
        label={t`Language`}
        value={locale}
        onChange={setLocale}
        options={[
          { id: 'en', label: 'English' },
          { id: 'ar', label: <span lang="ar">العربية</span> },
        ]}
      />
      {start.error ? <Notice tone="danger">{startError(start.error)}</Notice> : null}
      {online ? null : (
        <p className="m-0 text-small text-ink-2">
          <Trans>Needs a connection</Trans>
        </p>
      )}
      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={start.isPending} isDisabled={!online}>
          <Trans>Make the PDF</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}
