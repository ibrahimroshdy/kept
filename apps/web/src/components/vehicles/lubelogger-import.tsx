/**
 * "Import from LubeLogger" on a vehicle's Overview (1.3, D229), for its location's owners and
 * admins. LubeLogger exports one CSV per kind of record per vehicle (fuel, service, odometer),
 * written in its server's language settings: so the sheet reads the file here, says which kind it
 * is from its columns, guesses the date order and decimal mark from the rows (the person can
 * change them), asks the fuel unit, then **Check** runs the import without keeping it and says
 * what it would add and what it can't; **Import** does it. A second import of the same file adds
 * nothing.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { vehiclesApi } from '@/api/vehicles/queries';
import type {
  LubeLoggerImportBody,
  LubeLoggerImportResult,
  LubeLoggerKind,
} from '@/api/vehicles/types';
import { FilePick } from '@/components/capture/gallery-import';
import { ShareIcon } from '@/components/icons';
import { ParseError, parseCsvFile } from '@/components/import/parse';
import { Notice, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { useThingCtx } from '@/components/things/context';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { toast } from '@/components/ui/toast';
import { useOnline } from '@/lib/online';

type Parsed = { name: string; kind: LubeLoggerKind | null; rows: Array<Record<string, string>> };
type DateOrder = LubeLoggerImportBody['dateOrder'];
type Decimal = LubeLoggerImportBody['decimal'];

/** The kind of export, from its columns (LubeLogger's own header names). */
export function kindOf(columns: readonly string[]): LubeLoggerKind | null {
  const has = (c: string) => columns.includes(c);
  if (has('Date') && has('FuelConsumed')) return 'fuel';
  if (has('Date') && has('Description') && has('Cost')) return 'service';
  if (has('Date') && has('InitialOdometer') && has('Odometer')) return 'odometer';
  return null;
}

/** The date order the rows' dates must be in: a first part over 12 is a day, a four-digit first
 * part a year; otherwise month first (LubeLogger's default, en-US). */
export function guessDateOrder(dates: readonly string[]): DateOrder {
  let dayFirst = false;
  for (const d of dates) {
    const m = /^\s*(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})/.exec(d);
    if (!m) continue;
    if ((m[1] as string).length === 4) return 'ymd';
    if (Number(m[1]) > 12) dayFirst = true;
  }
  return dayFirst ? 'dmy' : 'mdy';
}

/** A decimal comma when amounts end in ",dd" and none uses a point that way. */
export function guessDecimal(values: readonly string[]): Decimal {
  const comma = values.some((v) => /,\d{1,3}\D*$/.test(v) && !/\.\d{1,3}\D*$/.test(v));
  const point = values.some((v) => /\.\d{1,3}\D*$/.test(v));
  return comma && !point ? ',' : '.';
}

export function LubeLoggerImportButton() {
  const { can } = useThingCtx();
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const { t } = useLingui();
  if (!can('location.export-import')) return null;
  return (
    <>
      <Button variant="secondary" size="small" isDisabled={!online} onPress={() => setOpen(true)}>
        <ShareIcon className="size-4" />
        <Trans>Import from LubeLogger</Trans>
      </Button>
      <Sheet isOpen={open} onOpenChange={setOpen} title={t`Import from LubeLogger`}>
        {({ close }) => <ImportForm onClose={close} />}
      </Sheet>
    </>
  );
}

