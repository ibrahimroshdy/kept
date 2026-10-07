/**
 * Whether to mention keys ("press E", "esc", the inbox's shortcut list). A phone has no keys to
 * press, so its hints say "tap" instead (found on the maintainer's iPhone: "Needs a name: press
 * E, or Edit, to type one."). Keys are likely when the main pointer is a fine one that hovers (a
 * mouse or trackpad), or once a key is pressed outside a text field, which only a hardware
 * keyboard does (the on-screen one appears only in fields): an iPad with its keyboard gets the
 * hints from its first shortcut on.
 */
import { useEffect, useState } from 'react';
import { useMediaQuery } from './media';

export const FINE_POINTER = '(hover: hover) and (pointer: fine)';

let keyboardSeen = false;
const listeners = new Set<() => void>();

function isField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    !!target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
  );
}

function onKeyDown(e: KeyboardEvent): void {
  if (keyboardSeen || e.metaKey || e.ctrlKey || e.altKey || isField(e.target)) return;
  // Modifier and dead keys alone say little; a letter, digit, arrow, Tab or Escape says a
  // keyboard is there.
  if (e.key.length !== 1 && !/^(Arrow|Tab$|Escape$|Enter$)/.test(e.key)) return;
  keyboardSeen = true;
  for (const l of listeners) l();
}

/** Tests only: forget the keyboard. */
export function resetKeyboardSeen(): void {
  keyboardSeen = false;
}

/** True where keys are likely: a fine, hovering pointer, or a hardware keyboard seen. */
export function useKeyHints(): boolean {
  const fine = useMediaQuery(FINE_POINTER);
  const [seen, setSeen] = useState(keyboardSeen);
  useEffect(() => {
    const sync = () => setSeen(keyboardSeen);
    listeners.add(sync);
    if (listeners.size === 1) document.addEventListener('keydown', onKeyDown, true);
    sync();
    return () => {
      listeners.delete(sync);
      if (listeners.size === 0) document.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);
  return fine || seen;
}
