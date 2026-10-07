/**
 * The assistant docked beside the page, from 768 px (D24; screens §1, frame 04 · 6): a side panel
 * at the inline end that stays open as you move between pages and knows the page you're on
 * ("About Garage", removable). Threads, a new thread, and Close. It's a complementary landmark,
 * not a modal: the page stays usable beside it. The icon rail's collapse doesn't hide it (D198).
 * Escape inside it closes it, and focus goes back to the header button.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { AssistantIcon, ChevronStartIcon, PlusIcon, XIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ASSISTANT_PANEL_ID } from './button';
import { usePageContext } from './context';
import { ContextChip } from './context-chip';
import { Conversation } from './conversation';
import { ThreadsIcon } from './icons';
import { headButton } from './sheet';
import { closeAssistant, showThread, showThreads, useAssistantUi } from './store';
import { ThreadsList } from './threads-list';

export function AssistantPanel() {
  const { t } = useLingui();
  const ui = useAssistantUi();
  const page = usePageContext();
  const showChip = page && page.key !== ui.removedContext;
  const threads = ui.view === 'threads';
  return (
    <aside
      id={ASSISTANT_PANEL_ID}
      aria-label={t`Assistant`}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault();
          closeAssistant();
        }
      }}
      className={cn(
        'sticky top-0 flex h-dvh w-[340px] shrink-0 flex-col border-line border-s bg-surface text-ink lg:w-[400px]',
        // Below 1280 px it floats over the page's end (lib/media.ts DOCKED), so the page keeps
        // its layout instead of squeezing under it.
        'max-xl:fixed max-xl:inset-y-0 max-xl:end-0 max-xl:z-40 max-xl:shadow-[0_0_24px_rgba(0,0,0,.18)]',
      )}
    >
      <div className="flex min-h-16 shrink-0 items-center gap-1 border-line border-b px-3">
        {threads ? (
          <button
            type="button"
            aria-label={t`Back to the conversation`}
            onClick={() => showThread(ui.threadId)}
            className={headButton}
          >
            <ChevronStartIcon />
          </button>
        ) : null}
        <h2 className="m-0 flex min-w-0 flex-1 items-center gap-2 ps-1 font-semibold text-[17px] [&_svg]:size-5">
          {threads ? (
            <Trans>Threads</Trans>
          ) : (
            <>
              <AssistantIcon />
              <Trans>Assistant</Trans>
            </>
          )}
        </h2>
        {threads ? null : (
          <Button variant="secondary" size="small" onPress={showThreads} className="min-h-9">
            <ThreadsIcon className="size-4" />
            <Trans>Threads</Trans>
          </Button>
        )}
        <button
          type="button"
          aria-label={t`New thread`}
          onClick={() => showThread(null)}
          className={headButton}
        >
          <PlusIcon />
        </button>
        <button
          type="button"
          aria-label={t`Close panel`}
          onClick={closeAssistant}
          className={headButton}
        >
          <XIcon />
        </button>
      </div>
      {threads ? (
        <div className="flex min-h-0 flex-1 flex-col pt-3">
          <ThreadsList currentId={ui.threadId} onOpen={showThread} />
        </div>
      ) : (
        <>
          {showChip ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pt-3 text-small text-ink-3">
              <span>
                <Trans>About</Trans>
              </span>
              <ContextChip page={page} />
            </div>
          ) : null}
          <Conversation threadId={ui.threadId} page={page} />
        </>
      )}
    </aside>
  );
}
