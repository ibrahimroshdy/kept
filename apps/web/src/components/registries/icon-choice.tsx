/**
 * An icon field: the chosen icon and a button that opens the picker in a sheet. The picker is
 * `React.lazy` (./icon-picker), so its Lucide name list loads only when someone opens it (D80).
 * Picking an icon closes the sheet and returns focus to the button.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { lazy, Suspense, useId, useState } from 'react';
import { LoadingRows } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';

const IconPicker = lazy(() => import('./icon-picker'));

export function IconChoice({
  value,
  onChange,
  isDisabled = false,
  label,
}: {
  value: string;
  onChange: (icon: string) => void;
  isDisabled?: boolean;
  label?: string;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const labelId = useId();
  return (
    <div className="grid gap-1">
      <span id={labelId} className="font-medium text-[14px] text-ink-2">
        {label ?? t`Icon`}
      </span>
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="grid size-11 shrink-0 place-items-center rounded-lg border-2 border-ink bg-surface text-ink"
        >
          <TypeIcon icon={value} />
        </span>
        {isDisabled ? null : (
          <Button
            variant="secondary"
            size="small"
            aria-describedby={labelId}
            onPress={() => setOpen(true)}
          >
            <Trans>Change icon</Trans>
          </Button>
        )}
      </div>
      <Sheet isOpen={open} onOpenChange={setOpen} wide title={t`Choose an icon`}>
        {({ close }) => (
          <Suspense fallback={<LoadingRows rows={2} label={t`Loading icons`} />}>
            <IconPicker
              value={value}
              onChange={(icon) => {
                onChange(icon);
                close();
              }}
            />
          </Suspense>
        )}
      </Sheet>
    </div>
  );
}
