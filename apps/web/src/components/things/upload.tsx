/**
 * Uploads (task 17's wire format, D117, D157). A file is hashed in the browser first
 * (`crypto.subtle.digest('SHA-256')`), then sent as the raw body of `PUT /files/:id` with
 * `X-Kept-Sha256`, so the server can prove it stored the bytes untouched; then it is attached to
 * its subject with `POST /attachments`. The file id is chosen here (a UUIDv7), so a retry is a
 * replay the server answers with the same file.
 *
 * Progress needs XMLHttpRequest (fetch has no upload progress over HTTP/1.1). When `fetch` has
 * been replaced (the demo and the tests route it to the in-memory mock), the upload goes through
 * `fetch` instead and reports 0 → 1.
 *
 * HEIC/HEIF is accepted and stored; the server can't make a preview of it yet (D36), so it shows
 * "Preview unavailable", never an error.
 */
import { isErrorCode, newId } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { FileTrigger, ProgressBar } from 'react-aria-components';
import { ApiError, api, isApiError } from '@/api/client';
import { inventoryPaths } from '@/api/inventory/paths';
import { fileUploadPath } from '@/api/inventory/thing-api';
import type {
  AttachmentRole,
  AttachmentSubject,
  AttachmentView,
  FileClass,
  FileView,
} from '@/api/inventory/types';
import { CameraIcon } from '@/components/icons';
import { useErrorText } from '@/components/page';
import { Button, type ButtonVariant } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';

/** The file's SHA-256 as 64 lower-case hex characters. */
export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fileClassOf(mime: string): FileClass {
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

export const isHeic = (mime: string) => /^image\/hei[cf]/i.test(mime);

/** Whether `fetch` is the browser's own (the demo and the tests replace it with the mock). */
export function nativeFetch(): boolean {
  try {
    return (
      typeof XMLHttpRequest !== 'undefined' &&
      /\[native code\]/.test(Function.prototype.toString.call(globalThis.fetch))
    );
  } catch {
    return false;
  }
}

export function errorFrom(status: number, text: string): ApiError {
  let b: Record<string, unknown> = {};
  try {
    b = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Not JSON: the status says enough.
  }
  const { error, hint, code, ...details } = b;
  const known = typeof code === 'string' && isErrorCode(code) ? code : null;
  return new ApiError(
    status,
    known ?? (status === 0 ? 'offline' : status >= 500 ? 'internal' : 'validation'),
    typeof error === 'string' ? error : `HTTP ${status}`,
    {
      ...(typeof hint === 'string' ? { hint } : {}),
      details,
      ...(typeof code === 'string' && !known ? { serverCode: code } : {}),
    },
  );
}

/** A PUT with upload progress; also the import archive's upload (import/archive-step.tsx). */
export function xhrPut<T = FileView>(
  url: string,
  file: Blob,
  headers: Record<string, string>,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.withCredentials = true;
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText) as T);
      else reject(errorFrom(xhr.status, xhr.responseText));
    };
    xhr.onerror = () => reject(new ApiError(0, 'offline', 'Needs a connection'));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

export type UploadInput = {
  file: File;
  locationId: string;
  fileId?: string;
  onProgress?: (fraction: number) => void;
};

/** Hash, then `PUT /files/:id`. A per-location duplicate answers 200 with `deduplicatedFrom`. */
export async function putFile({
  file,
  locationId,
  fileId = newId(),
  onProgress = () => {},
}: UploadInput): Promise<FileView> {
  const sha256 = await sha256Hex(file);
  const mime = file.type || 'application/octet-stream';
  const url = fileUploadPath(fileId, locationId, fileClassOf(mime));
  const headers = { 'content-type': mime, 'x-kept-sha256': sha256 };
  onProgress(0);
  if (nativeFetch()) return xhrPut(url, file, headers, onProgress);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      credentials: 'include',
      // Browsers set Content-Length from the body; the mock reads it from here.
      headers: { ...headers, 'content-length': String(file.size) },
      body: file,
    });
  } catch {
    throw new ApiError(0, 'offline', 'Needs a connection');
  }
  const text = await res.text();
  if (!res.ok) throw errorFrom(res.status, text);
  onProgress(1);
  return JSON.parse(text) as FileView;
}

/**
 * Why an upload didn't go, calmly: the server takes 3 uploads at once per person (429) and has a
 * bounded queue for making previews (503), both with Retry-After; neither loses anything, the
 * person simply tries again in a moment.
 */
export function useUploadErrorText() {
  const { t } = useLingui();
  const errorText = useErrorText();
  return (e: unknown): string => {
    if (isApiError(e) && e.status === 429)
      return t`A few uploads are already on their way. Try this one again in a moment.`;
    if (isApiError(e) && e.status === 503 && e.code !== 'database_unavailable')
      return t`The server is busy making previews. Try again in a moment; nothing was lost.`;
    return errorText(e);
  };
}

/** Upload one file and attach it to its subject with a role. */
export async function uploadAndAttach({
  subject,
  role,
  ...input
}: UploadInput & { subject: AttachmentSubject; role: AttachmentRole }): Promise<AttachmentView> {
  const file = await putFile(input);
  return api.post<AttachmentView>(inventoryPaths.attachments, {
    id: newId(),
    locationId: input.locationId,
    fileId: file.id,
    subject,
    role,
  });
}

/**
 * A button that picks files and uploads each one, with a progress bar while it runs. HEIC gets
 * an informational toast ("Preview unavailable"), never an error.
 */
export function UploadButton({
  locationId,
  subject,
  attachAs,
  label,
  accept,
  variant = 'secondary',
  onUploaded,
}: {
  locationId: string;
  subject: AttachmentSubject;
  /** The attachment's role (photo, receipt, manual, …). */
  attachAs: AttachmentRole;
  label: string;
  accept?: string[];
  variant?: ButtonVariant;
  onUploaded?: (a: AttachmentView) => void;
}) {
  const { t } = useLingui();
  const errorText = useUploadErrorText();
  const [progress, setProgress] = useState<number | null>(null);
  const run = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      try {
        setProgress(0);
        const a = await uploadAndAttach({
          file,
          locationId,
          subject,
          role: attachAs,
          onProgress: setProgress,
        });
        onUploaded?.(a);
        if (isHeic(file.type) || a.file?.derivativeState === 'unavailable')
          toast({
            title: t`Saved. Preview unavailable`,
            description: t`This phone format can't be previewed yet. The original is kept.`,
          });
      } catch (e) {
        toast({
          title: t`Couldn't upload ${file.name}`,
          description: errorText(e),
          tone: 'danger',
        });
      } finally {
        setProgress(null);
      }
    }
  };
  return (
    <div className="grid gap-1.5">
      <FileTrigger
        {...(accept ? { acceptedFileTypes: accept } : {})}
        allowsMultiple
        onSelect={(files) => void run(files)}
      >
        <Button variant={variant} size="small" isPending={progress !== null}>
          <CameraIcon className="size-4" />
          {label}
        </Button>
      </FileTrigger>
      {progress !== null ? (
        <ProgressBar
          aria-label={t`Uploading`}
          value={Math.round(progress * 100)}
          className="grid gap-1"
        >
          {({ percentage }) => (
            <>
              <span className="text-small text-ink-3">
                <Trans>Uploading…</Trans>
              </span>
              <span className="h-1.5 overflow-hidden rounded-full bg-sunken">
                <span
                  className="block h-full bg-amber transition-[width]"
                  style={{ width: `${percentage ?? 0}%` }}
                />
              </span>
            </>
          )}
        </ProgressBar>
      ) : null}
    </div>
  );
}
