/**
 * The import stepper's first step (screens §6; plan T30 steps 1–3): the source (CSV here; a
 * Homebox or Kept export moves to the archive flow, step-7 T19), the location to import into (only those you own or administer),
 * and the file, read here on the phone or desktop. The location's recent imports are listed under
 * it, so an import that stopped can be opened and resumed.
 */
import { type ArchiveSource, IMPORT_STALE_MINUTES } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { DropZone, FileTrigger } from 'react-aria-components';
import { useImportRuns } from '@/api/capture/queries';
import type { ImportRun } from '@/api/capture/types';
import type { LocationSummary } from '@/api/types';
import { ChevronEndIcon, DocumentIcon } from '@/components/icons';
import { Notice, Pill, type PillTone } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { useParseProblemText } from './labels';
import { type ParsedCsv, ParseError, parseCsvFile } from './parse';
import { SourceStep } from './source-step';

const CSV_TYPES = ['text/csv', 'text/plain', 'application/vnd.ms-excel', '.csv'];

/** A running import that hasn't moved for IMPORT_STALE_MINUTES has lost its job (resumable). */
export const isStale = (run: Pick<ImportRun, 'status' | 'updatedAt'>, now = Date.now()) =>
  run.status === 'running' &&
  now - new Date(run.updatedAt).getTime() > IMPORT_STALE_MINUTES * 60_000;

export function UploadStep({
  locations,
  locationId,
  onLocation,
  onParsed,
  onSource,
}: {
  /** The locations the caller may import into (owner or admin). */
  locations: LocationSummary[];
  locationId: string;
  onLocation: (id: string) => void;
  onParsed: (file: { name: string }, parsed: ParsedCsv) => void;
  /** A Homebox or Kept export chosen as the source instead (the archive flow, T19). */
  onSource: (source: ArchiveSource) => void;
}) {
  const { t } = useLingui();
  const locationName = useLocationName();
  const problemText = useParseProblemText();
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const read = async (file: File | undefined) => {
    if (!file) return;
    setProblem(null);
    setReading(true);
    try {
      const parsed = await parseCsvFile(file, (n) => t`Column ${n}`);
      onParsed({ name: file.name }, parsed);
    } catch (e) {
      setProblem(problemText(e instanceof ParseError ? e.problem : { kind: 'unreadable' }));
    } finally {
      setReading(false);
    }
  };

  return (
    <div className="grid gap-5">
      <SourceStep value="csv" onChange={(source) => source !== 'csv' && onSource(source)} />

      <Combobox
        label={t`Import into`}
        items={locations.map((l) => ({ id: l.id, label: locationName(l) }))}
        selectedKey={locationId || null}
        onSelectionChange={(k) => {
          if (k) onLocation(String(k));
        }}
        description={t`Only owners and admins can import into a location.`}
      />

      <DropZone
        getDropOperation={(types) =>
          CSV_TYPES.some((type) => types.has(type)) || types.has('text/comma-separated-values')
            ? 'copy'
            : 'cancel'
        }
        onDrop={async (e) => {
          const item = e.items.find((i) => i.kind === 'file');
          if (item && item.kind === 'file') await read(await item.getFile());
        }}
        isDisabled={!locationId || reading}
        className={({ isDropTarget }) =>
          cn(
            'grid justify-items-center gap-3 rounded-[10px] border border-dashed border-line px-5 py-8 text-center outline-none',
            isDropTarget && 'border-ink bg-sunken',
          )
        }
      >
        <span className="grid size-12 place-items-center rounded-full bg-sunken text-ink-2 [&_svg]:size-6">
          <DocumentIcon />
        </span>
        <span className="max-w-md text-small text-ink-2">
          {locationId ? (
            <Trans>
              Choose a CSV file, or drop one here. It's read on this device first; nothing is
              imported until you've checked it.
            </Trans>
          ) : (
            <Trans>Choose the location first.</Trans>
          )}
        </span>
        <FileTrigger acceptedFileTypes={CSV_TYPES} onSelect={(files) => void read(files?.[0])}>
          <Button isDisabled={!locationId} isPending={reading}>
            <Trans>Choose a CSV file</Trans>
          </Button>
        </FileTrigger>
      </DropZone>
      {problem ? (
        <Notice tone="danger" title={<Trans>This file can't be imported</Trans>}>
          {problem}
        </Notice>
      ) : null}

      {locationId ? <RecentImports locationId={locationId} /> : null}
    </div>
  );
}

export function useRunStatusLabel() {
  const { t } = useLingui();
  return (run: ImportRun): { label: string; tone: PillTone } => {
    if (isStale(run)) return { label: t`Stopped`, tone: 'warn' };
    switch (run.status) {
      case 'draft':
        return { label: t`Not checked`, tone: 'neutral' };
      case 'checked':
        return { label: t`Checked`, tone: 'info' };
      case 'running':
        return { label: t`Importing`, tone: 'info' };
      case 'done':
        return { label: t`Imported`, tone: 'ok' };
      case 'failed':
        return { label: t`Stopped`, tone: 'warn' };
      default:
        return { label: t`Cancelled`, tone: 'neutral' };
    }
  };
}

function RecentImports({ locationId }: { locationId: string }) {
  const { t } = useLingui();
  const runs = useImportRuns(locationId);
  const f = useFormat();
  const statusOf = useRunStatusLabel();
  const items = (runs.data?.items ?? []).slice(0, 5);
  if (items.length === 0) return null;
  return (
    <section className="grid gap-2" aria-labelledby="import-recent">
      <h2 id="import-recent" className="m-0 font-semibold text-[17px]">
        <Trans>Recent imports here</Trans>
      </h2>
      <ul
        aria-label={t`Recent imports here`}
        className="m-0 grid list-none overflow-hidden rounded-[10px] border border-line bg-surface p-0"
      >
        {items.map((run) => {
          const status = statusOf(run);
          const total = run.total ?? 0;
          const done = f.num(run.progress);
          const of = f.num(total);
          return (
            <li key={run.id} className="border-line not-first:border-t">
              <Link
                to="/settings/import"
                search={{ location: locationId, run: run.id }}
                className="flex min-h-14 items-center gap-3 px-3.5 py-2.5 text-ink outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info"
              >
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="font-medium">{f.dateTime(run.createdAt)}</span>
                  <span className="text-small text-ink-2">
                    {run.status === 'running' || run.status === 'failed' ? (
                      <Trans>
                        {done} of {of} rows
                      </Trans>
                    ) : (
                      <Plural value={total} one="# row" other="# rows" />
                    )}
                  </span>
                </span>
                <Pill tone={status.tone}>{status.label}</Pill>
                <ChevronEndIcon className="size-5 shrink-0 text-ink-3" />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
