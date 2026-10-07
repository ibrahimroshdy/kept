/**
 * The vehicle history report sheet (plan T23; D51, D201; Q16): "History report" from the vehicle's
 * action menu and its Overview. The sheet asks for the period (all of it, or from and to), what
 * to include (costs, proof photos, fuel, documents) and the language, then makes the PDF on the
 * server (`POST /reports/vehicle-history`, the `vehicle_history` run kind) and follows it with
 * step 2's progress to Open PDF, Share and Download (components/reports/progress.tsx: the
 * installed iPhone app gets Open and Share, never a dead download).
 *
 * Anyone who can see the vehicle may make one, viewers too; costs are in it only where the reader
 * sees money, and the sheet says so. Offline the button is off and says "Needs a connection"
 * (screens §3).
 *
 * Mounted by the vehicle page inside its ThingProvider.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { isApiError } from '@/api/client';
import { vehiclesApi } from '@/api/vehicles/queries';
import type { VehicleHistoryReportBody } from '@/api/vehicles/types';
import { DocumentIcon } from '@/components/icons';
import { Notice, useErrorText } from '@/components/page';
import { ReportProgress, reportFilenameOf } from '@/components/reports/progress';
import { accessOf } from '@/components/schedules/access';
import { useThingCtx } from '@/components/things/context';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { DialogFooter } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { useOnline } from '@/lib/online';
import { usePrefs } from '@/lib/prefs';

/** The shared PDF's name (inferred: the server's `filenameOf` names only the inventory and
 * insurance kinds so far; T15 decides the vehicle one). */
const historyFilename = reportFilenameOf('vehicle-history');

export function VehicleReportSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useLingui();
  return (
    <Sheet isOpen={open} onOpenChange={(o) => !o && onClose()} title={t`History report`}>
      {open ? <ReportForm onClose={onClose} /> : null}
    </Sheet>
  );
}

/** "History report" as a button with its sheet (the Overview's), off offline with the reason. */
export function HistoryReportButton() {
  const online = useOnline();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button variant="secondary" size="small" isDisabled={!online} onPress={() => setOpen(true)}>
        <DocumentIcon className="size-4" />
        <Trans>History report</Trans>
      </Button>
      {online ? null : (
        <span className="text-small text-ink-3">
          <Trans>Needs a connection</Trans>
        </span>
      )}
      <VehicleReportSheet open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

type Period = 'all' | 'range';

function ReportForm({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const { thing, location, moduleOn } = useThingCtx();
  const access = accessOf(location);
  const prefs = usePrefs();
  const online = useOnline();
  const errorText = useErrorText();
  const fuelOn = moduleOn('fuel');
  const [period, setPeriod] = useState<Period>('all');
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(access.today);
  const [costs, setCosts] = useState(true);
  const [photos, setPhotos] = useState(true);
  const [fuel, setFuel] = useState(fuelOn);
  const [documents, setDocuments] = useState(true);
  const [locale, setLocale] = useState<'en' | 'ar'>(prefs.locale === 'ar' ? 'ar' : 'en');
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  const body = (): VehicleHistoryReportBody => ({
    thingId: thing.id,
    ...(period === 'range' && from ? { from } : {}),
    ...(period === 'range' && to ? { to } : {}),
    include: {
      costs: costs && access.money,
      proofPhotos: photos,
      fuel: fuel && fuelOn,
      documents,
    },
    locale,
    digits: locale === 'ar' ? prefs.digits : 'western',
  });
  const start = useMutation({
    mutationFn: (b: VehicleHistoryReportBody) => vehiclesApi.vehicleHistoryReport(b),
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
          filename={historyFilename}
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
        if (period === 'range' && from && to && from > to) {
          setError(t`The start has to be on or before the end.`);
          return;
        }
        setError(null);
        start.mutate(body());
      }}
    >
      <p className="m-0 text-small text-ink-2">
        <Trans>
          A PDF of <bdi className="font-medium text-ink">{thing.name}</bdi>'s history: the odometer
          readings with their photos, every service with its lines and invoices, the fuel summary
          and the documents.
        </Trans>
      </p>
      <Segmented<Period>
        label={t`Period`}
        value={period}
        onChange={setPeriod}
        options={[
          { id: 'all', label: t`All of it` },
          { id: 'range', label: t`From and to` },
        ]}
      />
      {period === 'range' ? (
        <div className="flex flex-wrap gap-3">
          <DatePicker
            label={t`From`}
            value={from}
            maxValue={to ?? access.today}
            onChange={(v) => {
              setFrom(v);
              setError(null);
            }}
          />
          <DatePicker
            label={t`To`}
            value={to}
            maxValue={access.today}
            onChange={(v) => {
              setTo(v);
              setError(null);
            }}
            {...(error ? { errorMessage: error } : {})}
          />
        </div>
      ) : null}
      <fieldset className="m-0 grid border-0 p-0">
        <legend className="mb-1 p-0 font-medium text-[14px] text-ink">
          <Trans>Include</Trans>
        </legend>
        <Switch isSelected={costs && access.money} isDisabled={!access.money} onChange={setCosts}>
          <Trans>Costs</Trans>
        </Switch>
        <Switch isSelected={photos} onChange={setPhotos}>
          <Trans>Proof photos</Trans>
        </Switch>
        {fuelOn ? (
          <Switch isSelected={fuel} onChange={setFuel}>
            <Trans>Fuel</Trans>
          </Switch>
        ) : null}
        <Switch isSelected={documents} onChange={setDocuments}>
          <Trans>Documents</Trans>
        </Switch>
        <p className="m-0 text-small text-ink-2">
          {access.money ? (
            <Trans>Costs appear only for readers who can see money.</Trans>
          ) : (
            <Trans>
              Costs appear only if you can see money. You can't in this location, so this one has
              none.
            </Trans>
          )}
        </p>
      </fieldset>
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
