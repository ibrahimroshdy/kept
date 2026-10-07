/**
 * The pieces every screen is built from, in the screens kit's style: the page header (phone
 * app bar / desktop top bar), section heads, grouped lists, avatars, pills, notices, and the
 * loading, empty and error states. Nothing here truncates with an ellipsis: text wraps (the
 * phones-never-trim rule).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { Link, type LinkProps, useRouter } from '@tanstack/react-router';
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useState,
} from 'react';
import { Focusable } from 'react-aria-components';
import { type ApiError, isApiError } from '@/api/client';
import { AssistantButton } from '@/assistant/button';
import {
  AlertIcon,
  CameraIcon,
  CheckCircleIcon,
  ChevronStartIcon,
  InfoIcon,
  SearchIcon,
} from '@/components/icons';
import { NotificationBell } from '@/components/notification-bell';
import { ScanButton } from '@/components/scan-button';
import { openPalette } from '@/components/search/palette-host';
import { Button, type ButtonSize, type ButtonVariant, buttonClass } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { useKeyHints } from '@/lib/key-hints';
import { initialOf } from '@/lib/labels';
import { useMediaQuery, WIDE } from '@/lib/media';
import { cn } from '@/lib/utils';

// ----- page header -----------------------------------------------------------------------------

/** Counts the section tab strips (LinkTabs) inside a Page; see `useSectionTabs`. */
const SectionTabsContext = createContext<((delta: 1 | -1) => void) | null>(null);

/**
 * Called by a section tab strip (components/link-tabs.tsx): the page it sits in is one tab of a
 * tabbed section (Settings, Account, Admin, Location settings), and every tab of a section has to
 * share one width, or switching tabs moves the strip. So under Full width (D203) a tabbed page
 * fills like a list page; its forms and running text keep their readable caps (styles/index.css).
 * Set before paint, so the strip never shows at the narrow width first.
 */
export function useSectionTabs() {
  const count = useContext(SectionTabsContext);
  useLayoutEffect(() => {
    if (!count) return;
    count(1);
    return () => count(-1);
  }, [count]);
}

export function Page({
  title,
  back,
  actions,
  eyebrow,
  children,
  wide = false,
  fill = wide,
}: {
  title: ReactNode;
  /** Where the back arrow goes. Phones show it; the desktop has the sidebar. */
  back?: LinkProps['to'] | { to: LinkProps['to']; params?: Record<string, string> };
  actions?: ReactNode;
  /** A small line above the title on desktop, e.g. the location name. */
  eyebrow?: ReactNode;
  children: ReactNode;
  /** A wider column when centered: lists, grids and dashboards. */
  wide?: boolean;
  /**
   * Content that uses the whole width when the person picks Full width (D203): lists, grids,
   * tables, search results, activity. Defaults to `wide`. Forms and reading pages leave it off.
   */
  fill?: boolean;
}) {
  const { t } = useLingui();
  const backTarget = typeof back === 'string' ? { to: back } : back;
  const [tabStrips, setTabStrips] = useState(0);
  const [countTabs] = useState(() => (delta: 1 | -1) => setTabStrips((n) => n + delta));
  return (
    <div className="grid min-w-0 content-start">
      {/* Opaque, in --paper: the same colour as the status bar (index.html's theme-color and the
          iOS status strip), so the two read as one band and nothing scrolls through (D132 kit
          .appbar). */}
      <header className="sticky top-0 z-20 flex min-h-14 items-center gap-2 border-b border-line bg-paper px-3 py-2 md:min-h-16 md:px-6">
        {backTarget ? (
          <Link
            {...(backTarget as LinkProps)}
            aria-label={t`Back`}
            className="grid size-11 shrink-0 place-items-center rounded-[10px] text-ink-2 outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:outline-info md:hidden"
          >
            <ChevronStartIcon />
          </Link>
        ) : null}
        <div className={cn('grid min-w-0 flex-1 gap-0.5', !backTarget && 'ps-1')}>
          {eyebrow ? <div className="hidden text-small text-ink-3 md:block">{eyebrow}</div> : null}
          <h1 className="m-0 font-semibold text-title text-ink [overflow-wrap:anywhere]">
            {title}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ScanButton />
          <NotificationBell className="md:hidden" />
          <AssistantButton />
          {actions}
          <DesktopTopbarTools />
        </div>
      </header>
      <div
        className={cn(
          // On a phone the last line ends clear of the tab bar, the Capture button raised 24 px
          // above it (79 px from the bottom edge in all) and the home indicator, with 1rem to
          // spare; at pb-28 the Capture button covered it on an iPhone (safe area 34 px).
          'mx-auto grid w-full min-w-0 content-start gap-5 px-3.5 pt-4 pb-[calc(6rem+env(safe-area-inset-bottom))] md:px-6 md:pt-5 md:pb-10',
          wide ? 'max-w-6xl' : 'max-w-3xl',
          // Full width drops the cap (styles/index.css), keeping text and forms readable. A
          // tabbed section's pages all fill, so its tabs keep one width (useSectionTabs).
          (fill || tabStrips > 0) && 'page-fill',
        )}
        data-slot="page-body"
      >
        <SectionTabsContext.Provider value={countTabs}>{children}</SectionTabsContext.Provider>
      </div>
    </div>
  );
}

