/**
 * The import stepper (screens §6 "Import stepper"; plan T30; D73): source, location and file →
 * columns → choices → the dry run's report → progress → the summary, for a CSV. A Homebox or
 * Kept export chosen as the source goes through the archive flow instead (step-7 T19:
 * archive-step.tsx, then archive-run.tsx once its run exists, `?source=` then `?run=`). Owners and admins only
 * (`location.export-import`): the location picker offers only their locations, and a 403 from the
 * server says so.
 *
 * The file lives only in this page's memory until Check sends its rows (POST /imports/csv, then
 * the dry run). From then the run is in the URL (`?run=`), so the report, the progress and Resume
 * survive a reload; only Adjust mapping needs the file again. Adjusting cancels the run it
 * replaces, which clears its rows on the server.
 *
 * Errors the server can answer: 413 (more than 10,000 rows; the page refuses such a file before
 * sending it), 403 (not an owner or admin there), and 409 (Import before the check: the page
 * offers the check again).
 */
import {
  type ArchiveSource,
  CSV_LIMITS,
  type DateFormat,
  type MappableField,
  newId,
} from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { captureApi, captureKeys, useImportRun } from '@/api/capture/queries';
import type { ImportChoices, ImportRun } from '@/api/capture/types';
import { isApiError } from '@/api/client';
import { useLocations } from '@/api/queries';
import type { LocationSummary } from '@/api/types';
import { EmptyState, ErrorState, LoadingRows, Notice, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { ArchiveRunView } from './archive-run';
import { ArchiveStep } from './archive-step';
import { ChoicesStep } from './choices-step';
import { hasProblems, MappingStep, mappingProblems } from './mapping-step';
import type { ParsedCsv } from './parse';
import { RunFinished, RunProgress } from './progress-step';
import { ReportList, ReportSummary } from './report-step';
import { StepFooter, StepHeader } from './step-chrome';
import { dateFormatsFor, separatorFor, suggestMapping } from './suggest';
import { isStale, UploadStep } from './upload-step';

type Draft = {
  fileName: string;
  parsed: ParsedCsv;
  mapping: Record<string, MappableField>;
  choices: ImportChoices;
  dateCandidates: DateFormat[];
};

type Step = 'file' | 'map' | 'choices';
const STEPS = 5;
const POLL_MS = 1500;

/** The page's words for an import request that failed. */
export function useImportErrorText() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const f = useFormat();
  return (e: unknown): string => {
    if (isApiError(e)) {
      if (e.status === 413) {
        const limit = f.num(CSV_LIMITS.rows);
        return t`An import takes at most ${limit} rows. Split the file and import each part.`;
      }
      if (e.status === 403) return t`Only owners and admins of this location can import into it.`;
      if (e.status === 409) return t`Check the import first, then import.`;
    }
    return errorText(e);
  };
}

/** The mapping as sent: columns that are imported, and nothing else. */
const sentMapping = (mapping: Record<string, MappableField>) =>
  Object.fromEntries(Object.entries(mapping).filter(([, f]) => f !== 'ignore')) as Record<
    string,
    MappableField
  >;

