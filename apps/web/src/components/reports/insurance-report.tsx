/**
 * The insurance report (D158, D201, engineering spec §2.8; plan T26, `/reports/insurance`): every
 * thing in a location, or in one incident, with its photo, brand, model, serial, purchase date
 * and price, current value and receipts, and totals per place and per currency, as a PDF made on
 * the server (the step-2 engine), and the same rows as a CSV.
 *
 * - **Scope:** a location where you see money, or the incident in the URL (`?incident=`).
 * - **As of** (Q20): which valuation counts (the latest on or before it); the report lists things
 *   as they are now.
 * - **Also total in** (Q21): a converted total beside the per-currency ones, only when your
 *   exchange rates cover every pair; otherwise the server refuses with the missing pairs, listed
 *   here with a link to add them. Never estimated (D76).
 * - Then the run's progress and the finished PDF as Open PDF, Share and Download (./progress.tsx:
 *   the installed iPhone app gets Open and Share, never a dead download). `?run=` resumes a run
 *   (the "ready" notification's link).
 * - **CSV:** fetched with the same scope and date, then saved, or, on the installed iPhone app,
 *   offered on the share sheet with a second press (iOS refuses a share that waited on the
 *   network), as AI usage's Export CSV does.
 *
 * Online only: offline the buttons are off and say why (screens §3).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { ApiError, isApiError } from '@/api/client';
import { householdApi, useIncident } from '@/api/household/queries';
import type { InsuranceReportBody, RateMissing } from '@/api/household/types';
import { useLocations } from '@/api/queries';
import { DocumentIcon, PrinterIcon, ShareIcon } from '@/components/icons';
import { useIncidentName } from '@/components/incidents/labels';
import { EmptyState, LoadingRows, Notice, Page, useErrorText } from '@/components/page';
import { accessOf } from '@/components/schedules/access';
import { CurrencyPicker } from '@/components/things/pickers';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Select, SelectItem } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { canShareFiles, downloadsWork, saveFile, shareFiles } from '@/lib/files';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import { usePrefs } from '@/lib/prefs';
import { ReportProgress, reportFilenameOf } from './progress';

export type ReportSearch = { loc?: string; incident?: string; things?: string; run?: string };

const insuranceName = reportFilenameOf('insurance');

/** The CSV, fetched with the session like any API read, as a file to save or share. */
async function fetchCsv(url: string, asOf: string): Promise<File> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include', headers: { accept: 'text/csv' } });
  } catch {
    throw new ApiError(0, 'offline', 'Needs a connection');
  }
  if (!res.ok)
    throw new ApiError(
      res.status,
      res.status === 429 ? 'rate_limited' : res.status === 404 ? 'not_found' : 'internal',
      res.statusText,
    );
  return new File([await res.blob()], `kept-insurance-${asOf}.csv`, { type: 'text/csv' });
}

/** "USD → EGP, CAD → EGP": the pairs a converted total still needs. */
function MissingRates({
  missing,
  accountId,
}: {
  missing: RateMissing['missing'];
  accountId?: string;
}) {
  const { t } = useLingui();
  return (
    <Notice tone="warn" title={t`A rate is missing, so there's no converted total`}>
      <div className="grid gap-2">
        <ul aria-label={t`Missing rates`} className="m-0 grid list-none gap-1 p-0">
          {missing.map((m) => (
            <li key={`${m.from}-${m.to}`} dir="ltr" className="font-mono text-[14px]">
              {m.from} → {m.to}
            </li>
          ))}
        </ul>
        <p className="m-0">
          <Trans>
            Kept converts only with a rate you entered, never an estimate. Add one dated on or
            before the report's day, or make the report without a converted total.
          </Trans>
        </p>
        {accountId ? (
          <Link
            to="/settings/account/exchange-rates"
            search={{ account: accountId }}
            className="font-medium underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-info"
          >
            <Trans>Add exchange rates</Trans>
          </Link>
        ) : null}
      </div>
    </Notice>
  );
}

