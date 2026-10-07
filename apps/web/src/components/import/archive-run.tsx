/**
 * An archive import once its run exists (screens §6; plan T19 steps 3–8): what's in it (with the
 * optional Homebox connection, or a Kept export's passphrase) → where it goes → the Homebox
 * choices → the check's report → progress → the summary, with "See what was imported" (the
 * location's things filtered by this run, `f.importRun`, T16) and the offer to add search words.
 *
 * Where it is comes from the run itself (`GET /imports/:id`, step 3's route, polled while it
 * runs), so a reload lands on the same step; only the connection's answer, the target being
 * typed and the choices being made live in the page until they're sent. A refused archive says
 * why (ARCHIVE_REFUSALS) and offers another file.
 */
import type { ArchiveSource, HomeboxChoices } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ProgressBar } from 'react-aria-components';
import { captureApi, captureKeys, useImportRun } from '@/api/capture/queries';
import { isApiError } from '@/api/client';
import { portabilityApi } from '@/api/portability/queries';
import type {
  ArchiveDryRunReport,
  ArchiveImportRun,
  HomeboxConnection,
} from '@/api/portability/types';
import { keys } from '@/api/queries';
import type { LocationSummary } from '@/api/types';
import { CheckCircleIcon } from '@/components/icons';
import { ErrorState, LoadingRows, Notice, useErrorText } from '@/components/page';
import { Button, buttonClass } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import { ARCHIVE_STEPS } from './archive-step';
import { EnrichOffer } from './enrich-offer';
import { ArchiveReportSummary, EntityReport } from './entity-report';
import { HomeboxChoicesStep, initialChoices, useKeptTypes } from './homebox-choices';
import { HomeboxConnect, HomeboxInspectSummary } from './inspect-step';
import { KeptInspectSummary, KeptSecrets, PeopleToInvite } from './kept-choices';
import { useRefusalText } from './labels';
import { StepFooter, StepHeader } from './step-chrome';
import { initialTarget, type TargetDraft, TargetStep, targetBody } from './target-step';
import { isStale } from './upload-step';

const POLL_MS = 1500;
type Stage = 'inspect' | 'target' | 'choices' | 'report';
type Go = (next: { location?: string; run?: string; source?: ArchiveSource }) => void;

/** The page's words for a failed archive request. */
function useArchiveErrorText() {
  const { t } = useLingui();
  const errorText = useErrorText();
  return (e: unknown): string => {
    if (isApiError(e)) {
      if (e.code === 'offline') return t`Needs a connection`;
      if (e.status === 403) return t`Only owners and admins of this location can import into it.`;
      if (e.code === 'import_target_needed') return t`Choose where to import it first.`;
      if (e.status === 412)
        return t`Someone changed this import in the meantime. It has been reloaded; check it and try again.`;
    }
    return errorText(e);
  };
}

