/**
 * The assistant on a phone (D24; screens §1 and §5, frames 04 · 4 and 04 · 5): a tall bottom
 * sheet over the page it came from, with the page's context chip in its header (§8), Threads, a
 * new thread, and Close. Back closes it first (components/ui/close-on-back.tsx); following a link
 * in an answer closes it, so the page shows.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import { ChevronStartIcon, PlusIcon, XIcon } from '@/components/icons';
import { CloseOnBack } from '@/components/ui/close-on-back';
import { usePageContext } from './context';
import { ContextChip } from './context-chip';
import { Conversation } from './conversation';
import { ThreadsIcon } from './icons';
import { closeAssistant, showThread, showThreads, useAssistantUi } from './store';
import { ThreadsList } from './threads-list';

export const headButton =
  'grid size-11 shrink-0 cursor-pointer place-items-center rounded-[10px] text-ink-2 outline-none hover:bg-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-info [&_svg]:size-[22px]';

export function AssistantSheet() {
  const { t } = useLingui();
  const ui = useAssistantUi();
  const page = usePageContext();
  const showChip = page && page.key !== ui.removedContext;
  const threads = ui.view === 'threads';
  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) closeAssistant();
      }}
      className="fixed inset-0 z-50 flex items-end bg-black/35"
    >
      <Modal className="flex h-[90dvh] w-full flex-col rounded-t-2xl border border-line bg-surface text-ink shadow-[0_-10px_30px_rgba(0,0,0,.18)] outline-none">
        <CloseOnBack />
        <Dialog aria-label={t`Assistant`} className="flex min-h-0 flex-1 flex-col outline-none">
          <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line" />
          <div className="flex shrink-0 items-center gap-0.5 px-2 pt-1 pb-2">
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
            <Heading slot="title" className="m-0 min-w-0 flex-1 ps-2 font-semibold text-[17px]">
              {threads ? <Trans>Threads</Trans> : <Trans>Assistant</Trans>}
            </Heading>
            {!threads && showChip ? <ContextChip page={page} className="min-w-0 shrink" /> : null}
            {threads ? null : (
              <button
                type="button"
                aria-label={t`Threads`}
                onClick={showThreads}
                className={headButton}
              >
                <ThreadsIcon />
              </button>
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
              aria-label={t`Close`}
              onClick={closeAssistant}
              className={headButton}
            >
              <XIcon />
            </button>
          </div>
          {threads ? (
            <ThreadsList currentId={ui.threadId} onOpen={showThread} onNavigate={closeAssistant} />
          ) : (
            <Conversation threadId={ui.threadId} page={page} onNavigate={closeAssistant} />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
