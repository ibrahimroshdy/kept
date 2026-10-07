/**
 * An archive's upload (plan T19 step 2; D157, §3.1b, Q18): the person picks the `.zip` their old
 * Homebox or Kept made; a file over 5 GB is refused here, before anything is sent. The SHA-256 is
 * computed on the device first (in a worker, sha256.ts), then the run is declared
 * (`POST /imports/archive`) and the file sent in one `PUT …/archive` with a progress bar
 * (XMLHttpRequest: fetch reports no upload progress). The run joins the URL only once the bytes
 * have arrived, so a reload or an error starts the upload again from the beginning, cleanly.
 *
 * Leaving the page while it hashes or uploads asks first, with Kept's own confirm; closing the tab
 * gets the browser's own question, never text of ours.
 */
import { type ArchiveSource, newId, ZIP_LIMITS } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useBlocker } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { DropZone, FileTrigger, ProgressBar } from 'react-aria-components';
import { ApiError, isApiError } from '@/api/client';
import { portabilityPaths } from '@/api/portability/paths';
import { portabilityApi } from '@/api/portability/queries';
import type { ArchiveImportRun } from '@/api/portability/types';
import { DocumentIcon } from '@/components/icons';
import { Notice, useErrorText } from '@/components/page';
import { useFileSize } from '@/components/portability/size';
import { errorFrom, nativeFetch, xhrPut } from '@/components/things/upload';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { cn } from '@/lib/utils';
import { useRefusalText } from './labels';
import { hashFile } from './sha256';
import { StepFooter, StepHeader } from './step-chrome';

export const ARCHIVE_STEPS = 6;
const ZIP_TYPES = ['application/zip', 'application/x-zip-compressed', '.zip'];

type Phase =
  | { kind: 'idle' }
  | { kind: 'hashing'; fraction: number }
  | { kind: 'uploading'; fraction: number }
  | { kind: 'failed'; message: string };

/** `PUT /imports/:id/archive`: through XMLHttpRequest for its progress, or `fetch` where the
 * demo and the tests have put the mock in its place (things/upload.tsx's rule). */
export async function uploadArchive(
  id: string,
  file: Blob,
  sha256: string,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<ArchiveImportRun> {
  const url = portabilityPaths.importArchive(id);
  const headers = { 'content-type': 'application/zip', 'x-kept-sha256': sha256 };
  onProgress(0);
  if (nativeFetch()) return xhrPut<ArchiveImportRun>(url, file, headers, onProgress, signal);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      credentials: 'include',
      headers: { ...headers, 'content-length': String(file.size) },
      body: file,
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new ApiError(0, 'offline', 'Needs a connection');
  }
  const text = await res.text();
  if (!res.ok) throw errorFrom(res.status, text);
  onProgress(1);
  return JSON.parse(text) as ArchiveImportRun;
}

/** Why a chosen file can't be sent, before anything is: not a ZIP, empty, or over 5 GB. */
export function useFileProblem() {
  const { t } = useLingui();
  const f = useFormat();
  const size = useFileSize();
  return (file: File): string | null => {
    const zip = /\.zip$/i.test(file.name) || ZIP_TYPES.includes(file.type);
    if (!zip) return t`Choose the .zip file the export made.`;
    if (file.size === 0) return t`This file is empty.`;
    if (file.size > ZIP_LIMITS.archiveBytes) {
      const bytes = size(file.size);
      const gb = f.num(5);
      return t`This file is ${bytes}; an import takes at most ${gb} GB.`;
    }
    return null;
  };
}