function ImportForm({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const { thing } = useThingCtx();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const online = useOnline();
  const [file, setFile] = useState<Parsed | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dateOrder, setDateOrder] = useState<DateOrder>('mdy');
  const [decimal, setDecimal] = useState<Decimal>('.');
  const [fuelUnit, setFuelUnit] = useState<'L' | 'gal'>('L');
  const [checked, setChecked] = useState<LubeLoggerImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const read = async (f: File) => {
    setFileError(null);
    setChecked(null);
    setError(null);
    try {
      const parsed = await parseCsvFile(f, (n) => `Column ${n}`);
      const rows = parsed.rows.map((r) =>
        Object.fromEntries(parsed.columns.map((c, i) => [c, r[i] ?? ''])),
      );
      const kind = kindOf(parsed.columns);
      setFile({ name: f.name, kind, rows });
      if (!kind) setFileError(t`This isn't a LubeLogger export of fuel, services or odometer.`);
      setDateOrder(guessDateOrder(rows.slice(0, 50).map((r) => r.Date ?? '')));
      setDecimal(
        guessDecimal(rows.slice(0, 50).flatMap((r) => [r.Cost ?? '', r.FuelConsumed ?? ''])),
      );
    } catch (e) {
      setFile(null);
      setFileError(
        e instanceof ParseError && e.problem.kind === 'unreadable'
          ? t`Kept can't read this file. Export it from LubeLogger again as CSV.`
          : t`Kept can't read this file.`,
      );
    }
  };

  const send = async (dryRun: boolean) => {
    if (!file?.kind) return;
    setBusy(true);
    setError(null);
    try {
      const result = await vehiclesApi.importLubeLogger(thing.id, {
        kind: file.kind,
        rows: file.rows,
        dateOrder,
        decimal,
        ...(file.kind === 'fuel' ? { fuelUnit } : {}),
        ...(dryRun ? { dryRun: true } : {}),
      });
      if (dryRun) {
        setChecked(result);
      } else {
        await qc.invalidateQueries();
        toast({ title: t`Imported ${result.created} records`, tone: 'ok' });
        onClose();
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const kindName =
    file?.kind === 'fuel'
      ? t`Fuel`
      : file?.kind === 'service'
        ? t`Services`
        : file?.kind === 'odometer'
          ? t`Odometer`
          : null;

  return (
    <div className="grid gap-4">
      <p className="m-0 text-small text-ink-2">
        <Trans>
          In LubeLogger, export this vehicle's fuel, service or odometer records as CSV, then choose
          the file here. One file at a time; importing the same one again adds nothing.
        </Trans>
      </p>
      <FilePick accept=".csv,text/csv" onFiles={(fs) => void read(fs[0] as File)}>
        <span className="inline-flex min-h-10 items-center rounded-[7px] border border-line bg-surface px-3.5 font-semibold text-[13.5px]">
          {file ? <bdi>{file.name}</bdi> : <Trans>Choose a CSV file</Trans>}
        </span>
      </FilePick>
      {fileError ? <Notice tone="danger">{fileError}</Notice> : null}
      {file?.kind ? (
        <>
          <p className="m-0 text-small text-ink-2">
            <Trans>
              {kindName}: {file.rows.length} rows
            </Trans>
          </p>
          <Segmented<DateOrder>
            label={t`Dates are written`}
            value={dateOrder}
            onChange={(v) => {
              setDateOrder(v);
              setChecked(null);
            }}
            options={[
              { id: 'mdy', label: t`Month first` },
              { id: 'dmy', label: t`Day first` },
              { id: 'ymd', label: t`Year first` },
            ]}
          />
          <Segmented<Decimal>
            label={t`Decimal mark`}
            value={decimal}
            onChange={(v) => {
              setDecimal(v);
              setChecked(null);
            }}
            options={[
              { id: '.', label: '1,234.56' },
              { id: ',', label: '1.234,56' },
            ]}
          />
          {file.kind === 'fuel' ? (
            <Segmented<'L' | 'gal'>
              label={t`Fuel is in`}
              value={fuelUnit}
              onChange={(v) => {
                setFuelUnit(v);
                setChecked(null);
              }}
              options={[
                { id: 'L', label: t`Litres` },
                { id: 'gal', label: t`Gallons` },
              ]}
            />
          ) : null}
          {checked ? <CheckResult result={checked} /> : null}
        </>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        {checked ? (
          <Button
            isPending={busy}
            isDisabled={!online || checked.created === 0}
            onPress={() => void send(false)}
          >
            <Trans>Import</Trans>
          </Button>
        ) : (
          <Button
            isPending={busy}
            isDisabled={!online || !file?.kind}
            onPress={() => void send(true)}
          >
            <Trans>Check</Trans>
          </Button>
        )}
      </DialogFooter>
    </div>
  );
}

function CheckResult({ result }: { result: LubeLoggerImportResult }) {
  const { t } = useLingui();
  const reason = (code: string) => {
    switch (code) {
      case 'date':
        return t`no date Kept can read`;
      case 'amount':
        return t`no amount of fuel`;
      case 'description':
        return t`no description`;
      case 'odometer':
        return t`no odometer reading`;
      case 'no_odometer':
        return t`this vehicle has no odometer`;
      case 'odometer_backwards':
        return t`the odometer goes backwards`;
      case 'cost':
        return t`a cost below zero`;
      default:
        return t`Kept refused it`;
    }
  };
  const shown = result.issues.slice(0, 20);
  return (
    <Notice tone={result.issues.length ? 'warn' : 'info'} title={<Trans>What it will do</Trans>}>
      <div className="grid gap-1">
        <span>
          <Trans>
            Add {result.created}. Already here: {result.skipped}. Can't add: {result.issues.length}.
          </Trans>
        </span>
        {shown.length ? (
          <ul className="m-0 grid gap-0.5 ps-4">
            {shown.map((i) => (
              <li key={`${i.row}-${i.code}`}>
                <Trans>
                  Row {i.row}: {reason(i.code)}
                </Trans>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Notice>
  );
}
