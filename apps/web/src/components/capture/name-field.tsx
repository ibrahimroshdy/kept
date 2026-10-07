/**
 * The name under the viewfinder (D194; screens §5). With AI capture off in the target location
 * nothing will name a photo, so it is the primary input, labelled "Name"; with AI on it is
 * "Name (optional)" and an unnamed draft shows "Naming…" until extraction finishes. RECEIPT and
 * READING modes take a note instead. OS keyboard dictation works in it, and so does the in-app
 * mic where the browser has a recogniser (D25, step 6: assistant/dictation.ts, the composer's).
 *
 * Enter with a name and no photo saves the thing by name alone (D19: a photo or a name).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect } from 'react';
import { Button, FieldError, Input, TextField } from 'react-aria-components';
import { useDictation } from '@/assistant/dictation';
import { MicIcon } from '@/components/icons';
import { toast } from '@/components/ui/toast';

export function NameField({
  value,
  onChange,
  onSubmit,
  kind,
  aiOn,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Enter, or "Add": save by name without a photo. */
  onSubmit: () => void;
  kind: 'name' | 'note';
  aiOn: boolean;
  error: string | null;
}) {
  const { t, i18n } = useLingui();
  const label = kind === 'note' ? t`Note (optional)` : aiOn ? t`Name (optional)` : t`Name`;
  const dictation = useDictation({ locale: i18n.locale, onText: onChange });
  useEffect(() => {
    if (dictation.deniedNow)
      toast({
        title: t`Kept can't use the microphone`,
        description: t`Allow it in the browser's settings, or type instead.`,
        tone: 'danger',
      });
  }, [dictation.deniedNow, t]);
  return (
    <TextField
      aria-label={label}
      value={value}
      onChange={onChange}
      isRequired={kind === 'name' && !aiOn}
      isInvalid={error !== null}
      maxLength={kind === 'note' ? 500 : 200}
      className="mx-3 mt-2.5 grid gap-1"
    >
      <div className="flex min-h-12 items-center gap-1.5 rounded-xl border border-[#34302A] bg-[#1E1C19] ps-3.5 pe-1 focus-within:border-[#F2EFE9]">
        <Input
          placeholder={label}
          enterKeyHint={kind === 'name' ? 'done' : 'enter'}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && kind === 'name') {
              e.preventDefault();
              onSubmit();
            }
          }}
          className="min-h-11 min-w-0 flex-1 bg-transparent text-[#F2EFE9] text-[15px] outline-none placeholder:text-[#9A948A]"
        />
        {dictation.available ? (
          <Button
            aria-label={dictation.listening ? t`Stop dictation` : t`Dictate`}
            aria-pressed={dictation.listening}
            onPress={() => dictation.toggle(value)}
            className={`grid size-11 shrink-0 cursor-pointer place-items-center rounded-[10px] outline-none data-focus-visible:outline-2 data-focus-visible:outline-[#F2EFE9] [&_svg]:size-[22px] ${
              dictation.listening ? 'bg-[#C2410C] text-[#F2EFE9]' : 'text-[#F2EFE9]'
            }`}
          >
            <MicIcon />
          </Button>
        ) : null}
        {kind === 'name' && value.trim() ? (
          <Button
            onPress={onSubmit}
            className="min-h-11 cursor-pointer rounded-[10px] px-3 font-semibold text-[#F2EFE9] text-[14px] outline-none data-focus-visible:outline-2 data-focus-visible:outline-[#F2EFE9]"
          >
            <Trans>Add</Trans>
          </Button>
        ) : null}
      </div>
      <FieldError className="text-[#F2B8A8] text-[13px]">{error}</FieldError>
    </TextField>
  );
}
