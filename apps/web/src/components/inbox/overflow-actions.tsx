/**
 * An inbox item's secondary actions (found on the maintainer's iPhone: Accept, Edit, Move and
 * Set type filled a row and Discard wrapped alone). From `md` up they are buttons in the item's
 * one row; on a phone they fold into **More**, a bottom sheet holding a React Aria Menu (arrow
 * keys move, Enter chooses, Escape closes; screens §5, the thing's action menu does the same).
 * Either way the item's keys (`m`, `t`, `d`, …, shell.tsx) still run them directly, so no second
 * row of controls (D211's rule) and no lost shortcut.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { Menu, MenuItem } from 'react-aria-components';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { useMediaQuery, WIDE } from '@/lib/media';
import { cn } from '@/lib/utils';

export type OverflowAction = {
  id: string;
  label: string;
  /** Its key in the inbox keymap, for `aria-keyshortcuts` ("M"). */
  keys?: string;
  /** Discard: a ghost button on the desktop, red in the phone's sheet. */
  danger?: boolean;
  onAction: () => void;
};

const itemClass =
  'flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-[15px] text-ink outline-none data-focused:bg-sunken data-disabled:cursor-default data-disabled:text-ink-3';

export function OverflowActions({
  actions,
  title,
  isDisabled = false,
}: {
  actions: OverflowAction[];
  /** The sheet's title: what the actions act on ("Unnamed thing"). */
  title: string;
  isDisabled?: boolean;
}) {
  const { t } = useLingui();
  const wide = useMediaQuery(WIDE);
  const [open, setOpen] = useState(false);
  if (actions.length === 0) return null;
  if (wide)
    return (
      <>
        {actions.map((a) => (
          <Button
            key={a.id}
            size="small"
            variant={a.danger ? 'ghost' : 'secondary'}
            isDisabled={isDisabled}
            {...(a.keys ? { 'aria-keyshortcuts': a.keys } : {})}
            onPress={a.onAction}
          >
            {a.label}
          </Button>
        ))}
      </>
    );
  return (
    <>
      <Button
        size="small"
        variant="secondary"
        isDisabled={isDisabled}
        aria-haspopup="dialog"
        onPress={() => setOpen(true)}
      >
        <Trans>More</Trans>
      </Button>
      <Sheet isOpen={open} onOpenChange={setOpen} title={title}>
        {({ close }) => (
          <Menu
            aria-label={t`More actions`}
            autoFocus="first"
            onAction={(key) => {
              close();
              actions.find((a) => a.id === key)?.onAction();
            }}
            className="grid gap-px p-1 outline-none"
          >
            {actions.map((a) => (
              <MenuItem
                key={a.id}
                id={a.id}
                textValue={a.label}
                className={cn(itemClass, a.danger && 'text-danger')}
              >
                {a.label}
              </MenuItem>
            ))}
          </Menu>
        )}
      </Sheet>
    </>
  );
}