/** From here the top bar has room for the full search field and Capture button. */
const WIDE_TOPBAR = '(min-width: 1024px)';

/**
 * The desktop top bar's palette opener (⌘K, task 27), the notification bell (step 4) and Capture
 * button (step 3). From 1024 px they're the full search field and button; on tablets (768–1023
 * px) they're icon buttons with tooltips (D198), and the search icon still opens the palette.
 */
function DesktopTopbarTools() {
  const { t } = useLingui();
  const paletteKeys = shortcutLabel('K');
  // ⌘K only where there are keys (a tablet without its keyboard has none; lib/key-hints.ts).
  const keyHints = useKeyHints();
  // Rendered only between 768 and 1024 px: a hidden element can't be a tooltip's trigger.
  const desktop = useMediaQuery(WIDE);
  const roomy = useMediaQuery(WIDE_TOPBAR);
  const compact = desktop && !roomy;
  return (
    <div className="hidden items-center gap-2 md:flex">
      <button
        type="button"
        data-tour="search"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={openPalette}
        className="hidden min-h-10 w-64 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-start text-small text-ink-3 outline-none hover:border-ink-3 focus-visible:outline-2 focus-visible:outline-info lg:flex"
      >
        <SearchIcon className="size-4" />
        <span className="flex-1">
          <Trans>Search or jump to…</Trans>
        </span>
        {keyHints ? (
          <kbd
            dir="ltr"
            className="rounded border border-line px-1.5 font-mono text-[11px] text-ink-3"
          >
            {paletteKeys}
          </kbd>
        ) : null}
      </button>
      <NotificationBell className="hidden lg:grid" />
      <Link
        to="/capture"
        data-tour="capture"
        className={cn(buttonClass('primary'), 'hidden lg:inline-flex')}
      >
        <CameraIcon className="size-[18px]" />
        <Trans>Capture</Trans>
      </Link>
      {compact ? (
        <>
          <Tip content={<TipWithKeys label={t`Search`} keys={paletteKeys} />} placement="bottom">
            <Button
              variant="secondary"
              size="icon"
              aria-label={t`Search`}
              data-tour="search"
              aria-keyshortcuts="Meta+K Control+K"
              onPress={openPalette}
              className="size-10 rounded-lg bg-surface [&_svg]:size-5"
            >
              <SearchIcon />
            </Button>
          </Tip>
          <NotificationBell className="size-10 rounded-lg [&_svg]:size-5" />
          <Tip content={t`Capture`} placement="bottom">
            <Focusable>
              <Link
                to="/capture"
                data-tour="capture"
                aria-label={t`Capture`}
                className={cn(buttonClass('primary', 'icon'), 'size-10 rounded-lg [&_svg]:size-5')}
              >
                <CameraIcon />
              </Link>
            </Focusable>
          </Tip>
        </>
      ) : null}
    </div>
  );
}

