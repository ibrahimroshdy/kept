/**
 * The mode strip, THING · RECEIPT · LABEL · READING (D34): a labelled radio group, so arrow keys
 * move the choice (mirrored in Arabic) and a screen reader hears "radio, 2 of 4". A swipe across
 * the viewfinder changes it too (`swipeMode`). The last mode is remembered on this device. The
 * first time the camera opens, it carries the `capture.mode_strip` hint (D138).
 */
import { CAPTURE_MODES, type CaptureMode } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { useRef } from 'react';
import { Radio, RadioGroup } from 'react-aria-components';
import { useHint } from '@/components/hints/use-hint';

const KEY = 'kept.capture.mode';

export function storedMode(): CaptureMode {
  try {
    const v = localStorage.getItem(KEY);
    return (CAPTURE_MODES as readonly string[]).includes(v ?? '') ? (v as CaptureMode) : 'thing';
  } catch {
    return 'thing';
  }
}

export function rememberMode(mode: CaptureMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // No storage: Thing next time.
  }
}

/**
 * The mode a horizontal swipe lands on: a swipe towards the reading start goes forward, as the
 * strip scrolls. In Arabic the strip runs right to left, so the same finger goes the other way.
 */
export function swipeMode(mode: CaptureMode, dx: number, rtl: boolean): CaptureMode {
  const i = CAPTURE_MODES.indexOf(mode);
  const forward = rtl ? dx > 0 : dx < 0;
  const j = Math.min(CAPTURE_MODES.length - 1, Math.max(0, i + (forward ? 1 : -1)));
  return CAPTURE_MODES[j] as CaptureMode;
}

export function useModeNames(): Record<CaptureMode, string> {
  const { t } = useLingui();
  return { thing: t`Thing`, receipt: t`Receipt`, label: t`Label`, reading: t`Reading` };
}

export function ModeStrip({
  value,
  onChange,
}: {
  value: CaptureMode;
  onChange: (mode: CaptureMode) => void;
}) {
  const { t } = useLingui();
  const names = useModeNames();
  const strip = useRef<HTMLDivElement>(null);
  useHint('capture.mode_strip', strip);
  return (
    <RadioGroup
      ref={strip}
      aria-label={t`Capture mode`}
      orientation="horizontal"
      value={value}
      onChange={(v) => onChange(v as CaptureMode)}
      className="mx-3 mt-2.5 flex gap-1.5 rounded-[10px] bg-[#141311] p-1.5"
    >
      {CAPTURE_MODES.map((m) => (
        <Radio
          key={m}
          value={m}
          className="flex min-h-11 flex-1 cursor-pointer items-center justify-center rounded-md px-1.5 text-center font-semibold text-[11.5px] text-[#BDB7AC] uppercase leading-tight tracking-[0.08em] outline-none data-focus-visible:outline-2 data-focus-visible:outline-offset-1 data-focus-visible:outline-[#F2EFE9] data-selected:bg-amber data-selected:text-amber-ink"
        >
          {names[m]}
        </Radio>
      ))}
    </RadioGroup>
  );
}
