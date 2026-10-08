/**
 * The assistant's open state (D24, screens §1 and §5): one small store outside React, so the
 * header button, ⌘K's hand-off (./open.ts), ⌘J and the sheet or docked panel all read and change
 * the same thing, and the panel survives route changes (it lives in the signed-in frame, not in a
 * page). It holds no thread content: that is the server's (api/assistant), cached by TanStack
 * Query. The draft lives here so a question half typed survives closing the sheet, and switching
 * between the phone's sheet and the desktop's panel when the window is resized.
 */
import { useSyncExternalStore } from 'react';

export type AssistantView = 'thread' | 'threads';

export type AssistantUi = {
  open: boolean;
  /** The thread on screen; null until the next question starts one. */
  threadId: string | null;
  view: AssistantView;
  /** The composer's text. */
  draft: string;
  /** Bumped when words are handed over (⌘K), so the composer takes focus with them. */
  handoff: number;
  /**
   * The page context the person removed (its key, ./context.ts), so asking from this page sends
   * `context: none`; another page brings its own chip back.
   */
  removedContext: string | null;
  /**
   * Where the panel docks (from 1280 px) it makes the sidebar its icon rail; expanding the sidebar
   * then floats the panel over the page's end instead (D216). Reset each time the panel opens.
   */
  floating: boolean;
};

const INITIAL: AssistantUi = {
  open: false,
  threadId: null,
  view: 'thread',
  draft: '',
  handoff: 0,
  removedContext: null,
  floating: false,
};

let state: AssistantUi = INITIAL;
const listeners = new Set<() => void>();
/** What had focus when the assistant opened, so closing it can give focus back. */
let opener: HTMLElement | null = null;

function set(patch: Partial<AssistantUi>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const assistantStore = {
  get: (): AssistantUi => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Back to the start (tests, sign-out). */
  reset(): void {
    opener = null;
    set(INITIAL);
  },
};

export function useAssistantUi(): AssistantUi {
  return useSyncExternalStore(assistantStore.subscribe, assistantStore.get, assistantStore.get);
}

function rememberOpener(): void {
  if (state.open || typeof document === 'undefined') return;
  const el = document.activeElement;
  opener = el instanceof HTMLElement && el !== document.body ? el : null;
}

/**
 * Open the assistant. With a question (⌘K's "Ask the assistant", D42) a new thread starts with
 * those words in the composer, unsent, so the person can still change them.
 */
export function openAssistant(question?: string): void {
  rememberOpener();
  const q = question?.trim().slice(0, 2000);
  set({
    open: true,
    view: 'thread',
    ...(state.open ? {} : { floating: false }),
    ...(q ? { threadId: null, draft: q, handoff: state.handoff + 1 } : {}),
  });
}

export function closeAssistant(): void {
  if (!state.open) return;
  set({ open: false });
  const back = opener;
  opener = null;
  // After the panel or sheet has gone: focus goes back where it was (the header button).
  if (back?.isConnected) setTimeout(() => back.focus(), 0);
}

export function toggleAssistant(): void {
  if (state.open) closeAssistant();
  else openAssistant();
}

/** Float the docked panel over the page (true), or dock it beside the page again (false). */
export function setAssistantFloating(floating: boolean): void {
  if (floating !== state.floating) set({ floating });
}

/** Show a thread (or, with null, a new one). */
export function showThread(threadId: string | null): void {
  set({ open: true, threadId, view: 'thread', ...(state.open ? {} : { floating: false }) });
}

export function showThreads(): void {
  set({ view: 'threads' });
}

export function setDraft(draft: string): void {
  if (draft !== state.draft) set({ draft });
}

export function removeContext(key: string | null): void {
  set({ removedContext: key });
}

/** ⌘J on Apple platforms, Ctrl+J elsewhere; either works everywhere (screens §1, D24). */
export function isAssistantShortcut(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'j';
}