/** A tooltip's label with its keyboard shortcut after it. */
export function TipWithKeys({ label, keys }: { label: ReactNode; keys: string }) {
  return (
    <span className="flex items-center gap-2">
      {label}
      <kbd dir="ltr" className="font-mono text-[11px] opacity-75">
        {keys}
      </kbd>
    </span>
  );
}

/** "⌘K" on Apple platforms, "Ctrl K" elsewhere (the shortcuts accept either key everywhere). */
export function shortcutLabel(key: string): string {
  const platform =
    typeof navigator === 'undefined'
      ? ''
      : ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
          ?.platform ?? navigator.platform);
  return /mac|iphone|ipad/i.test(platform) ? `⌘${key}` : `Ctrl ${key}`;
}

// ----- sections and lists ----------------------------------------------------------------------

export function Section({
  title,
  action,
  children,
  className,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('grid content-start gap-2', className)}>
      <div className="flex min-h-5 items-center justify-between gap-2">
        <h2 className="eyebrow m-0">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function List({ className, ...props }: ComponentProps<'ul'>) {
  return (
    <ul
      className={cn(
        'm-0 grid list-none overflow-hidden rounded-[10px] border border-line bg-surface p-0 [&>li+li]:border-t [&>li+li]:border-line',
        className,
      )}
      {...props}
    />
  );
}

export function Row({
  leading,
  title,
  subtitle,
  trailing,
  children,
  className,
}: {
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-h-14 items-center gap-3 px-3.5 py-2.5', className)}>
      {leading}
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="font-semibold text-[15px] leading-snug text-ink [overflow-wrap:anywhere]">
          {title}
        </div>
        {subtitle ? (
          <div className="text-small text-ink-2 [overflow-wrap:anywhere]">{subtitle}</div>
        ) : null}
        {children}
      </div>
      {trailing}
    </div>
  );
}

export function IconTile({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-10 shrink-0 place-items-center rounded-[10px] bg-sunken text-ink-2 [&_svg]:size-5',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Avatar({ name, you = false }: { name: string; you?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-9 shrink-0 place-items-center rounded-full bg-sunken font-semibold text-[14px] text-ink-2',
        you && 'border-2 border-ink text-ink',
      )}
    >
      {initialOf(name)}
    </span>
  );
}

export type PillTone = 'neutral' | 'warn' | 'ok' | 'danger' | 'info';

const pillTones: Record<PillTone, string> = {
  neutral: 'border-line text-ink-2',
  warn: 'border-warn text-warn',
  ok: 'border-ok text-ok',
  danger: 'border-danger text-danger',
  info: 'border-info text-info',
};

export function Pill({
  tone = 'neutral',
  icon,
  children,
  className,
}: {
  tone?: PillTone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-[12.5px] leading-snug [&_svg]:size-3.5',
        pillTones[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

// ----- notices and states ----------------------------------------------------------------------

export type NoticeTone = 'info' | 'warn' | 'danger' | 'ok';

const noticeTones: Record<NoticeTone, string> = {
  info: 'border-line bg-sunken text-ink-2 [&_[data-icon]]:text-info',
  warn: 'border-warn text-ink-2 [&_[data-icon]]:text-warn',
  danger: 'border-danger text-ink-2 [&_[data-icon]]:text-danger',
  ok: 'border-ok text-ink-2 [&_[data-icon]]:text-ok',
};

export function Notice({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const Icon = tone === 'ok' ? CheckCircleIcon : tone === 'info' ? InfoIcon : AlertIcon;
  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      className={cn(
        'flex items-start gap-2.5 rounded-[10px] border p-3 text-small',
        noticeTones[tone],
        className,
      )}
    >
      <span data-icon="" className="mt-px shrink-0 [&_svg]:size-[18px]">
        <Icon />
      </span>
      <div className="grid min-w-0 flex-1 gap-1">
        {title ? (
          <div className="font-semibold text-[14px] text-ink [text-wrap:balance]">{title}</div>
        ) : null}
        {children ? <div className="[text-wrap:pretty]">{children}</div> : null}
        {action ? <div className="pt-1">{action}</div> : null}
      </div>
    </div>
  );
}

/** A grey block where content will be: never a spinner in the middle of a page. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn('animate-pulse rounded-[10px] bg-sunken', className)} />
  );
}

/** The loading state: skeleton rows plus a label for screen readers. */
export function LoadingRows({ rows = 3, label }: { rows?: number; label?: string }) {
  const { t } = useLingui();
  return (
    <div role="status" aria-label={label ?? t`Loading`} className="grid gap-2.5">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <Skeleton key={i} className="h-16" />
      ))}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="grid justify-items-center gap-2 rounded-[10px] border border-dashed border-line px-5 py-8 text-center">
      {icon ? (
        <span className="grid size-12 place-items-center rounded-full bg-sunken text-ink-2 [&_svg]:size-6">
          {icon}
        </span>
      ) : null}
      <div className="font-semibold text-[16px] text-ink">{title}</div>
      {children ? <div className="max-w-md text-small text-ink-2">{children}</div> : null}
      {action ? <div className="pt-2">{action}</div> : null}
    </div>
  );
}

