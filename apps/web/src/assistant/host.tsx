/**
 * Where the assistant lives (D24, screens §1): always mounted in the signed-in frame, beside the
 * page, so the docked panel survives route changes. This part is tiny and in the entry chunk: it
 * listens for ⌘J / Ctrl+J and loads the sheet or panel (./surface.tsx, on demand from
 * assets/household/, vite.config.ts) only once the assistant is first opened. The assistant needs
 * a connection anyway, so nothing of it is precached.
 *
 * ⌘J toggles it where the person isn't typing, and inside the assistant itself (its own composer).
 */
import { lazy, Suspense, useEffect } from 'react';
import { isAssistantShortcut, toggleAssistant, useAssistantUi } from './store';

const Surface = lazy(() => import('./surface'));

/** A field that takes text: ⌘J there is the field's (app-shell keeps the same rule for ⌘\). */
function isTextField(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement)
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file'].includes(el.type);
  return el.getAttribute('role') === 'textbox';
}

export function AssistantHost() {
  const { open } = useAssistantUi();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isAssistantShortcut(e)) return;
      const active = document.activeElement;
      const inside = active instanceof Element && !!active.closest('[data-assistant]');
      if (isTextField(active) && !inside) return;
      e.preventDefault();
      toggleAssistant();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <Surface />
    </Suspense>
  );
}
