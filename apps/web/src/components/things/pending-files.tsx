/**
 * Files chosen in a sheet before the record they belong to exists (a warranty's card, a loan's
 * condition photos): picked here, listed with Remove, and uploaded onto the new record once it's
 * saved (`attachAll`). The record's id comes back from the write, so nothing is uploaded for a
 * sheet that's cancelled.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { FileTrigger } from 'react-aria-components';
import type { AttachmentRole, AttachmentSubject } from '@/api/inventory/types';
import { CameraIcon, XIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { uploadAndAttach, useUploadErrorText } from './upload';

export function PendingFiles({
  files,
  onChange,
  label,
  accept,
  isDisabled = false,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  label: string;
  accept?: string[];
  isDisabled?: boolean;
}) {
  const { t } = useLingui();
  return (
    <div className="grid gap-1.5">
      <FileTrigger
        {...(accept ? { acceptedFileTypes: accept } : {})}
        allowsMultiple
        onSelect={(list) => onChange([...files, ...Array.from(list ?? [])])}
      >
        <Button
          variant="secondary"
          size="small"
          className="justify-self-start"
          isDisabled={isDisabled}
        >
          <CameraIcon className="size-4" />
          {label}
        </Button>
      </FileTrigger>
      {files.length ? (
        <ul className="m-0 grid list-none gap-1 p-0">
          {files.map((f, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: the files picked, in order
              key={i}
              className="flex items-center justify-between gap-2 text-small text-ink-2"
            >
              <bdi dir="auto" className="min-w-0 [overflow-wrap:anywhere]">
                {f.name}
              </bdi>
              <Button
                variant="ghost"
                size="small"
                aria-label={t`Remove ${f.name}`}
                onPress={() => onChange(files.filter((_, j) => j !== i))}
              >
                <XIcon className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <span className="text-small text-ink-3">
          <Trans>Optional.</Trans>
        </span>
      )}
    </div>
  );
}

/** Uploads each file onto the record; a failure is a toast, never a lost save. */
export function useAttachAll() {
  const { t } = useLingui();
  const errorText = useUploadErrorText();
  return async (
    files: File[],
    locationId: string,
    subject: AttachmentSubject,
    role: AttachmentRole,
  ): Promise<void> => {
    for (const file of files) {
      try {
        await uploadAndAttach({ file, locationId, subject, role });
      } catch (e) {
        toast({
          title: t`Couldn't upload ${file.name}`,
          description: errorText(e),
          tone: 'danger',
        });
      }
    }
  };
}