export function useErrorText() {
  const { t } = useLingui();
  return (error: unknown): string => {
    if (!isApiError(error)) return t`Something went wrong. Try again.`;
    const e = error as ApiError;
    switch (e.code) {
      case 'offline':
        return t`Needs a connection. Try again when you're back online.`;
      case 'unauthenticated':
        return t`Your session ended. Sign in again.`;
      case 'mfa_required':
        return t`Confirm your second factor to continue.`;
      case 'forbidden':
        return t`You don't have permission to do that.`;
      case 'not_found':
        return t`This isn't here any more, or you can't see it.`;
      case 'rate_limited':
        return t`Too many attempts. Wait a minute and try again.`;
      case 'conflict': {
        // A move into a location that already has one of the moved things' codes (D208): the
        // server names the code, the location and what holds it there, which the mover can see.
        const d = e.details as {
          ownCode?: unknown;
          location?: { name?: unknown };
          taken?: { name?: unknown };
        };
        if (typeof d.ownCode === 'string' && typeof d.location?.name === 'string') {
          const code = d.ownCode;
          const where = d.location.name;
          const holder = d.taken?.name;
          return typeof holder === 'string'
            ? t`${where} already has the code ${code}, on ${holder}. Change or remove it on one of them, then move again.`
            : t`${where} already has the code ${code}. Change or remove it on one of them, then move again.`;
        }
        return t`That conflicts with a change someone else made. Reload and try again.`;
      }
      case 'precondition_failed':
        return t`This changed since you opened it. Reload and try again.`;
      case 'module_off':
        return t`That's turned off in this location.`;
      case 'last_owner':
        return t`A location always needs an owner. Transfer it first.`;
      case 'invite_invalid':
        return t`This invite no longer works.`;
      case 'reauth_required':
        return t`Enter your password to confirm it's you.`;
      case 'token_invalid':
        return t`This link no longer works. Links work once, and only for a while.`;
      case 'setup_code_invalid':
        return t`That setup code isn't right. Check the server's logs.`;
      case 'validation':
        return t`Some of that isn't valid. Check the fields and try again.`;
      case 'database_unavailable':
        return t`Kept can't reach its database right now. Try again in a minute.`;
      case 'https_required':
        // D181: secret reveal, exports, tokens and the recovery kit are refused over plain HTTP.
        return t`This needs a secure (HTTPS) connection to Kept.`;
      default:
        return t`Something went wrong on the server. Try again in a moment.`;
    }
  };
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const text = useErrorText();
  return (
    <Notice
      tone="danger"
      title={<Trans>Couldn't load this</Trans>}
      action={
        onRetry ? (
          <Button size="small" variant="secondary" onPress={onRetry}>
            <Trans>Try again</Trans>
          </Button>
        ) : undefined
      }
    >
      {text(error)}
    </Notice>
  );
}

// ----- links that look like buttons ------------------------------------------------------------

export function LinkButton({
  variant = 'secondary',
  size = 'default',
  className,
  ...props
}: LinkProps & { variant?: ButtonVariant; size?: ButtonSize; className?: string }) {
  return <Link {...props} className={cn(buttonClass(variant, size), className)} />;
}

/** For links out of the SPA (the source code, docs). */
export function useNavigateBack() {
  const router = useRouter();
  return () => router.history.back();
}
