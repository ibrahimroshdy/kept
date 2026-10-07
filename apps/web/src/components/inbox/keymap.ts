/**
 * The inbox's fixed keyboard map (D175; screens §5 "Keyboard", §8 "Inbox keys"), from
 * @kept/shared's INBOX_KEYMAP. A key does nothing while a field, a menu or a dialog has focus, or
 * with Ctrl, ⌘ or Alt held (those belong to the browser and the palette); `/` and `F` stay the
 * filter strip's.
 *
 * `s` (split) is in the map for multi-item drafts, which ship in 1.x (D20, D130): no step-3 item
 * can be split, so it is neither handled nor listed.
 */
import { INBOX_KEYMAP, type InboxAction, type InboxKey } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { useEffect, useRef } from 'react';

/** The keys the inbox handles in step 3, in the order the shortcuts popover lists them. */
export const INBOX_KEYS: readonly InboxKey[] = [
  'j',
  'k',
  'a',
  'e',
  'm',
  't',
  'x',
  'shift+a',
  'y',
  'n',
  'l',
  'g',
  'd',
];

/** Whether the event came from somewhere typing or a popup owns the keys. */
export function isOwnedElsewhere(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null;
  if (!el) return false;
  if (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
  return !!el.closest(
    '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="combobox"]',
  );
}

/** The inbox action a key press asks for, or null. */
export function inboxActionOf(
  e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey' | 'target'>,
): InboxAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (isOwnedElsewhere(e.target)) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : '';
  if (!key) return null;
  const name = (e.shiftKey ? `shift+${key}` : key) as InboxKey;
  if (!INBOX_KEYS.includes(name)) return null;
  return INBOX_KEYMAP[name];
}

/** Calls `onAction` for inbox keys pressed anywhere on the page, while `enabled`. */
export function useInboxKeys(onAction: (action: InboxAction) => void, enabled = true) {
  const ref = useRef(onAction);
  ref.current = onAction;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const action = inboxActionOf(e);
      if (!action) return;
      e.preventDefault();
      ref.current(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/** What each key does, in words, for the "Keyboard shortcuts" popover. */
export function useKeyLabels(): Record<InboxAction, string> {
  const { t } = useLingui();
  return {
    next: t`Next`,
    previous: t`Previous`,
    accept: t`Accept`,
    edit: t`Edit`,
    move: t`Move`,
    set_type: t`Set type`,
    select: t`Select`,
    accept_selected: t`Accept the selected names`,
    confirm_field: t`Confirm the suggested value`,
    reject_field: t`Reject the suggested value`,
    link_receipt_line: t`Link a receipt line`,
    split: t`Split`,
    merge: t`Merge a duplicate`,
    drop: t`Discard or dismiss`,
  };
}

/** A key as it is printed on the keyboard: `shift+a` → ["Shift", "A"]. */
export function keyCaps(key: InboxKey): string[] {
  return key.split('+').map((k) => (k === 'shift' ? 'Shift' : k.toUpperCase()));
}