export function ArchiveStep({
  source,
  onBack,
  onUploaded,
}: {
  source: ArchiveSource;
  onBack: () => void;
  /** The run, once its archive arrived whole. */
  onUploaded: (run: ArchiveImportRun) => void;
}) {
  const { t } = useLingui();
  const online = useOnline();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const refusal = useRefusalText();
  const problemOf = useFileProblem();
  const size = useFileSize();
  const f = useFormat();
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const busy = useRef(false);
  const abort = useRef<AbortController | null>(null);

  useBlocker({
    shouldBlockFn: async () => {
      if (!busy.current) return false;
      const leave = await confirm({
        title: t`Stop the upload?`,
        body: t`Nothing has been imported yet. To import this file later, choose it again.`,
        confirmLabel: t`Stop and leave`,
        cancelLabel: t`Keep uploading`,
        destructive: true,
      });
      if (!leave) return true;
      busy.current = false;
      abort.current?.abort();
      return false;
    },
    enableBeforeUnload: () => busy.current,
  });

  const failure = (e: unknown): string => {
    if (isApiError(e)) {
      if (e.code === 'offline')
        return t`Needs a connection. Choose the file again when you're back online.`;
      if (e.status === 413) return refusal('too_large') ?? t`This archive is too large to import.`;
      if (e.code === 'checksum_mismatch')
        return t`The file changed while it was being sent. Choose it again.`;
    }
    return errorText(e);
  };

  const send = async (chosen: File) => {
    busy.current = true;
    abort.current = new AbortController();
    try {
      setPhase({ kind: 'hashing', fraction: 0 });
      const sha256 = await hashFile(chosen, (fraction) => setPhase({ kind: 'hashing', fraction }));
      if (!busy.current) return;
      const id = newId();
      await portabilityApi.createArchiveImport({ id, source, bytes: chosen.size, sha256 });
      setPhase({ kind: 'uploading', fraction: 0 });
      const run = await uploadArchive(
        id,
        chosen,
        sha256,
        (fraction) => setPhase({ kind: 'uploading', fraction }),
        abort.current.signal,
      );
      busy.current = false;
      onUploaded(run);
    } catch (e) {
      if (!busy.current || (e instanceof DOMException && e.name === 'AbortError')) return;
      busy.current = false;
      setPhase({
        kind: 'failed',
        message:
          e instanceof Error && e.message === 'unreadable'
            ? t`This file can't be read any more. Choose it again.`
            : failure(e),
      });
    }
  };

  const choose = (chosen: File | undefined) => {
    if (!chosen || busy.current) return;
    const why = problemOf(chosen);
    setFile(why ? null : chosen);
    setProblem(why);
    setPhase({ kind: 'idle' });
    if (!why) void send(chosen);
  };

  const working = phase.kind === 'hashing' || phase.kind === 'uploading';
  const percent = working ? f.num(Math.round(phase.fraction * 100)) : '';

  return (
    <div className="grid gap-5">
      <StepHeader
        step={2}
        total={ARCHIVE_STEPS}
        title={
          source === 'homebox_zip' ? (
            <Trans>The Homebox export</Trans>
          ) : (
            <Trans>The Kept export</Trans>
          )
        }
      />

      {file ? (
        <div className="grid gap-3 rounded-[10px] border border-line bg-surface p-3.5">
          <div className="flex items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-sunken text-ink-2 [&_svg]:size-5">
              <DocumentIcon />
            </span>
            <span className="grid min-w-0 flex-1 gap-0.5">
              <bdi className="font-semibold [overflow-wrap:anywhere]">{file.name}</bdi>
              <span className="text-small text-ink-2">{size(file.size)}</span>
            </span>
          </div>
          {working ? (
            <ProgressBar
              aria-label={phase.kind === 'hashing' ? t`Checking the file` : t`Uploading`}
              value={phase.fraction * 100}
              valueLabel={`${percent}%`}
              className="grid gap-1.5"
            >
              {({ percentage }) => (
                <>
                  <span className="text-small text-ink-2">
                    {phase.kind === 'hashing' ? (
                      <Trans>
                        Checking it on this device{f.sep}
                        {percent}%
                      </Trans>
                    ) : (
                      <Trans>
                        Uploading{f.sep}
                        {percent}%
                      </Trans>
                    )}
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
          ) : null}
        </div>
      ) : null}

      {phase.kind === 'failed' ? (
        <Notice
          tone="danger"
          title={<Trans>The upload didn't finish</Trans>}
          action={
            file ? (
              <Button variant="secondary" isDisabled={!online} onPress={() => void send(file)}>
                <Trans>Try again</Trans>
              </Button>
            ) : null
          }
        >
          {phase.message}
        </Notice>
      ) : null}
      {problem ? (
        <Notice tone="danger" title={<Trans>This file can't be imported</Trans>}>
          {problem}
        </Notice>
      ) : null}

      {!working ? (
        <DropZone
          getDropOperation={(types) =>
            ZIP_TYPES.some((type) => types.has(type)) ? 'copy' : 'cancel'
          }
          onDrop={async (e) => {
            const item = e.items.find((i) => i.kind === 'file');
            if (item && item.kind === 'file') choose(await item.getFile());
          }}
          isDisabled={!online}
          className={({ isDropTarget }) =>
            cn(
              'grid justify-items-center gap-3 rounded-[10px] border border-dashed border-line px-5 py-8 text-center outline-none',
              isDropTarget && 'border-ink bg-sunken',
            )
          }
        >
          <span className="max-w-md text-small text-ink-2">
            {online ? (
              <Trans>
                Up to 5 GB. Nothing is imported until you've seen what's in it and checked it.
              </Trans>
            ) : (
              <Trans>Needs a connection</Trans>
            )}
          </span>
          <FileTrigger acceptedFileTypes={ZIP_TYPES} onSelect={(files) => choose(files?.[0])}>
            <Button isDisabled={!online} variant={file ? 'secondary' : 'primary'}>
              {file ? <Trans>Choose another file</Trans> : <Trans>Choose the .zip file</Trans>}
            </Button>
          </FileTrigger>
        </DropZone>
      ) : null}

      {source === 'homebox_zip' ? (
        <Notice tone="info" title={<Trans>If Homebox says "Topic has been Shutdown"</Trans>}>
          <Trans>Restart Homebox and export again: v0.26 exports once each time it starts.</Trans>
        </Notice>
      ) : (
        <Notice tone="info">
          <Trans>
            A Kept export always comes in as a new location, with its photos, documents, history and
            printed labels.
          </Trans>
        </Notice>
      )}

      <StepFooter>
        <Button variant="secondary" onPress={onBack}>
          <Trans>Back</Trans>
        </Button>
      </StepFooter>
    </div>
  );
}