export function ArchiveRunView({
  runId,
  importable,
  go,
}: {
  runId: string;
  /** Locations the caller owns or administers. */
  importable: LocationSummary[];
  go: Go;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const f = useFormat();
  const online = useOnline();
  const confirm = useConfirm();
  const locationName = useLocationName();
  const errorText = useArchiveErrorText();
  const refusal = useRefusalText();
  const query = useImportRun(runId);
  const run = query.data as unknown as ArchiveImportRun | undefined;
  const key = captureKeys.imports.run(runId);
  const [stage, setStage] = useState<Stage | null>(null);
  const [connection, setConnection] = useState<HomeboxConnection | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const put = (next: ArchiveImportRun) => {
    qc.setQueryData<ArchiveImportRun>(key as never, (prev) => ({
      ...next,
      ...(next.report
        ? {}
        : prev?.report && next.status === 'checked'
          ? { report: prev.report }
          : {}),
    }));
    void qc.invalidateQueries({ queryKey: captureKeys.imports.all, refetchType: 'none' });
  };

  // While it runs, read it again every POLL_MS (a stopped one stays put until Resume).
  const polling = run?.status === 'running' && !isStale(run);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void query.refetch(), POLL_MS);
    return () => clearInterval(timer);
  }, [polling, query.refetch]);

  // An uploaded archive is read once, as soon as the run is open.
  const inspect = useMutation({
    mutationFn: () => portabilityApi.inspect(runId),
    onSettled: () => void query.refetch(),
  });
  const inspected = useRef(false);
  const needsInspect =
    !!run && !!run.archiveReadyAt && !run.inspect && run.status === 'draft' && online;
  useEffect(() => {
    if (!needsInspect || inspected.current) return;
    inspected.current = true;
    inspect.mutate();
  }, [needsInspect, inspect]);

  const location = importable.find((l) => l.id === run?.locationId);
  const keptTypes = useKeptTypes(location?.ownerAccountId);

  const target = useMutation({
    mutationFn: (body: NonNullable<ReturnType<typeof targetBody>>) =>
      portabilityApi.setTarget(runId, body),
    onSuccess: async (next) => {
      setFailure(null);
      await qc.invalidateQueries({ queryKey: keys.locations });
      put(next);
      setStage(next.source === 'homebox_zip' ? 'choices' : null);
    },
    onError: (e) => setFailure(errorText(e)),
  });
  const check = useMutation({
    mutationFn: async (choices: HomeboxChoices | null) => {
      if (!run) throw new Error('no run');
      if (choices) {
        const saved = await portabilityApi.setChoices(runId, { choices }, run.rowVersion);
        put(saved);
      }
      return portabilityApi.archiveDryRun(runId);
    },
    onSuccess: ({ report }) => {
      setFailure(null);
      if (run) put({ ...run, status: 'checked', report });
      setStage('report');
      void query.refetch();
      // A fresh URL: the types list's search and filters don't carry into the report.
      go({ run: runId });
    },
    onError: (e) => {
      setFailure(errorText(e));
      if (isApiError(e) && e.status === 412) void query.refetch();
    },
  });
  const start = useMutation({
    mutationFn: () => captureApi.runImport(runId),
    onSuccess: (next) => {
      setFailure(null);
      put(next as unknown as ArchiveImportRun);
      void query.refetch();
    },
    onError: (e) => {
      setFailure(errorText(e));
      if (isApiError(e) && e.status === 409) void query.refetch();
    },
  });
  const cancel = useMutation({
    mutationFn: () => captureApi.cancelImport(runId),
    onSuccess: (next) => put(next as unknown as ArchiveImportRun),
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });

  if (query.isPending) return <LoadingRows rows={4} />;
  if (query.isError || !run) return <ErrorState error={query.error} />;

  const source = run.source;
  const total = ARCHIVE_STEPS;
  const failureNotice = failure ? (
    <Notice tone="danger" title={<Trans>That didn't work</Trans>}>
      {failure}
    </Notice>
  ) : null;
  const again = () => go({ source });
  const name = location ? locationName(location) : '';

  // ----- refused, or never fully uploaded -----
  if (run.status === 'failed' && (run.error === 'archive_invalid' || !run.inspect)) {
    const why = refusal(run.reason);
    return (
      <div className="grid gap-5">
        <StepHeader step={3} total={total} title={<Trans>Kept can't read this archive</Trans>} />
        <Notice tone="danger" title={<Trans>Nothing was imported</Trans>}>
          {why ?? (
            <Trans>It isn't an export Kept can read. Export it again and try once more.</Trans>
          )}
        </Notice>
        <StepFooter>
          <Button onPress={again}>
            <Trans>Choose another file</Trans>
          </Button>
        </StepFooter>
      </div>
    );
  }
  // A run that has started importing has no archive any more once it's done (the Homebox job
  // deletes it), so a missing archive means an unfinished upload only before that (UI review
  // steps 6–8, H2: every finished Homebox import ended on "The upload didn't finish").
  const pastUpload = run.status === 'running' || run.status === 'done' || run.status === 'failed';
  if ((!run.archiveReadyAt && !pastUpload) || (run.status === 'cancelled' && !run.locationId)) {
    return (
      <div className="grid gap-5">
        <StepHeader step={2} total={total} title={<Trans>The upload didn't finish</Trans>} />
        <Notice tone="warn">
          <Trans>The file didn't arrive whole, so nothing was imported. Choose it again.</Trans>
        </Notice>
        <StepFooter>
          <Button onPress={again}>
            <Trans>Choose the file again</Trans>
          </Button>
        </StepFooter>
      </div>
    );
  }
  if (!run.inspect) {
    return (
      <div className="grid gap-5">
        <StepHeader step={3} total={total} title={<Trans>What's in it</Trans>} />
        {inspect.isError &&
        !(isApiError(inspect.error) && inspect.error.code === 'archive_invalid') ? (
          <ErrorState error={inspect.error} onRetry={() => inspect.mutate()} />
        ) : !online ? (
          <Notice tone="warn" title={<Trans>Needs a connection</Trans>} />
        ) : (
          <LoadingRows rows={3} label={t`Reading the archive…`} />
        )}
      </div>
    );
  }

  const ins = run.inspect;
  const originalName =
    ins.source === 'kept_zip' ? ins.kept.locationName : (ins.collections[0]?.name ?? '');

  // ----- before the target: what's in it, then where it goes -----
  if (!run.locationId) {
    if (stage !== 'target') {
      return (
        <div className="grid gap-5">
          <StepHeader step={3} total={total} title={<Trans>What's in it</Trans>} />
          {ins.source === 'homebox_zip' ? (
            <>
              <HomeboxInspectSummary inspect={ins} connection={connection} />
              <HomeboxConnect runId={runId} connection={connection} onConnected={setConnection} />
            </>
          ) : (
            <>
              <KeptInspectSummary kept={ins.kept} />
              <KeptSecrets run={run} onRun={put} />
              <PeopleToInvite people={ins.kept.members} />
            </>
          )}
          <StepFooter>
            <Button variant="secondary" onPress={again}>
              <Trans>Choose another file</Trans>
            </Button>
            <span className="flex-1" />
            <Button isDisabled={!online} onPress={() => setStage('target')}>
              <Trans>Next</Trans>
            </Button>
          </StepFooter>
        </div>
      );
    }
    return (
      <TargetPane
        key={runId}
        run={run}
        importable={importable}
        originalName={originalName}
        failureNotice={failureNotice}
        isPending={target.isPending}
        online={online}
        onBack={() => setStage('inspect')}
        onNext={(body) => target.mutate(body)}
      />
    );
  }

  // ----- the Homebox choices -----
  const choosing =
    source === 'homebox_zip' &&
    (run.status === 'draft' || (stage === 'choices' && run.status === 'checked'));
  if (choosing) {
    const hints = ins.source === 'homebox_zip' ? ins.collections[0]?.mapping : undefined;
    return (
      <div className="grid gap-5">
        <StepHeader step={5} total={total} title={<Trans>A few choices, before the check</Trans>} />
        {!location || !keptTypes ? (
          <LoadingRows rows={4} />
        ) : (
          <ChoicesPane
            key={`${runId}:${run.choices ? 'saved' : 'new'}`}
            initial={
              run.choices ??
              initialChoices(
                hints,
                keptTypes,
                connection?.collections[0]?.currency ?? location.currency,
              )
            }
            render={(choices, setChoices) => (
              <>
                <HomeboxChoicesStep
                  hints={hints}
                  choices={choices}
                  onChange={setChoices}
                  keptTypes={keptTypes}
                  locationCurrency={location.currency}
                  connection={connection}
                />
                {failureNotice}
                <StepFooter>
                  {run.status === 'checked' ? (
                    <Button variant="secondary" onPress={() => setStage('report')}>
                      <Trans>Back</Trans>
                    </Button>
                  ) : null}
                  <span className="flex-1" />
                  <Button
                    isDisabled={!online}
                    isPending={check.isPending}
                    onPress={() => check.mutate(choices)}
                  >
                    <Trans>Check the import</Trans>
                  </Button>
                </StepFooter>
              </>
            )}
          />
        )}
      </div>
    );
  }

  // ----- a Kept export, before its check -----
  if (run.status === 'draft' || (run.status === 'checked' && !run.report)) {
    return (
      <div className="grid gap-5">
        <StepHeader step={5} total={total} title={<Trans>Check the import</Trans>} />
        <p className="m-0 text-ink-2">
          <Trans>
            The check reads the whole export the way the import will, and changes nothing. It shows
            what would be added, which printed labels keep their codes, and what can't come across.
          </Trans>
        </p>
        <KeptSecrets run={run} onRun={put} />
        {failureNotice}
        <StepFooter>
          <span className="flex-1" />
          <Button
            isDisabled={!online}
            isPending={check.isPending}
            onPress={() => check.mutate(null)}
          >
            <Trans>Check the import</Trans>
          </Button>
        </StepFooter>
      </div>
    );
  }

  const invite = { to: '/settings/location/$id/invite' as const, params: { id: run.locationId } };
  const people = peopleOf(run.report, connection);

  // ----- the report -----
  if (run.status === 'checked' && run.report) {
    const things = run.report.summary.things;
    return (
      <div className="grid gap-5">
        <StepHeader step={6} total={total} title={<Trans>What the import will do</Trans>} />
        <ArchiveReportSummary report={run.report} />
        {failureNotice}
        <EntityReport report={run.report} reportKey={`${run.id}:${run.rowVersion}`} />
        <PeopleToInvite people={people} inviteHref={invite} />
        <StepFooter>
          {source === 'homebox_zip' ? (
            <Button variant="secondary" onPress={() => setStage('choices')}>
              <Trans>Adjust</Trans>
            </Button>
          ) : null}
          <span className="flex-1" />
          <Button
            isDisabled={things === 0 || !online}
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

  // ----- importing -----
  if (run.status === 'running' || run.status === 'failed') {
    const stopped = run.status === 'failed' || isStale(run);
    const done = f.num(run.progress);
    const of = f.num(run.total ?? 0);
    return (
      <div className="grid gap-5">
        <StepHeader
          step={6}
          total={total}
          title={
            <Trans>
              Importing into <bdi>{name}</bdi>
            </Trans>
          }
        />
        {failureNotice}
        <ProgressBar
          aria-label={t`Imported`}
          value={run.progress}
          maxValue={Math.max(run.total ?? 0, 1)}
          valueLabel={t`${done} of ${of}`}
          className="grid gap-2"
        >
          {({ percentage, valueText }) => (
            <>
              <span className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold text-[17px]">
                  {stopped ? <Trans>The import stopped</Trans> : <Trans>Importing…</Trans>}
                </span>
                <span className="text-small text-ink-2">{valueText}</span>
              </span>
              <span className="h-2 overflow-hidden rounded-full bg-sunken">
                <span
                  className="block h-full bg-ink transition-[width]"
                  style={{ width: `${percentage ?? 0}%` }}
                />
              </span>
            </>
          )}
        </ProgressBar>
        {stopped ? (
          <Notice
            tone="warn"
            title={<Trans>Resume to carry on where it stopped</Trans>}
            action={
              <Button
                isDisabled={!online}
                isPending={start.isPending}
                onPress={() => start.mutate()}
              >
                <Trans>Resume</Trans>
              </Button>
            }
          >
            <Trans>What it already imported stays; nothing is made twice.</Trans>
          </Notice>
        ) : (
          <p className="m-0 text-small text-ink-2">
            <Trans>
              You can leave this page; the import carries on, and Settings → Import shows how far it
              got.
            </Trans>
          </p>
        )}
        <Button
          variant="secondary"
          className="justify-self-start"
          onPress={async () => {
            const ok = await confirm({
              title: t`Cancel the import?`,
              body: t`It stops after what it's working on. What it already imported stays; import the same export again later and that is skipped.`,
              confirmLabel: t`Cancel the import`,
              cancelLabel: t`Keep importing`,
              destructive: true,
            });
            if (ok) cancel.mutate();
          }}
        >
          <Trans>Cancel the import</Trans>
        </Button>
      </div>
    );
  }

  // ----- done or cancelled -----
  const cancelled = run.status === 'cancelled';
  return (
    <div className="grid gap-5">
      <StepHeader step={6} total={total} title={<Trans>Done</Trans>} />
      {cancelled ? (
        <Notice tone="info" title={<Trans>Import cancelled</Trans>}>
          <Trans>
            What it imported before stopping stays in <bdi>{name}</bdi>.
          </Trans>
        </Notice>
      ) : (
        <div className="grid justify-items-start gap-2 rounded-[10px] border border-line bg-surface p-4">
          <CheckCircleIcon className="size-7 text-ok" />
          <h3 className="m-0 font-semibold text-[20px]">
            <Trans>
              Imported into <bdi>{name}</bdi>
            </Trans>
          </h3>
          {run.report ? <DoneLine report={run.report} /> : null}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Link
          to="/loc/$id"
          params={{ id: run.locationId }}
          search={{ 'f.importRun': [run.id] } as never}
          className={buttonClass('primary')}
        >
          <Trans>See what was imported</Trans>
        </Link>
        <Link to="/loc/$id" params={{ id: run.locationId }} className={buttonClass('secondary')}>
          <Trans>Open the location</Trans>
        </Link>
      </div>
      {!cancelled ? <EnrichOffer runId={run.id} /> : null}
      <PeopleToInvite people={people} inviteHref={invite} />
      <Button variant="ghost" className="justify-self-start" onPress={() => go({})}>
        <Trans>Import something else</Trans>
      </Button>
    </div>
  );
}

/** The people to invite: the connection's members (with emails), or the Kept export's. */
function peopleOf(report: ArchiveDryRunReport | undefined, connection: HomeboxConnection | null) {
  if (report?.source === 'kept_zip') return report.summary.members;
  return (connection?.members ?? []).map((m) => ({ name: m.name, email: m.email }));
}

function DoneLine({ report }: { report: ArchiveDryRunReport }) {
  const s = report.summary;
  const files = report.source === 'homebox_zip' ? report.summary.attachments : report.summary.files;
  const labels =
    report.source === 'homebox_zip'
      ? report.summary.legacyCodes
      : report.summary.codesAdopted + report.summary.codesReissued;
  return (
    <p className="m-0 text-ink-2">
      <Trans>
        <Plural value={s.things} one="# thing" other="# things" />,{' '}
        <Plural value={s.places} one="# place" other="# places" /> and{' '}
        <Plural value={files} one="# file" other="# files" />.
      </Trans>{' '}
      {labels > 0 ? (
        report.source === 'homebox_zip' ? (
          <Plural
            value={labels}
            one="# old Homebox label opens its thing here now."
            other="# old Homebox labels open their things here now."
          />
        ) : (
          <Plural
            value={labels}
            one="# printed label opens its thing here now."
            other="# printed labels open their things here now."
          />
        )
      ) : null}
    </p>
  );
}

/** Holds the target being chosen until Next sends it. */
function TargetPane({
  run,
  importable,
  originalName,
  failureNotice,
  isPending,
  online,
  onBack,
  onNext,
}: {
  run: ArchiveImportRun;
  importable: LocationSummary[];
  originalName: string;
  failureNotice: ReactNode;
  isPending: boolean;
  online: boolean;
  onBack: () => void;
  onNext: (body: NonNullable<ReturnType<typeof targetBody>>) => void;
}) {
  const kind = run.inspect?.source === 'kept_zip' ? run.inspect.kept.kind : undefined;
  const [draft, setDraft] = useState<TargetDraft>(() => initialTarget(originalName, kind));
  const body = targetBody(draft);
  return (
    <div className="grid gap-5">
      <StepHeader step={4} total={ARCHIVE_STEPS} title={<Trans>Where it goes</Trans>} />
      <TargetStep
        source={run.source}
        draft={draft}
        onChange={setDraft}
        locations={importable}
        originalName={originalName}
      />
      {failureNotice}
      <StepFooter>
        <Button variant="secondary" onPress={onBack}>
          <Trans>Back</Trans>
        </Button>
        <span className="flex-1" />
        <Button
          isDisabled={!body || !online}
          isPending={isPending}
          onPress={() => {
            if (body) onNext(body);
          }}
        >
          <Trans>Next</Trans>
        </Button>
      </StepFooter>
    </div>
  );
}

/** Holds the Homebox choices being made until Check sends them. */
function ChoicesPane({
  initial,
  render,
}: {
  initial: HomeboxChoices;
  render: (choices: HomeboxChoices, set: (c: HomeboxChoices) => void) => ReactNode;
}) {
  const [choices, setChoices] = useState(initial);
  return <>{render(choices, setChoices)}</>;
}
