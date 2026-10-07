/**
 * The assistant as it opens (./host.tsx loads this on demand): the docked panel from 768 px, the
 * bottom sheet below (D24, screens §1). One store (./store.ts) behind both, so a thread and a
 * half-typed question carry over when the window crosses the line.
 */
import { useMediaQuery, WIDE } from '@/lib/media';
import { AssistantPanel } from './panel';
import { AssistantSheet } from './sheet';

export default function AssistantSurface() {
  const wide = useMediaQuery(WIDE);
  return wide ? <AssistantPanel /> : <AssistantSheet />;
}
