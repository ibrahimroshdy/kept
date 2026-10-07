/**
 * Where the ⌘K palette lives (screens §1: "⌘K opens the palette", desktop). This part is tiny and
 * always mounted in the signed-in frame: it listens for ⌘K / Ctrl+K (and for `openPalette()`, which
 * the top bar's "Search or jump to…" button calls) and loads the palette itself only the first
 * time it's opened, so the entry chunk never carries it (D80). The palette's "Add a thing" closes
 * it and opens the create sheet here (also loaded on first use), so the sheet outlives the palette.
 */
import { lazy, Suspense, useEffect, useState } from 'react';

const Palette = lazy(() => import('./palette'));
const CreateThingSheet = lazy(() =>
  import('@/components/things/create-sheet').then((m) => ({ default: m.CreateThingSheet })),
);

const EVENT = 'kept:palette';

/** Open the palette from anywhere (a button, a menu). */
export function openPalette(): void {
  window.dispatchEvent(new Event(EVENT));
}

/** ⌘K on Apple platforms, Ctrl+K elsewhere; either works everywhere. */
export function isPaletteShortcut(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k';
}

export function PaletteHost() {
  const [open, setOpen] = useState(false);
  /** The location a new thing starts in, while the create sheet is open. */
  const [adding, setAdding] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPaletteShortcut(e)) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(EVENT, onOpen);
    };
  }, []);
  if (!open && !adding) return null;
  return (
    <Suspense fallback={null}>
      {open ? (
        <Palette
          onClose={() => setOpen(false)}
          onAddThing={(locationId) => {
            setOpen(false);
            setAdding(locationId);
          }}
        />
      ) : null}
      {adding ? (
        <CreateThingSheet isOpen onClose={() => setAdding(null)} locationId={adding} />
      ) : null}
    </Suspense>
  );
}