export function InsuranceReportScreen({ search }: { search: ReportSearch }) {
  const { t } = useLingui();
  const locations = useLocations();
  const incident = useIncident(search.incident ?? '');
  const nameIncident = useIncidentName();
  const all = locations.data ?? [];
  const withMoney = all.filter((l) => accessOf(l).money);

  if (locations.isPending || (search.incident && incident.isPending))
    return (
      <Page title={t`Insurance report`}>
        <LoadingRows rows={3} />
      </Page>
    );
  const scopeLocation = search.incident
    ? all.find((l) => l.id === incident.data?.locationId)
    : undefined;
  if (search.incident && (!incident.data || !scopeLocation || !accessOf(scopeLocation).money))
    return (
      <Page title={t`Insurance report`} back="/incidents">
        <EmptyState icon={<PrinterIcon />} title={<Trans>No report for this incident</Trans>}>
          <Trans>
            The insurance report needs Money on in its location, and a role that sees prices.
          </Trans>
        </EmptyState>
      </Page>
    );
  if (!search.incident && withMoney.length === 0)
    return (
      <Page title={t`Insurance report`}>
        <EmptyState icon={<PrinterIcon />} title={<Trans>No location to report on</Trans>}>
          <Trans>
            The insurance report needs Money on in a location, and a role that sees prices there.
          </Trans>
        </EmptyState>
      </Page>
    );
  return (
    <Page
      title={t`Insurance report`}
      {...(incident.data
        ? { back: { to: '/incidents/$id', params: { id: incident.data.id } } }
        : {})}
    >
      <InsuranceForm
        key={search.incident ?? 'locations'}
        search={search}
        incidentId={incident.data?.id}
        incidentName={incident.data ? nameIncident(incident.data) : undefined}
        locationIds={
          incident.data && scopeLocation ? [scopeLocation.id] : withMoney.map((l) => l.id)
        }
      />
    </Page>
  );
}

