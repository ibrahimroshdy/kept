/**
 * Opening the assistant (D24, screens §1 and §5): from ⌘K's "Ask the assistant" with the words
 * typed so far (D42), and from the header button. The one seam both call: it opens the sheet
 * (phone) or the docked panel (768 px and up) with the question in the composer (./store.ts).
 */
import { openAssistant } from './store';

export { openAssistant };

export function useOpenAssistant(): (question?: string) => void {
  return openAssistant;
}
