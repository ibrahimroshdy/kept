/**
 * The composer (screens §5 "Assistant", §3 and §8; D25, D206, D213): a text area with the mic and
 * Send. Enter sends, Shift+Enter starts a new line.
 *
 * - Disabled with the reason (screens §3): offline ("Needs a connection"), paused ("AI paused
 *   until 1 Oct · Home's monthly cap reached"), no provider ("Connect AI in Settings" for whoever
 *   manages AI, "AI isn't set up here" for everyone else), or the module off in the context's
 *   location ("Off in this location"). The reason is the caller's (./conversation.tsx).
 * - While a turn is live, Send waits (one at a time); typing the next question still works.
 * - The mic (./dictation.ts) shows only where the browser has a recogniser; listening, it reads
 *   "Stop dictation" and the words appear in the field as they're heard. A refused microphone is
 *   said once.
 */
import { TURN_LIMITS } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { type ReactNode, useEffect, useRef } from 'react';
import { TextArea, TextField } from 'react-aria-components';
import { MicIcon } from '@/components/icons';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { useDictation } from './dictation';
import { SendIcon, StopIcon } from './icons';

export function Composer({
  value,
  onChange,
  onSend,
  disabled,
  waiting,
  focusSignal,
  note,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: (text: string) => void;
  /** Why asking isn't possible now; null when it is. */
  disabled: ReactNode | null;
  /** A turn is live or a question is on its way: Send waits. */
  waiting: boolean;
  /** Bumped to take focus (opening, a hand-off from ⌘K). */
  focusSignal: number;
  /** A line under the field ("Enter to send · this thread is private to you", the viewer's). */
  note?: ReactNode;
}) {
  const { t, i18n } = useLingui();
  const field = useRef<HTMLTextAreaElement>(null);
  const dictation = useDictation({ locale: i18n.locale, onText: onChange });
  const text = value.trim();
  const canSend = !disabled && !waiting && text.length > 0;

  useEffect(() => {
    if (dictation.deniedNow)
      toast({
        title: t`Kept can't use the microphone`,
        description: t`Allow it in the browser's settings, or type instead.`,
        tone: 'danger',
      });
  }, [dictation.deniedNow, t]);

  useEffect(() => {
    if (!focusSignal) return;
    // After a closing palette or sheet has put focus back where it was.
    const id = setTimeout(() => {
      const el = field.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 60);
    return () => clearTimeout(id);
  }, [focusSignal]);

  // Grow with the text, up to about six lines.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resize when the text changes
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  const send = () => {
    if (!canSend) return;
    if (dictation.listening) dictation.stop();
    onSend(text);
  };

  return (
    <div className="grid gap-1.5">
      {disabled ? (
        <p role="status" className="m-0 text-small text-ink-2 [text-wrap:pretty]">
          {disabled}
        </p>
      ) : null}
      <TextField
        aria-label={t`Ask about your things`}
        value={value}
        onChange={onChange}
        isDisabled={!!disabled}
        maxLength={TURN_LIMITS.maxQuestionChars}
        className={cn(
          'flex min-h-[54px] items-end gap-1 rounded-[14px] border border-line bg-paper py-1 pe-1 ps-3.5 focus-within:border-ink',
          disabled && 'opacity-60',
        )}
      >
        <TextArea
          ref={field}
          rows={1}
          dir="auto"
          placeholder={t`Ask about your things`}
          enterKeyHint="send"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          className="min-h-11 min-w-0 flex-1 resize-none self-center bg-transparent py-2.5 text-[15px] text-ink leading-snug outline-none placeholder:text-ink-3"
        />
        {dictation.available && !disabled ? (
          <button
            type="button"
            aria-label={dictation.listening ? t`Stop dictation` : t`Dictate`}
            aria-pressed={dictation.listening}
            onClick={() => dictation.toggle(value)}
            className={cn(
              'grid size-11 shrink-0 cursor-pointer place-items-center rounded-[11px] outline-none focus-visible:outline-2 focus-visible:outline-info [&_svg]:size-[22px]',
              dictation.listening ? 'bg-danger text-surface' : 'text-ink-2 hover:bg-sunken',
            )}
          >
            {dictation.listening ? <StopIcon /> : <MicIcon />}
          </button>
        ) : null}
        <button
          type="button"
          aria-label={t`Send`}
          aria-disabled={!canSend}
          onClick={send}
          className={cn(
            'grid size-11 shrink-0 place-items-center rounded-[11px] outline-none focus-visible:outline-2 focus-visible:outline-info [&_svg]:size-[22px]',
            canSend
              ? 'cursor-pointer bg-amber text-amber-ink'
              : 'cursor-default bg-sunken text-ink-3',
          )}
        >
          <SendIcon />
        </button>
      </TextField>
      {dictation.listening ? (
        <p role="status" className="m-0 text-small text-ink-2">
          <Trans>Listening… tap the mic again to stop.</Trans>
        </p>
      ) : note ? (
        <p className="m-0 text-small text-ink-3">{note}</p>
      ) : null}
    </div>
  );
}