function InsuranceForm({
  search,
  incidentId,
  incidentName,
  locationIds,
}: {
  search: ReportSearch;
  incidentId: string | undefined;
  incidentName: string | undefined;
  locationIds: string[];
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const online = useOnline();
  const prefs = usePrefs();
  const locationName = useLocationName();
  const all = useLocations().data ?? [];
  const [locationId, setLocationId] = useState(
    search.loc && locationIds.includes(search.loc) ? search.loc : (locationIds[0] ?? ''),
  );
  const location = all.find((l) => l.id === locationId);
  const today = accessOf(location).today;
  const [asOf, setAsOf] = useState<string | null>(today);
  const [currency, setCurrency] = useState<string | null>(null);
  const [photos, setPhotos] = useState(true);
  const [runId, setRunId] = useState<string | null>(search.run ?? null);
  const [missing, setMissing] = useState<RateMissing['missing'] | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [csvBusy, setCsvBusy] = useState(false);
  const [csv, setCsv] = useState<File | null>(null);
  const day = asOf ?? today;
  const scope: InsuranceReportBody['scope'] = incidentId ? { incidentId } : { locationId };

  const start = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setFailed(null);
    setMissing(null);
    try {
      const run = await householdApi.insuranceReport({
        scope,
        asOf: day,
        ...(currency ? { reportCurrency: currency } : {}),
        include: { photos },
        locale: prefs.locale,
        digits: prefs.digits,
      });
      setRunId(run.id);
    } catch (err) {
      const m = isApiError(err) ? (err.details as Partial<RateMissing>).missing : undefined;
      if (isApiError(err) && err.code === 'rate_missing' && Array.isArray(m)) setMissing(m);
      else setFailed(err);
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = async () => {
    setCsvBusy(true);
    try {
      const file = await fetchCsv(
        householdApi.insuranceCsvUrl({
          ...(incidentId ? { incidentId } : { locationId }),
          asOf: day,
        }),
        day,
      );
      if (downloadsWork()) saveFile(file);
      else setCsv(file);
    } catch (err) {
      toast({ tone: 'danger', title: errorText(err) });
    } finally {
      setCsvBusy(false);
    }
  };
  const shareCsv = async (file: File) => {
    const how = await shareFiles([file]);
    if (how === 'shared') setCsv(null);
    if (how === 'refused') toast({ tone: 'danger', title: t`Couldn't share the CSV. Try again.` });
  };
  const startError = (err: unknown) =>
    isApiError(err) && err.code === 'rate_limited'
      ? t`Kept makes at most five reports an hour. Try again later.`
      : errorText(err);

  if (runId)
    return (
      <div className="grid gap-4">
        <ReportProgress
          key={runId}
          runId={runId}
          filename={insuranceName}
          onRetry={() => {
            setRunId(null);
            void start();
          }}
        />
        <div>
          <Button variant="secondary" size="small" onPress={() => setRunId(null)}>
            <Trans>Make another</Trans>
          </Button>
        </div>
      </div>
    );

  return (
    <form onSubmit={(e) => void start(e)} noValidate className="grid gap-4">
      <p className="m-0 text-ink-2">
        <Trans>
          A PDF for your insurer: each thing with its photo, brand, model, serial, purchase date and
          price, current value and receipts, with totals per room and per currency.
        </Trans>
      </p>
      {incidentName ? (
        <p className="m-0">
          <Trans>
            For <span className="font-medium">{incidentName}</span>
          </Trans>
        </p>
      ) : locationIds.length > 1 ? (
        <Select<{ id: string; name: string }>
          label={t`Location`}
          items={locationIds.flatMap((id) => {
            const l = all.find((x) => x.id === id);
            return l ? [{ id, name: locationName(l) }] : [];
          })}
          value={locationId}
          onChange={(key) => key != null && setLocationId(String(key))}
        >
          {(item) => (
            <SelectItem id={item.id} textValue={item.name}>
              <bdi>{item.name}</bdi>
            </SelectItem>
          )}
        </Select>
      ) : location ? (
        <p className="m-0">
          <Trans>
            For <bdi className="font-medium">{locationName(location)}</bdi>
          </Trans>
        </p>
      ) : null}
      <DatePicker
        label={t`As of`}
        description={t`Values are the latest on or before this day.`}
        value={asOf}
        maxValue={today}
        onChange={setAsOf}
      />
      <div className="grid gap-1">
        <CurrencyPicker
          label={t`Also total in (optional)`}
          value={currency}
          onChange={(c) => {
            setCurrency(c);
            setMissing(null);
          }}
        />
        <p className="m-0 text-small text-ink-2">
          <Trans>Totals stay per currency; this adds one converted with your exchange rates.</Trans>
        </p>
      </div>
      <Switch isSelected={photos} onChange={setPhotos}>
        <Trans>Include photos</Trans>
      </Switch>
      {missing ? <MissingRates missing={missing} accountId={location?.ownerAccountId} /> : null}
      {failed ? <Notice tone="danger">{startError(failed)}</Notice> : null}
      {csv ? (
        <Notice
          tone="ok"
          title={<Trans>Your CSV is ready</Trans>}
          action={
            <div className="flex flex-wrap gap-2">
              {canShareFiles([csv]) ? (
                <Button size="small" onPress={() => void shareCsv(csv)}>
                  <ShareIcon className="size-4" />
                  <Trans>Share</Trans>
                </Button>
              ) : null}
              <Button size="small" variant="secondary" onPress={() => setCsv(null)}>
                <Trans>Close</Trans>
              </Button>
            </div>
          }
        >
          {canShareFiles([csv]) ? (
            <Trans>Share it to save it to Files or send it on.</Trans>
          ) : (
            <Trans>This browser can't save files here. Open Kept in Safari to export it.</Trans>
          )}
        </Notice>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" isPending={busy} isDisabled={!online || !asOf || !locationId}>
          <PrinterIcon className="size-4" />
          <Trans>Make the PDF</Trans>
        </Button>
        <Button
          variant="secondary"
          isPending={csvBusy}
          isDisabled={!online || !asOf || !locationId}
          onPress={() => void exportCsv()}
        >
          <DocumentIcon className="size-4" />
          <Trans>Export CSV</Trans>
        </Button>
        {online ? null : (
          <span className="text-small text-ink-3">
            <Trans>Needs a connection</Trans>
          </span>
        )}
      </div>
    </form>
  );
}
