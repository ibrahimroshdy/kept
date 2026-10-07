/**
 * Reads the person's hints when the signed-in app starts (D138: `GET /me/hints` once, then
 * shared through the query cache), so a hint that is due can show the moment its screen opens.
 * The app shell (components/app-shell.tsx) wraps every signed-in screen in it. Screens outside
 * the shell (the label print view) read the same query themselves through `useHint`.
 */
import type { ReactNode } from 'react';
import { useHints } from './use-hint';

export function HintsProvider({ children }: { children: ReactNode }) {
  useHints();
  return children;
}
