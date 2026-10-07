/**
 * Picking files: Gallery (many photos, each becomes a THING capture: D140) and "Use the system
 * camera" (full sensor resolution for the evidence modes: plan Q20). Both are a file input the
 * button opens, the one way a web page reaches the photo library and the phone's camera app;
 * the input itself is hidden and never takes focus.
 */
import { useLingui } from '@lingui/react/macro';
import { type ReactNode, useRef } from 'react';
import { Button } from 'react-aria-components';
import { cn } from '@/lib/utils';

export function FilePick({
  children,
  onFiles,
  multiple = false,
  camera = false,
  accept = 'image/*',
  className,
  label,
}: {
  children: ReactNode;
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  /** Opens the camera app instead of the library (`capture=environment`). */
  camera?: boolean;
  accept?: string;
  className?: string;
  /** When the visible content isn't the name. */
  label?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        {...(label ? { 'aria-label': label } : {})}
        onPress={() => input.current?.click()}
        className={cn(
          'cursor-pointer outline-none data-focus-visible:outline-2 data-focus-visible:outline-offset-2 data-focus-visible:outline-[#F2EFE9]',
          className,
        )}
      >
        {children}
      </Button>
      <input
        ref={input}
        type="file"
        hidden
        tabIndex={-1}
        aria-hidden="true"
        accept={accept}
        multiple={multiple}
        {...(camera ? { capture: 'environment' as const } : {})}
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          e.currentTarget.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}

/** The ring-and-caption button beside the shutter (screens board, capture frames). */
export function SideButton({ icon, caption }: { icon: ReactNode; caption: ReactNode }) {
  return (
    <span className="grid justify-items-center gap-[5px] text-center font-medium text-[#F2EFE9] text-[12px] leading-tight">
      <span className="grid size-12 place-items-center rounded-xl border border-[#4A463F] bg-[#26231F] [&_svg]:size-[22px]">
        {icon}
      </span>
      {caption}
    </span>
  );
}

export function GalleryImport({
  onFiles,
  icon,
}: {
  onFiles: (files: File[]) => void;
  icon: ReactNode;
}) {
  const { t } = useLingui();
  return (
    <FilePick multiple onFiles={onFiles} className="justify-self-start rounded-xl">
      <SideButton icon={icon} caption={t`Gallery`} />
    </FilePick>
  );
}
