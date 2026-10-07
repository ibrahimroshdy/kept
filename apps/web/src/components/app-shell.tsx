/**
 * The signed-in frame (screens §1). Phone: bottom tabs Home · Search · Capture · Inbox · More.
 * 768 px and up: a sidebar with the §1 entries, the locations list and the footer (version and
 * the Source code link, D147). The sidebar folds to an icon rail (D198): a button at its foot or
 * ⌘\ / Ctrl+\, remembered per device; tablets start on the rail. Entries whose step isn't built
 * yet are shown, muted and inert, so the navigation already has its final shape. Activity and
 * Trash open from step 2 (screens §1 and §8); Labels and Help from step 3, and the header's Scan
 * button on Home and Search (components/scan-button.tsx); Schedules, Lending, Paperwork and
 * Notifications from step 4, and the header's bell (components/notification-bell.tsx). The
 * assistant (step 6) docks beside the page from 768 px and is a sheet below (assistant/host.tsx).
 */
import { MODULE_IDS, MODULES, type ModuleNav } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import {
  type ComponentProps,
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';
import { Focusable } from 'react-aria-components';
import { useLocations, useVersion } from '@/api/queries';
import type { LocationSummary } from '@/api/types';
import { AssistantHost } from '@/assistant/host';
import { useAssistantUi } from '@/assistant/store';
import { AppMark, BrandLockup } from '@/components/brand';
import { SoonBadge } from '@/components/coming-later';
import { HintsProvider } from '@/components/hints/hints-provider';
import {
  ActivityIcon,
  BellIcon,
  BoxIcon,
  CameraIcon,
  CarIcon,
  ChartIcon,
  CodeIcon,
  DocumentIcon,
  GearIcon,
  HandoffIcon,
  HelpIcon,
  HomeIcon,
  InboxIcon,
  MenuIcon,
  PanelCollapseIcon,
  PanelExpandIcon,
  PlusIcon,
  ScheduleIcon,
  SearchIcon,
  TagIcon,
  TrashIcon,
} from '@/components/icons';
import { KindIcon } from '@/components/kind-icon';
import { shortcutLabel, TipWithKeys } from '@/components/page';
import { PullToRefresh } from '@/components/pull-to-refresh';
import { PaletteHost } from '@/components/search/palette-host';
import { SyncStatus } from '@/components/sync-status';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { sep } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { DOCKED, useMediaQuery, WIDE } from '@/lib/media';
import { toggleSidebar, usePrefs, watchSidebarWidth } from '@/lib/prefs';
import { cn } from '@/lib/utils';
import { OfflineProvider } from '@/offline/provider';

/** The lockup (D135); kept under its step-1 name for the auth frame. */
export const Logo = BrandLockup;

const footerLink =
  'underline-offset-2 outline-none hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-info';

/** "v0.1.0 · Source code" (D147). Shown in the sidebar, on More, and on the sign-in pages. The
 * image's third-party notices (D151) stay in the image and at /notices.txt, not in the footer. */
export function VersionFooter({ className }: { className?: string }) {
  const { data } = useVersion();
  if (!data) return <div className={cn('min-h-5', className)} />;
  return (
    <div className={cn('flex flex-wrap items-center gap-x-1.5 text-[12px] text-ink-3', className)}>
      <span className="ltr">v{data.version}</span>
      {data.source ? (
        <>
          <span aria-hidden="true">{sep().trim()}</span>
          <a href={data.source} target="_blank" rel="noreferrer" className={footerLink}>
            <Trans>Source code</Trans>
          </a>
        </>
      ) : null}
    </div>
  );
}

type NavEntry = {
  key: string;
  label: string;
  icon: ReactNode;
  to?:
    | '/'
    | '/inbox'
    | '/settings'
    | '/activity'
    | '/trash'
    | '/labels'
    | '/help'
    | '/schedules'
    | '/vehicles'
    | '/lending'
    | '/paperwork'
    | '/consumables'
    | '/notifications';
};

/**
 * Screens §1's entries, in order. Those without `to` arrive in later steps. An entry that belongs
 * to a module shows only when the module is on in at least one of your locations (§1): Vehicles,
 * Labels, Schedules, Lending, Paperwork and Consumables. Notifications is core: everyone has it. The Inbox is for
 * members and above (screens §5): a viewer everywhere has no entry for it.
 */
export function useNavEntries(): NavEntry[] {
  const { t } = useLingui();
  const locations = useLocations();
  const modulesOn = new Set((locations.data ?? []).flatMap((l) => l.modules));
  const inboxOn = useHasInbox();
  /** An entry some module brings (@kept/shared MODULES[…].nav), while one of them is on anywhere. */
  const navOn = (entry: ModuleNav) =>
    MODULE_IDS.some((m) => modulesOn.has(m) && MODULES[m].nav.includes(entry));
  const gated = (on: boolean, entry: NavEntry): NavEntry[] => (on ? [entry] : []);
  return [
    { key: 'home', label: t`Home`, icon: <HomeIcon />, to: '/' },
    ...(inboxOn
      ? [{ key: 'inbox', label: t`Inbox`, icon: <InboxIcon />, to: '/inbox' as const }]
      : []),
    ...gated(navOn('vehicles'), {
      key: 'vehicles',
      label: t`Vehicles`,
      icon: <CarIcon />,
      to: '/vehicles',
    }),
    ...gated(navOn('schedules'), {
      key: 'schedules',
      label: t`Schedules`,
      icon: <ScheduleIcon />,
      to: '/schedules',
    }),
    ...gated(navOn('lending'), {
      key: 'lending',
      label: t`Lending`,
      icon: <HandoffIcon />,
      to: '/lending',
    }),
    ...gated(navOn('paperwork'), {
      key: 'paperwork',
      label: t`Paperwork`,
      icon: <DocumentIcon />,
      to: '/paperwork',
    }),
    ...gated(navOn('consumables'), {
      key: 'consumables',
      label: t`Consumables`,
      icon: <BoxIcon />,
      to: '/consumables',
    }),
    { key: 'insights', label: t`Insights`, icon: <ChartIcon /> },
    ...gated(modulesOn.has('labels'), {
      key: 'labels',
      label: t`Labels`,
      icon: <TagIcon />,
      to: '/labels',
    }),
    { key: 'activity', label: t`Activity`, icon: <ActivityIcon />, to: '/activity' },
    { key: 'trash', label: t`Trash`, icon: <TrashIcon />, to: '/trash' },
    {
      key: 'notifications',
      label: t`Notifications`,
      icon: <BellIcon />,
      to: '/notifications',
    },
    { key: 'settings', label: t`Settings`, icon: <GearIcon />, to: '/settings' },
    { key: 'help', label: t`Help`, icon: <HelpIcon />, to: '/help' },
  ];
}

/**
 * You can change something somewhere, so the inbox has something for you (screens §5: members
 * and above). While your locations load it's assumed, so the entry doesn't flicker in.
 */
export function useHasInbox(): boolean {
  const locations = useLocations();
  return !locations.data || locations.data.some((l) => l.role !== 'viewer');
}

/** Counts shown beside an entry, and as a badge on the rail (D198). Step 3 passes the Inbox's. */
export type NavCounts = Partial<Record<string, number>>;

const SIDEBAR_ID = 'kept-sidebar';
/** The sidebar entries "Show me around" stops at (components/hints/tour.ts). */
const TOURED: ReadonlySet<string> = new Set(['home', 'inbox']);
/**
 * The sidebar's width: the full sidebar, or the icon rail (D198). `rail:` follows the attribute
 * the pre-paint script sets, so the loading frame and the first paint already have the right width.
 */
export const sidebarWidth = 'w-60 rail:w-16';

const sideItem =
  'relative flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[14px] leading-snug outline-none [&_svg]:size-[18px] [&_svg]:shrink-0';
/** Same height as a full entry, so folding moves nothing up or down. Focus scrolls an entry clear
 * of the sticky footer (its toggle and Source code), never under it. */
const railItem = 'h-9 min-h-9 w-11 scroll-mb-16 justify-center px-0 py-0';
/** The rail's last entry, New location, sits on the footer: a full 44 px target there (UI review
 * steps 6–8, L17; axe target-size). */
const railLastItem = 'h-11 min-h-11';
const sideLink =
  'text-ink-2 hover:bg-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-info data-[status=active]:bg-sunken data-[status=active]:font-semibold data-[status=active]:text-ink';

/** ⌘\ or Ctrl+\ (either works everywhere), like the palette's ⌘K. */
export function isSidebarShortcut(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): boolean {
  return (
    (e.metaKey || e.ctrlKey) &&
    !e.altKey &&
    !e.shiftKey &&
    (e.key === '\\' || e.code === 'Backslash')
  );
}

const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** Typing a backslash into a field must never fold the sidebar. */
function isTextField(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(el.type);
  return el.getAttribute('role') === 'textbox';
}

/** The sidebar shows from 768 px; below that the shortcut has nothing to fold. */
function sidebarShown(): boolean {
  try {
    return window.matchMedia(WIDE).matches;
  } catch {
    return true; // no matchMedia (tests): assume a desktop
  }
}

function useFormatCount() {
  const { i18n } = useLingui();
  return (n: number) => (n > 99 ? `${i18n.number(99)}+` : i18n.number(n));
}

/** A count: after the label in the full sidebar, a badge on the icon in the rail. */
function NavCount({ n, rail }: { n: number; rail: boolean }) {
  const format = useFormatCount();
  if (rail)
    return (
      <span className="absolute -top-0.5 -end-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-amber px-1 font-semibold text-[10px] leading-none text-amber-ink ring-2 ring-surface">
        {format(n)}
      </span>
    );
  return <span className="ms-auto text-small text-ink-3">{format(n)}</span>;
}

/** The label: shown in the full sidebar; in the rail it names the link and the tooltip shows it. */
function NavLabel({ rail, children }: { rail: boolean; children: ReactNode }) {
  return <span className={rail ? 'sr-only' : 'min-w-0 [overflow-wrap:anywhere]'}>{children}</span>;
}

/**
 * In the rail, a tooltip that shows the entry's name on hover and keyboard focus. Only there, and
 * only while the sidebar is on screen: the full sidebar shows its labels, and a hidden element
 * can't be a tooltip's trigger.
 */
function RailTip({
  on,
  content,
  children,
}: {
  on: boolean;
  content: ReactNode;
  children: ComponentProps<typeof Focusable>['children'];
}) {
  if (!on) return children;
  return (
    <Tip content={content}>
      <Focusable>{children}</Focusable>
    </Tip>
  );
}

function Sidebar({ locations, counts }: { locations: LocationSummary[]; counts: NavCounts }) {
  const { t } = useLingui();
  const entries = useNavEntries();
  const nameOf = useLocationName();
  const { sidebarCollapsed } = usePrefs();
  // While the assistant's panel docks beside the page (from 1280 px), the sidebar is its icon
  // rail, so the page keeps the width its layouts expect (UI review steps 6–8, H1). Not stored:
  // closing the panel brings back the person's own choice.
  const dockable = useMediaQuery(DOCKED);
  const assistant = useAssistantUi();
  const docked = dockable && assistant.open;
  const rail = sidebarCollapsed || docked;
  const tips = useMediaQuery(WIDE) && rail;
  const asideRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  /** The entry that had focus when the sidebar folded, if focus was inside it. */
  const refocus = useRef<string | null>(null);

  const toggle = useCallback(() => {
    const active = document.activeElement;
    refocus.current = asideRef.current?.contains(active)
      ? (active?.closest('[data-nav]')?.getAttribute('data-nav') ?? '')
      : null;
    toggleSidebar();
  }, []);

  // Without a stored choice, follow the width across 1024 px.
  useEffect(() => watchSidebarWidth(), []);

  // Folding re-renders the entries (the rail wraps them in tooltips): focus goes back to the
  // same entry, or to the toggle when that entry isn't in this form (the footer's links).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the form changes
  useLayoutEffect(() => {
    const key = refocus.current;
    refocus.current = null;
    const aside = asideRef.current;
    if (key === null || !aside || aside.contains(document.activeElement)) return;
    const same = key ? aside.querySelector<HTMLElement>(`[data-nav="${CSS.escape(key)}"]`) : null;
    (same ?? toggleRef.current)?.focus();
  }, [rail, tips]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isSidebarShortcut(e) || isTextField(document.activeElement) || !sidebarShown()) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  const item = cn(sideItem, rail && railItem);
  const toggleLabel = rail ? t`Expand sidebar` : t`Collapse sidebar`;
  return (
    <aside
      ref={asideRef}
      id={SIDEBAR_ID}
      className={cn(
        'sticky top-0 hidden h-dvh shrink-0 overflow-x-hidden overflow-y-auto border-e border-line bg-surface transition-[width] duration-200 ease-out motion-reduce:transition-none md:block',
        sidebarWidth,
        docked && 'w-16',
      )}
    >
      {/* Laid out at its final width while the aside's width animates, so labels don't rewrap. */}
      <div
        className={cn(
          'flex min-h-full flex-col gap-4 px-2.5 pt-4',
          rail ? 'w-16 items-center' : 'w-60',
        )}
      >
        <Link
          to="/"
          className={cn(
            'w-fit rounded outline-none focus-visible:outline-2 focus-visible:outline-info',
            rail ? 'grid h-9 w-11 place-items-center rounded-lg' : 'px-1.5',
          )}
        >
          {rail ? <AppMark size={32} label="Kept" /> : <BrandLockup />}
        </Link>
        <nav aria-label={t`Main`} className="grid gap-0.5">
          {entries.map((e) => {
            const n = counts[e.key] ?? 0;
            return e.to ? (
              <Fragment key={e.key}>
                <RailTip on={tips} content={e.label}>
                  <Link
                    to={e.to}
                    data-nav={e.key}
                    data-tour={TOURED.has(e.key) ? e.key : undefined}
                    activeOptions={{ exact: e.to === '/' }}
                    className={cn(item, sideLink)}
                  >
                    {e.icon}
                    <NavLabel rail={rail}>{e.label}</NavLabel>
                    {/* The space keeps "Inbox 4" apart in the link's name; flex ignores it. */}
                    {n > 0 ? (
                      <>
                        {' '}
                        <NavCount n={n} rail={rail} />
                      </>
                    ) : null}
                  </Link>
                </RailTip>
              </Fragment>
            ) : (
              <Fragment key={e.key}>
                <RailTip
                  on={tips}
                  content={
                    <>
                      <span className="block">{e.label}</span>
                      <span className="block opacity-75">{t`Coming soon`}</span>
                    </>
                  }
                >
                  {/* A disabled link. In the rail it takes focus, so a keyboard reads its tooltip. */}
                  {/* biome-ignore lint/a11y/useSemanticElements: a disabled link has no href, and an <a> without one isn't a link */}
                  <span
                    role="link"
                    tabIndex={tips ? 0 : -1}
                    aria-disabled="true"
                    data-nav={e.key}
                    title={tips ? undefined : t`Coming soon`}
                    className={cn(
                      item,
                      'cursor-not-allowed text-ink-3 outline-none focus-visible:outline-2 focus-visible:outline-info [&>svg]:opacity-60',
                    )}
                  >
                    {e.icon}
                    <NavLabel rail={rail}>
                      <span className="opacity-60">{e.label}</span>
                    </NavLabel>
                    {/* The rail has no room for it: its tooltip says the same. */}
                    {rail ? null : <SoonBadge className="ms-auto" />}
                  </span>
                </RailTip>
              </Fragment>
            );
          })}
        </nav>
        <nav aria-label={t`Locations`} className="grid gap-0.5">
          {rail ? (
            // Where the eyebrow was: a rule of the same height.
            <div aria-hidden="true" className="flex h-[15.5px] items-center px-2 pb-1">
              <div className="w-full border-t border-line" />
            </div>
          ) : (
            <div className="eyebrow px-2.5 pb-1">
              <Trans>Locations</Trans>
            </div>
          )}
          {locations.map((l) => (
            <Fragment key={l.id}>
              <RailTip on={tips} content={nameOf(l)}>
                <Link
                  to="/loc/$id"
                  params={{ id: l.id }}
                  data-nav={`loc:${l.id}`}
                  className={cn(item, sideLink, 'data-[status=active]:font-normal')}
                >
                  <KindIcon kind={l.kind} />
                  <NavLabel rail={rail}>{nameOf(l)}</NavLabel>
                </Link>
              </RailTip>
            </Fragment>
          ))}
          <RailTip on={tips} content={t`New location`}>
            <Link
              to="/locations/new"
              data-nav="new-location"
              className={cn(item, rail && railLastItem, sideLink, 'text-ink-3')}
            >
              <PlusIcon />
              <NavLabel rail={rail}>{t`New location`}</NavLabel>
            </Link>
          </RailTip>
        </nav>
        {/* Pinned to the bottom, so the toggle stays in reach when the entries scroll. */}
        <div
          className={cn(
            'sticky bottom-0 mt-auto flex gap-2 bg-surface pt-1 pb-4',
            rail ? 'flex-col items-center self-stretch' : 'items-center justify-between ps-2.5',
          )}
        >
          {rail ? <RailSourceLink tips={tips} /> : <VersionFooter className="min-w-0" />}
          <Tip content={<TipWithKeys label={toggleLabel} keys={shortcutLabel('\\')} />}>
            <Button
              ref={toggleRef}
              variant="ghost"
              size="icon"
              aria-label={toggleLabel}
              aria-expanded={!rail}
              aria-controls={SIDEBAR_ID}
              aria-keyshortcuts={'Meta+\\ Control+\\'}
              onPress={toggle}
              className="size-9 shrink-0 rounded-lg [&_svg]:size-[18px]"
            >
              {rail ? <PanelExpandIcon /> : <PanelCollapseIcon />}
            </Button>
          </Tip>
        </div>
      </div>
    </aside>
  );
}

/** The rail has no room for "v0.1.0 · Source code" (D147): an icon link, the version in its tooltip. */
function RailSourceLink({ tips }: { tips: boolean }) {
  const { t } = useLingui();
  const { data } = useVersion();
  if (!data?.source) return null;
  return (
    <RailTip
      on={tips}
      content={
        <>
          <span className="block">{t`Source code`}</span>
          <span className="ltr block opacity-75">v{data.version}</span>
        </>
      }
    >
      <a
        href={data.source}
        target="_blank"
        rel="noreferrer"
        className={cn(sideItem, railItem, sideLink, 'text-ink-3')}
      >
        <CodeIcon />
        <span className="sr-only">{t`Source code`}</span>
      </a>
    </RailTip>
  );
}

const tab =
  'flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-ink-3 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info data-[status=active]:text-ink [&_svg]:size-[22px]';

function TabBar() {
  const { t } = useLingui();
  const inboxOn = useHasInbox();
  return (
    <nav
      aria-label={t`Main`}
      // The iOS bottom strip shows while this bar does (styles/index.css, index.html).
      data-tab-bar=""
      className="fixed inset-x-0 bottom-0 z-30 flex items-end border-t border-line bg-surface px-1 pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <Link to="/" data-tour="home" activeOptions={{ exact: true }} className={tab}>
        <HomeIcon />
        <Trans>Home</Trans>
      </Link>
      <Link to="/search" data-tour="search" className={tab}>
        <SearchIcon />
        <Trans>Search</Trans>
      </Link>
      <Link to="/capture" data-tour="capture" className={cn(tab, 'justify-end pb-1.5')}>
        <span className="-mt-6 mb-0.5 grid size-[52px] place-items-center rounded-2xl bg-amber text-amber-ink shadow-[0_4px_14px_rgba(0,0,0,.18)] [&_svg]:size-[26px]">
          <CameraIcon strokeWidth="2" />
        </span>
        <Trans>Capture</Trans>
      </Link>
      {inboxOn ? (
        <Link to="/inbox" data-tour="inbox" className={tab}>
          <InboxIcon />
          <Trans>Inbox</Trans>
        </Link>
      ) : null}
      <Link to="/more" className={tab}>
        <MenuIcon />
        <Trans>More</Trans>
      </Link>
    </nav>
  );
}

export function MainShell({
  locations,
  counts = {},
  children,
}: {
  locations: LocationSummary[];
  counts?: NavCounts;
  children: ReactNode;
}) {
  const main = useRef<HTMLElement>(null);
  return (
    <OfflineProvider>
      <HintsProvider>
        <div className="flex min-h-dvh bg-paper">
          <Sidebar locations={locations} counts={counts} />
          <main ref={main} className="min-w-0 flex-1">
            <SyncStatus />
            {children}
          </main>
          {/* The assistant: docked here from 768 px, a sheet below (D24; assistant/host.tsx). */}
          <AssistantHost />
          <PullToRefresh target={main} />
          <TabBar />
          <PaletteHost />
        </div>
      </HintsProvider>
    </OfflineProvider>
  );
}
