/**
 * The print view's frame (plan T28): signed in like the app (lib/signed-in-gate.ts), but
 * **without** the app shell, so a label sheet prints edge to edge with nothing around it. Paper
 * is white whatever the theme; the screen keeps the app's background around the sheets.
 */
import { createFileRoute, Outlet } from '@tanstack/react-router';
import { signedInGate } from '@/lib/signed-in-gate';

export const Route = createFileRoute('/_print')({
  beforeLoad: signedInGate,
  component: PrintFrame,
});

function PrintFrame() {
  return (
    <main className="min-h-dvh bg-paper print:min-h-0 print:bg-white">
      <Outlet />
    </main>
  );
}
