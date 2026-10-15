/**
 * The line above every page of Try Kept (D246): what this is (a sample household, in the
 * browser, nothing saved), **Reset** (try/reset.ts) and **Install Kept**, the docs site's
 * Docker Compose page in the interface's language. Rendered only in the Try build.
 */
import { Trans } from '@lingui/react/macro';
import { InfoIcon } from '@/components/icons';
import { Button, buttonClass } from '@/components/ui/button';
import { usePrefs } from '@/lib/prefs';
import { cn } from '@/lib/utils';
import { docsUrl, TRY } from './flag';
import { resetTry } from './reset';

export function TryBanner({
  show = TRY,
  onReset = () => resetTry(),
}: {
  show?: boolean;
  onReset?: () => void;
}) {
  const { locale } = usePrefs();
  if (!show) return null;
  return (
    <div
      role="note"
      data-try-banner=""
      className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-line bg-surface px-3.5 py-2 text-small text-ink-2 md:px-6"
    >
      <InfoIcon aria-hidden="true" className="size-[18px] shrink-0 text-info" />
      <span className="min-w-0 flex-1 basis-48">
        <Trans>A sample household in your browser. Nothing is saved.</Trans>
      </span>
      <span className="flex shrink-0 gap-2">
        <Button size="small" variant="secondary" onPress={onReset}>
          <Trans>Reset</Trans>
        </Button>
        <a
          href={docsUrl('/install/compose/', locale)}
          className={cn(
            buttonClass('primary', 'small'),
            'no-underline focus-visible:outline-2 focus-visible:outline-info focus-visible:outline-offset-2',
          )}
        >
          <Trans>Install Kept</Trans>
        </a>
      </span>
    </div>
  );
}
