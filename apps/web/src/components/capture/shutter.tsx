/**
 * The shutter. Its name says what the next press does, so a screen reader hears the mode
 * (screens §4): "Take photo: new thing", "Take photo: receipt", "Take photo: add to Drill".
 */
import type { CaptureMode } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { Button } from 'react-aria-components';

export function useShutterLabel() {
  const { t } = useLingui();
  return (mode: CaptureMode, addTo: { name: string | null; receipt: boolean } | null) => {
    if (addTo?.receipt) return t`Take photo: another page of this receipt`;
    if (addTo) {
      const name = addTo.name;
      return name ? t`Take photo: add to ${name}` : t`Take photo: add to this thing`;
    }
    switch (mode) {
      case 'receipt':
        return t`Take photo: receipt`;
      case 'label':
        return t`Take photo: label`;
      case 'reading':
        return t`Take photo: reading`;
      default:
        return t`Take photo: new thing`;
    }
  };
}

export function Shutter({
  label,
  onPress,
  isDisabled = false,
}: {
  label: string;
  onPress: () => void;
  isDisabled?: boolean;
}) {
  return (
    <Button
      aria-label={label}
      onPress={onPress}
      isDisabled={isDisabled}
      className="grid size-[76px] cursor-pointer place-items-center rounded-full border-4 border-[#F2EFE9] bg-transparent p-0 outline-none data-disabled:cursor-not-allowed data-disabled:opacity-50 data-focus-visible:outline-2 data-focus-visible:outline-offset-4 data-focus-visible:outline-[#F2EFE9] data-pressed:scale-95 motion-reduce:data-pressed:scale-100"
    >
      <span aria-hidden="true" className="block size-[58px] rounded-full bg-amber" />
    </Button>
  );
}