export function ImportStepper({
  locationParam,
  runId,
  sourceParam,
  go,
}: {
  locationParam: string | undefined;
  runId: string | undefined;
  /** A Homebox or Kept export chosen as the source, before its run exists (T19). */
  sourceParam?: ArchiveSource | undefined;
  /** Moves to another location, run or source, in the URL. */
  go: (next: { location?: string; run?: string; source?: ArchiveSource }) => void;
}) {
  const locationName = useLocationName();
  const locations = useLocations();
  const qc = useQueryClient();
  const errorText = useImportErrorText();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [step, setStep] = useState<Step>('file');
  const [showProblems, setShowProblems] = useState(false);

  const importable = (locations.data ?? []).filter((l) => l.role === 'owner' || l.role === 'admin');
  const locationId =
    locationParam && importable.some((l) => l.id === locationParam)
      ? locationParam
      : importable.length === 1
        ? (importable[0]?.id ?? '')
        : '';
  const location = importable.find((l) => l.id === locationId);

  const check = useMutation({
    mutationFn: async (d: Draft) => {
      const id = newId();
      await captureApi.createImport({
        id,
        locationId,
        columns: d.parsed.columns,
        rows: d.parsed.rows,
        mapping: sentMapping(d.mapping),
        choices: d.choices,
      });
      go({ location: locationId, run: id });
      const { report } = await captureApi.dryRun(id);
      return { id, report };
    },
    onSuccess: ({ id, report }) => {
      qc.setQueryData<ImportRun>(captureKeys.imports.run(id), (run) =>
        run ? { ...run, status: 'checked', report } : run,
      );
      void qc.invalidateQueries({ queryKey: captureKeys.imports.all });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });

  if (locations.isPending) return <LoadingRows rows={4} />;
  if (locations.isError) return <ErrorState error={locations.error} />;
  if (importable.length === 0) {
    return (
      <EmptyState title={<Trans>Only owners and admins can import</Trans>}>
        <Trans>
          Importing adds things to a location, so it's for its owners and admins. Ask one of them,
          or import into a location of your own.
        </Trans>
      </EmptyState>
    );
  }

  const name = location ? locationName(location) : '';

  if (runId) {
    return (
      <RunSwitch
        runId={runId}
        importable={importable}
        go={go}
        csv={
          <RunView
            runId={runId}
            locationName={name}
            hasFile={!!draft}
            onAdjust={() => {
              go({ location: locationId });
              setShowProblems(false);
              setStep(draft ? 'map' : 'file');
            }}
            onAnother={() => {
              setDraft(null);
              setStep('file');
              go({ location: locationId });
            }}
            nameOf={
              draft
                ? (row) => {
                    const column = draft.parsed.columns.find((c) => draft.mapping[c] === 'name');
                    const i = column ? draft.parsed.columns.indexOf(column) : -1;
                    return i >= 0
                      ? draft.parsed.rows[row - 1]?.[i]?.trim() || undefined
                      : undefined;
                  }
                : undefined
            }
          />
        }
      />
    );
  }

  if (sourceParam) {
    return (
      <ArchiveStep
        key={sourceParam}
        source={sourceParam}
        onBack={() => go(locationId ? { location: locationId } : {})}
        onUploaded={(run) => {
          qc.setQueryData(captureKeys.imports.run(run.id), run);
          go({ run: run.id });
        }}
      />
    );
  }

  const stepNo = step === 'file' ? 1 : step === 'map' ? 2 : 3;
  const title =
    step === 'file' ? (
      <Trans>Choose the file</Trans>
    ) : step === 'map' ? (
      <Trans>Match the columns</Trans>
    ) : (
      <Trans>A few choices</Trans>
    );

  const onParsed = (file: { name: string }, parsed: ParsedCsv) => {
    const mapping = suggestMapping(parsed.columns);
    const valuesOf = (field: MappableField) => {
      const i = parsed.columns.findIndex((c) => mapping[c] === field);
      return i < 0 ? [] : parsed.rows.map((r) => r[i] ?? '');
    };
    const dateCandidates = dateFormatsFor(valuesOf('purchased_on'));
    setDraft({
      fileName: file.name,
      parsed,
      mapping,
      dateCandidates,
      choices: {
        placeSeparator: separatorFor(valuesOf('place_path')),
        createPlaces: true,
        dateFormat: dateCandidates[0] ?? 'YYYY-MM-DD',
        defaultTarget: { unplaced: true },
        typeByName: true,
      },
    });
    setShowProblems(false);
    setStep('map');
  };

  const footer = (
    <StepFooter>
      {step !== 'file' ? (
        <Button variant="secondary" onPress={() => setStep(step === 'choices' ? 'map' : 'file')}>
          <Trans>Back</Trans>
        </Button>
      ) : null}
      <span className="flex-1" />
      {step === 'map' && draft ? (
        <Button
          onPress={() => {
            if (hasProblems(mappingProblems(draft.parsed.columns, draft.mapping))) {
              setShowProblems(true);
              return;
            }
            // The date guess follows the column now chosen as the purchase date.
            const i = draft.parsed.columns.findIndex((c) => draft.mapping[c] === 'purchased_on');
            const dateCandidates = dateFormatsFor(
              i < 0 ? [] : draft.parsed.rows.map((r) => r[i] ?? ''),
            );
            setDraft({
              ...draft,
              dateCandidates,
              choices: {
                ...draft.choices,
                ...(dateCandidates[0] && !dateCandidates.includes(draft.choices.dateFormat)
                  ? { dateFormat: dateCandidates[0] }
                  : {}),
              },
            });
            setStep('choices');
          }}
        >
          <Trans>Next</Trans>
        </Button>
      ) : null}
      {step === 'choices' && draft ? (
        <Button isPending={check.isPending} onPress={() => check.mutate(draft)}>
          <Trans>Check the import</Trans>
        </Button>
      ) : null}
    </StepFooter>
  );

  return (
    <div className="grid gap-5">
      <StepHeader total={STEPS} step={stepNo} title={title} />
      {step === 'file' || !draft ? (
        <UploadStep
          locations={importable}
          locationId={locationId}
          onLocation={(id) => go({ location: id })}
          onParsed={onParsed}
          onSource={(source) => go({ source })}
        />
      ) : (
        <p className="m-0 text-small text-ink-2">
          <Trans>
            <bdi className="font-medium text-ink">{draft.fileName}</bdi> into{' '}
            <bdi className="font-medium text-ink">{name}</bdi>
          </Trans>
        </p>
      )}
      {step === 'map' && draft ? (
        <MappingStep
          parsed={draft.parsed}
          mapping={draft.mapping}
          onChange={(mapping) => setDraft({ ...draft, mapping })}
          showProblems={showProblems}
        />
      ) : null}
      {step === 'choices' && draft && location ? (
        <ChoicesStep
          locationId={locationId}
          locationCurrency={location.currency}
          mapping={draft.mapping}
          choices={draft.choices}
          onChange={(choices) => setDraft({ ...draft, choices })}
          dateCandidates={draft.dateCandidates}
        />
      ) : null}
      {step !== 'file' ? footer : null}
    </div>
  );
}

/** A run in the URL: the CSV view for a CSV import, the archive flow for a Homebox or Kept
 * export (both are step 3's `GET /imports/:id`). */
function RunSwitch({
  runId,
  importable,
  go,
  csv,
}: {
  runId: string;
  importable: LocationSummary[];
  go: (next: { location?: string; run?: string; source?: ArchiveSource }) => void;
  csv: ReactNode;
}) {
  const query = useImportRun(runId);
  if (query.isPending) return <LoadingRows rows={4} />;
  if (query.isError || !query.data) return <ErrorState error={query.error} />;
  if ((query.data.source as string) !== 'csv')
    return <ArchiveRunView key={runId} runId={runId} importable={importable} go={go} />;
  return <>{csv}</>;
}

function RunView({
  runId,
  locationName,
  hasFile,
  onAdjust,
  onAnother,
  nameOf,
}: {
  runId: string;
  locationName: string;
  hasFile: boolean;
  onAdjust: () => void;
  onAnother: () => void;
  nameOf: ((row: number) => string | undefined) | undefined;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const errorText = useImportErrorText();
  const query = useImportRun(runId);
  const run = query.data;
  const [failure, setFailure] = useState<string | null>(null);
  const key = captureKeys.imports.run(runId);
  const put = (next: ImportRun) => {
    qc.setQueryData<ImportRun>(key, (prev) => ({
      ...next,
      ...(next.report ? {} : prev?.report ? { report: prev.report } : {}),
    }));
    void qc.invalidateQueries({ queryKey: captureKeys.imports.list(next.locationId) });
  };

  // While it runs, read it again every POLL_MS (a stopped one stays put until Resume).
  const polling = run?.status === 'running' && !isStale(run);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void query.refetch(), POLL_MS);
    return () => clearInterval(timer);
  }, [polling, query.refetch]);

  const dryRun = useMutation({
    mutationFn: () => captureApi.dryRun(runId),
    onSuccess: ({ report }) => {
      setFailure(null);
      if (run) put({ ...run, status: 'checked', report });
    },
    onError: (e) => setFailure(errorText(e)),
  });
  const start = useMutation({
    mutationFn: () => captureApi.runImport(runId),
    onSuccess: (next) => {
      setFailure(null);
      put(next);
      void query.refetch();
    },
    onError: (e) => {
      setFailure(errorText(e));
      if (isApiError(e) && e.status === 409) void query.refetch();
    },
  });
  const cancel = useMutation({
    mutationFn: () => captureApi.cancelImport(runId),
    onSuccess: put,
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  const adjust = async () => {
    // The run it replaces is cancelled, so its rows don't wait on the server.
    if (run && (run.status === 'draft' || run.status === 'checked')) {
      await captureApi.cancelImport(runId).catch(() => undefined);
    }
    onAdjust();
  };
  const askCancel = async () => {
    const ok = await confirm({
      title: t`Cancel the import?`,
      body: t`It stops after the rows it's working on. Things it already imported stay; import the file again later and those rows are skipped.`,
      confirmLabel: t`Cancel the import`,
      cancelLabel: t`Keep importing`,
      destructive: true,
    });
    if (ok) cancel.mutate();
  };

  if (query.isPending) return <LoadingRows rows={4} />;
  if (query.isError || !run) return <ErrorState error={query.error} />;

  const failureNotice = failure ? (
    <Notice tone="danger" title={<Trans>That didn't work</Trans>}>
      {failure}
    </Notice>
  ) : null;

  if (run.status === 'draft' || (run.status === 'checked' && !run.report)) {
    return (
      <div className="grid gap-5">
        <StepHeader total={STEPS} step={4} title={<Trans>Check the import</Trans>} />
        <p className="m-0 text-ink-2">
          <Trans>
            The check reads every row the way the import will, and changes nothing. It shows what
            would be added, what would be kept as text, and what would be skipped.
          </Trans>
        </p>
        {failureNotice}
        <StepFooter>
          <Button variant="secondary" onPress={() => void adjust()}>
            {hasFile ? <Trans>Adjust mapping</Trans> : <Trans>Start again</Trans>}
          </Button>
          <span className="flex-1" />
          <Button isPending={dryRun.isPending} onPress={() => dryRun.mutate()}>
            <Trans>Check the import</Trans>
          </Button>
        </StepFooter>
      </div>
    );
  }

  if (run.status === 'checked' && run.report) {
    const things = run.report.summary.things;
    return (
      <div className="grid gap-5">
        <StepHeader total={STEPS} step={4} title={<Trans>What the import will do</Trans>} />
        <ReportSummary summary={run.report.summary} />
        {failureNotice}
        <ReportList
          report={run.report}
          reportKey={`${run.id}:${run.rowVersion}`}
          {...(nameOf ? { nameOf } : {})}
        />
        <StepFooter>
          <Button variant="secondary" onPress={() => void adjust()}>
            {hasFile ? <Trans>Adjust mapping</Trans> : <Trans>Start again</Trans>}
          </Button>
          <span className="flex-1" />
          <Button
            isDisabled={things === 0}
            isPending={start.isPending}
            onPress={() => start.mutate()}
          >
            {things === 0 ? (
              <Trans>Nothing to import</Trans>
            ) : (
              <Plural value={things} one="Import # thing" other="Import # things" />
            )}
          </Button>
        </StepFooter>
      </div>
    );
  }

  if (run.status === 'running' || run.status === 'failed') {
    return (
      <div className="grid gap-5">
        <StepHeader total={STEPS} step={5} title={<Trans>Importing into {locationName}</Trans>} />
        {failureNotice}
        <RunProgress
          run={run}
          isBusy={start.isPending}
          onResume={() => start.mutate()}
          onCancel={() => void askCancel()}
        />
      </div>
    );
  }

  return (
    <div className="grid gap-5">
      <StepHeader total={STEPS} step={5} title={<Trans>Done</Trans>} />
      <RunFinished run={run} locationName={locationName} onAnother={onAnother} />
    </div>
  );
}
