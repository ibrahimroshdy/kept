/**
 * "+ photo to this thing" (D175; screens §5, §8): pressed, the next shot attaches to the draft
 * just captured instead of making a new thing (a label shot then fills its brand, model and
 * serial). In RECEIPT mode it adds a page to the same receipt. One shot, then it lets go.
 */
import { useLingui } from '@lingui/react/macro';
import { ToggleButton } from 'react-aria-components';
import { PlusIcon } from '@/components/icons';

export function PhotoToThis({
  armed,
  onChange,
  receipt,
  available,
}: {
  armed: boolean;
  onChange: (armed: boolean) => void;
  /** RECEIPT mode: "+ page to this receipt". */
  receipt: boolean;
  /** There is a draft (or receipt) from this session to add to. */
  available: boolean;
}) {
  const { t } = useLingui();
  const caption = receipt ? t`+ page to this receipt` : t`+ photo to this thing`;
  return (
    <ToggleButton
      isSelected={armed && available}
      onChange={onChange}
      isDisabled={!available}
      className="group grid max-w-[104px] cursor-pointer justify-items-center gap-[5px] justify-self-end text-center font-medium text-[#F2EFE9] text-[12px] leading-tight outline-none data-disabled:cursor-not-allowed data-disabled:opacity-50 data-focus-visible:outline-2 data-focus-visible:outline-offset-2 data-focus-visible:outline-[#F2EFE9]"
    >
      <span className="grid size-12 place-items-center rounded-full border border-[#4A463F] bg-[#26231F] group-data-selected:border-amber group-data-selected:bg-amber group-data-selected:text-amber-ink [&_svg]:size-[22px]">
        <PlusIcon />
      </span>
      <span>{caption}</span>
      {!available ? (
        <span className="text-[#BDB7AC] text-[11px]">{t`Take a photo first`}</span>
      ) : null}
    </ToggleButton>
  );
}
