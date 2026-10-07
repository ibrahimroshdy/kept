/**
 * The assistant's body, the same in the phone's sheet, the desktop's docked panel and the
 * `/assistant/<thread>` page: the thread (./thread.tsx) scrolling above the composer
 * (./composer.tsx). It works out why asking isn't possible right now (screens §3, D206, D191),
 * carries the page's context with each question (D24), and says the viewer's line (D123).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useAiStatus } from '@/api/capture/queries';
import { isApiError } from '@/api/client';
import { useLocations } from '@/api/queries';
import { usePausedUntil, usePauseReason } from '@/components/ai/paused-banner';
import { AssistantIcon } from '@/components/icons';
import { Notice, useErrorText } from '@/components/page';
import { sep } from '@/lib/format';
import { useKeyHints } from '@/lib/key-hints';
import { useOnline } from '@/lib/online';
import { assistantOff } from './button';
import { Composer } from './composer';
import { contextBody, type PageContext } from './context';
import { assistantStore, setDraft, useAssistantUi } from './store';
import { ThreadView } from './thread';
import { useConversation } from './use-turn';

export function Conversation({
  threadId,
  page,
  onNavigate,
}: {
  threadId: string | null;
  /** The page the assistant was opened over, or null (the `/assistant` pages have none). */
  page: PageContext | null;
  onNavigate?: () => void;
}) {
  const { t } = useLingui();
  const ui = useAssistantUi();
  const online = useOnline();
  const keys = useKeyHints();
  const errorText = useErrorText();
  const pausedUntil = usePausedUntil();
  const pauseReason = usePauseReason();
  const conversation = useConversation(threadId);
  const { ask, thread } = conversation;
  const context = contextBody(page, ui.removedContext);
  // Whose AI answers: the context's location; a thread already about one keeps it.
  const locationId =
    (context.kind !== 'none' ? page?.locationId : undefined) ??
    thread.data?.thread.context.locationId ??
    null;
  const locations = useLocations();
  const location = locationId ? locations.data?.find((l) => l.id === locationId) : undefined;
  const ai = useAiStatus(locationId);

  let disabled: ReactNode | null = null;
  if (!online) disabled = <Trans>Needs a connection</Trans>;
  else if (location && assistantOff(location)) disabled = <Trans>Off in this location</Trans>;
  else if (ai.data?.pausedUntil)
    disabled = `${pausedUntil(ai.data.pausedUntil)}${sep()}${pauseReason(ai.data)}`;
  else if (locationId && ai.data && !ai.data.resolved)
    disabled = ai.data.canManage ? (
      <Link
        to="/settings/ai"
        onClick={onNavigate}
        className="font-semibold text-ink underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-info"
      >
        <Trans>Connect AI in Settings</Trans>
      </Link>
    ) : (
      <Trans>AI isn't set up here</Trans>
    );

  // What the last question was refused with, when the server knew more than the status did.
  // A pause or a missing provider holds only for the context it was refused in: another page's
  // location may well have AI (a refusal kept the composer shut everywhere before).
  const refused = ask.error;
  const sameContext =
    !!ask.variables && JSON.stringify(ask.variables.context) === JSON.stringify(context);
  // Asked from a page with no location, the status can't know whose AI would answer, so Send
  // was on: the refusal says why under the field, and Send waits until the question changes
  // (UI review steps 6–8, L1).
  let held = false;
  let refusal: ReactNode = null;
  if (refused && isApiError(refused)) {
    if (refused.code === 'ai_paused') {
      const until = (refused.details as { pausedUntil?: unknown }).pausedUntil;
      if (!disabled && sameContext)
        disabled = typeof until === 'string' ? pausedUntil(until) : t`AI paused`;
    } else if (refused.code === 'ai_unavailable') {
      if (!sameContext) {
        // Refused elsewhere: this context gets its own answer.
      } else if (locationId) {
        if (!disabled) disabled = <Trans>AI isn't set up here</Trans>;
      } else {
        held = ui.draft.trim() === (ask.variables?.text ?? '').trim();
        refusal = (
          <>
            <Trans>
              You have no AI of your own to answer here. Ask from a location's page, where its AI
              answers.
            </Trans>{' '}
            <Link
              to="/settings/ai"
              onClick={onNavigate}
              className="font-semibold text-ink underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-info"
            >
              <Trans>Connect AI in Settings</Trans>
            </Link>
          </>
        );
      }
    } else if (refused.code === 'turn_running')
      refusal = <Trans>The assistant is still answering here. Wait for it, or cancel it.</Trans>;
    else refusal = errorText(refused);
  } else if (refused) refusal = errorText(refused);

  const viewer = location?.role === 'viewer';
  const empty = conversation.messages.length === 0 && !ask.isPending;
  const send = (text: string, fromDraft = true) => {
    if (fromDraft) setDraft('');
    ask.mutate(
      { text, context },
      {
        onError: () => {
          // A refused question comes back into the field, unless something new was typed.
          if (fromDraft && !assistantStore.get().draft) setDraft(text);
        },
      },
    );
  };

  const privateNote = keys ? (
    <Trans>Enter to send · this thread is private to you</Trans>
  ) : (
    <Trans>This thread is private to you</Trans>
  );

  return (
    <div data-assistant="" className="grid min-h-0 flex-1 grid-rows-[1fr_auto]">
      <div className="min-h-0 overflow-y-auto overscroll-contain px-4 pt-2 pb-4">
        {threadId && thread.isPending ? null : empty ? (
          <EmptyIntro />
        ) : (
          <ThreadView
            conversation={conversation}
            locationId={locationId}
            pendingText={ask.isPending ? (ask.variables?.text ?? null) : null}
            onAskAgain={(q) => send(q, false)}
            {...(onNavigate ? { onNavigate } : {})}
          />
        )}
      </div>
      <div className="grid gap-2 border-line border-t px-4 pt-2.5 pb-[calc(0.875rem+env(safe-area-inset-bottom))] md:pb-3.5">
        {refusal ? <Notice tone="danger">{refusal}</Notice> : null}
        <Composer
          value={ui.draft}
          onChange={setDraft}
          onSend={(text) => send(text)}
          disabled={disabled}
          waiting={conversation.live || ask.isPending || held}
          focusSignal={ui.handoff + (ui.open ? 1 : 0)}
          note={
            viewer && empty ? <Trans>Viewers can ask; changes need an admin</Trans> : privateNote
          }
        />
      </div>
    </div>
  );
}

function EmptyIntro() {
  return (
    <div className="grid justify-items-start gap-3 pt-2 text-[14.5px] text-ink-2 leading-normal">
      <span className="grid size-10 place-items-center rounded-full bg-sunken text-ink-2 [&_svg]:size-5">
        <AssistantIcon />
      </span>
      <p className="m-0 [text-wrap:pretty]">
        <Trans>
          Ask where something is or what's due, or ask for a change. Nothing changes until you
          confirm the card Kept shows you.
        </Trans>
      </p>
      <p className="m-0 [text-wrap:pretty]">
        <Trans>
          Say or type a list, like “in the garage I have a drill, a ladder and two paint cans”, and
          add them all with one Confirm.
        </Trans>
      </p>
    </div>
  );
}
