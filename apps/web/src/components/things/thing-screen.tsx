/**
 * Thing detail (screens §5, D76, D156, D195). Phone: one scrolling page with anchored section
 * chips. From `md` up: tabs, with the open tab in the URL (`?tab=`). A container opens on its
 * Contents, with Details as a tab. Sections in order: Contents (containers) · Overview ·
 * Paperwork and warranties · Value · Meters (when metered) · Loans · Claims · Links · Schedules ·
 * History; step 4's follow their modules (Money, Lending, Warranties, Schedules).
 *
 * A viewer sees the same layout in the same order with no action menu, no Edit, no Mark seen or
 * Not here: Copy link is the only action (screens §5, A viewer's thing detail).
 */

import type { ModuleId } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useClaims, useThingLoans } from '@/api/household/queries';
import { inventoryKeys, useThing } from '@/api/inventory/queries';
import { useInvalidateThing } from '@/api/inventory/thing-api';
import type { ThingView } from '@/api/inventory/types';
import { useLocation, useMe } from '@/api/queries';
import { HistoryTimeline } from '@/components/history/timeline';
import { LinkIcon, PencilIcon } from '@/components/icons';
import { ErrorState, LoadingRows, Page, Pill } from '@/components/page';
import { SaveAsTemplateSheet } from '@/components/templates/template-sheet';
import { Button } from '@/components/ui/button';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/tabs';
import {
  useShowsAsVehicle,
  useVehicleActions,
  useVehicleTitles,
  VehicleNavProvider,
  VehicleReportSheet,
  type VehicleTab,
  vehiclePanel,
  vehicleTabOrder,
} from '@/components/vehicles/vehicle-tabs';
import { useFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ActionMenu, type SheetName, useCopyLink, useRunAction } from './action-menu';
import { ContentsSection } from './contents';
import { makeCtx, ThingProvider, useThingCtx } from './context';
import { useThingEditor } from './edit-form';
import { ThingHeader } from './header';
import {
  ClaimsSection,
  LendSheet,
  ReturnSheet,
  ThingLoansSection,
  ThingSchedulesSection,
  ValueSection,
} from './household-lazy';
import { LabelSheet } from './label-sheet';
import { LifecycleSheet } from './lifecycle-sheet';
import { LinksSection } from './links';
import { MetersSection } from './meters-section';
import { MoveSheet } from './move-sheet';
import { Overview } from './overview';
import { PaperworkSection } from './paperwork';
import { RetypeSheet } from './retype-sheet';
import { SplitSheet } from './split-sheet';
import { TrashContentsSheet } from './trash';

export type ThingTab =
  | 'contents'
  | 'overview'
  | 'paperwork'
  | 'value'
  | 'meters'
  | 'loans'
  | 'claims'
  | 'links'
  | 'schedules'
  | 'history'
  // A vehicle's own tabs (step 5, components/vehicles/vehicle-tabs.tsx).
  | VehicleTab;
/** Screens §5's order: Overview · Paperwork and warranties · Value · Meters · Loans · Claims · Links · Schedules · History. */
export const THING_TABS: readonly ThingTab[] = [
  'contents',
  'overview',
  'paperwork',
  'value',
  'meters',
  'loans',
  'claims',
  'links',
  'schedules',
  'history',
];
export const SHEETS: readonly SheetName[] = [
  'move',
  'split',
  'lifecycle',
  'retype',
  'label',
  'trash',
  'template',
  'lend',
  'return',
];

/** `(min-width: 768px)`, the app's phone/desktop line (the sidebar appears at `md`). */
export function useWide(): boolean {
  const query = '(min-width: 768px)';
  const get = () => {
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  };
  const [wide, setWide] = useState(get);
  useEffect(() => {
    let mql: MediaQueryList;
    try {
      mql = window.matchMedia(query);
    } catch {
      return;
    }
    const on = () => setWide(mql.matches);
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, []);
  return wide;
}

export function ThingScreen({
  id,
  tab,
  sheet,
}: {
  id: string;
  tab: ThingTab | undefined;
  sheet: SheetName | undefined;
}) {
  const { t } = useLingui();
  const thing = useThing(id);
  const location = useLocation(thing.data?.locationId ?? '');
  const me = useMe();
  const qc = useQueryClient();
  const invalidate = useInvalidateThing();
  const refresh = useCallback(async () => {
    await invalidate(id);
    await qc.refetchQueries({ queryKey: inventoryKeys.things.detail(id) });
  }, [invalidate, qc, id]);

  if (thing.isError)
    return (
      <Page title={t`Thing`} back="/">
        <ErrorState error={thing.error} onRetry={() => void thing.refetch()} />
      </Page>
    );
  if (!thing.data || !location.data)
    return (
      <Page title={t`Thing`} back="/">
        <LoadingRows rows={4} label={t`Loading the thing`} />
      </Page>
    );
  const ctx = makeCtx(thing.data, location.data, me.data?.user.displayName ?? '', refresh);
  return (
    <ThingProvider value={ctx}>
      <Loaded tab={tab} sheet={sheet} />
    </ThingProvider>
  );
}

/** Step 4's sections follow their modules: off here, the tab isn't there (T20). */
const TAB_MODULE: Partial<Record<ThingTab, ModuleId>> = {
  value: 'money',
  loans: 'lending',
  claims: 'warranties',
  schedules: 'schedules',
};

function tabsFor(thing: ThingView, moduleOn: (m: ModuleId) => boolean): ThingTab[] {
  return THING_TABS.filter((x) => {
    const m = TAB_MODULE[x];
    return (
      (x !== 'contents' || thing.isContainer) &&
      (x !== 'meters' || thing.meters.length > 0) &&
      (!m || moduleOn(m))
    );
  });
}

function Loaded({ tab, sheet }: { tab: ThingTab | undefined; sheet: SheetName | undefined }) {
  const { thing, location, can, moduleOn } = useThingCtx();
  const { t } = useLingui();
  const fmt = useFormat();
  const navigate = useNavigate();
  const wide = useWide();
  const editor = useThingEditor();
  const copyLink = useCopyLink();
  const [menuOpen, setMenuOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const vehicleActions = useVehicleActions();
  // A vehicle (step 5): Overview · Readings · Services · Fuel · Schedules · Documents · Costs,
  // then its Details and the rest (components/vehicles/vehicle-tabs.tsx).
  const asVehicle = useShowsAsVehicle(thing, location, moduleOn);
  const vehicleTitles = useVehicleTitles();
  const tabs: ThingTab[] = asVehicle
    ? vehicleTabOrder(tabsFor(thing, moduleOn))
    : tabsFor(thing, moduleOn);
  const claims = useClaims(moduleOn('warranties') ? thing.id : '');
  // With Lending off, the open loan is still read, for Mark returned (UI step-4 review L3).
  const onLoan = thing.derivedState.includes('lent') || thing.derivedState.includes('borrowed');
  const loans = useThingLoans(moduleOn('lending') || onLoan ? thing.id : '');
  const openLoan = loans.data?.items.find((l) => !l.returnedAt) ?? null;
  const openClaims = (claims.data?.items ?? []).filter(
    (c) => c.status === 'open' || c.status === 'in_repair',
  ).length;
  const current: ThingTab = tab && tabs.includes(tab) ? tab : (tabs[0] ?? 'overview');
  const viewer = !can('things.edit') && !can('things.mark-seen');

  const setSearch = (
    patch: { tab?: ThingTab | undefined; sheet?: SheetName | undefined },
    replace = false,
  ) =>
    void navigate({
      to: '.',
      search: ((prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...prev, ...patch };
        for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
        return next;
      }) as never,
      replace,
    });
  const openSheet = (s: SheetName) => setSearch({ sheet: s });
  const closeSheet = () => setSearch({ sheet: undefined }, true);
  const runAction = useRunAction(openSheet);
  const editTab: ThingTab = asVehicle ? 'details' : 'overview';
  const startEdit = () => {
    if (wide && current !== editTab) setSearch({ tab: editTab });
    editor.start();
  };
  const goVehicleTab = (x: ThingTab) => {
    if (wide) setSearch({ tab: x });
    else document.getElementById(`thing-${x}`)?.scrollIntoView({ block: 'start' });
  };

  const titles: Record<ThingTab, string> = {
    ...vehicleTitles,
    contents: t`Contents`,
    overview: asVehicle ? vehicleTitles.overview : t`Details`,
    paperwork: moduleOn('warranties') ? t`Paperwork and warranties` : t`Paperwork`,
    value: t`Value`,
    meters: t`Meters`,
    loans: thing.loanLine ? t`Loans · ${fmt.num(1)} open` : t`Loans`,
    claims: openClaims ? t`Claims · ${fmt.num(openClaims)}` : t`Claims`,
    links: t`Links`,
    schedules: t`Schedules`,
    history: t`History`,
  };
  const panel = (x: ThingTab): ReactNode => {
    switch (x) {
      case 'contents':
        return <ContentsSection />;
      case 'overview':
        return asVehicle ? (
          vehiclePanel('overview')
        ) : (
          <Overview editor={editor} onSplit={() => openSheet('split')} wide={wide} />
        );
      case 'details':
        return <Overview editor={editor} onSplit={() => openSheet('split')} wide={wide} />;
      case 'paperwork':
        return <PaperworkSection />;
      case 'value':
        return <ValueSection />;
      case 'loans':
        return (
          <ThingLoansSection
            onLend={() => openSheet('lend')}
            onReturn={() => openSheet('return')}
          />
        );
      case 'claims':
        return <ClaimsSection />;
      case 'schedules':
        return asVehicle ? vehiclePanel('schedules') : <ThingSchedulesSection />;
      case 'meters':
        return <MetersSection />;
      case 'links':
        return <LinksSection />;
      case 'history':
        return (
          <HistoryTimeline
            subject={{ kind: 'thing', id: thing.id }}
            heading={<Trans>History</Trans>}
          />
        );
      default:
        return vehiclePanel(x);
    }
  };

  const parent = thing.path.at(-1);
  const back = parent
    ? {
        to: parent.kind === 'container' ? ('/t/$id' as const) : ('/p/$id' as const),
        params: { id: parent.id },
      }
    : { to: '/loc/$id' as const, params: { id: location.id } };

  return (
    <VehicleNavProvider value={{ go: goVehicleTab }}>
      <Page
        title={<bdi dir="auto">{thing.name ?? t`Untitled`}</bdi>}
        back={back}
        wide
        actions={
          viewer ? null : (
            <>
              {wide && can('things.edit') ? (
                <>
                  <Button
                    variant="secondary"
                    onPress={startEdit}
                    isDisabled={editor.session !== null}
                  >
                    <PencilIcon className="size-4" />
                    <Trans>Edit</Trans>
                  </Button>
                  <Button variant="secondary" onPress={() => openSheet('move')}>
                    <Trans>Move</Trans>
                  </Button>
                </>
              ) : null}
              <ActionMenu
                wide={wide}
                isOpen={menuOpen}
                onOpenChange={setMenuOpen}
                onAction={(a) => (a === 'history-report' ? setReportOpen(true) : void runAction(a))}
                {...(asVehicle ? { extra: vehicleActions } : {})}
              />
            </>
          )
        }
      >
        <ThingHeader />
        {viewer ? (
          <div className="grid gap-2">
            <Pill className="justify-self-start">
              <Trans>You're a viewer here</Trans>
            </Pill>
            <Button onPress={() => void copyLink()} className="md:justify-self-start">
              <LinkIcon className="size-4" />
              <Trans>Copy link</Trans>
            </Button>
          </div>
        ) : null}

        {wide ? (
          <Tabs
            selectedKey={current}
            onSelectionChange={(k) => setSearch({ tab: String(k) as ThingTab })}
          >
            <TabList aria-label={t`Sections`}>
              {tabs.map((x) => (
                <Tab key={x} id={x}>
                  {titles[x]}
                </Tab>
              ))}
            </TabList>
            {tabs.map((x) => (
              <TabPanel key={x} id={x}>
                {/* The panel's own heading, so its cards' h3s follow an h2 (UI step-5 review M6). */}
                <h2 className="sr-only">{titles[x]}</h2>
                {panel(x)}
              </TabPanel>
            ))}
          </Tabs>
        ) : (
          <>
            {/* One row that scrolls sideways: wrapped, History sat alone on a second row (L1). */}
            <nav
              aria-label={t`Sections`}
              className="sticky top-14 z-10 -mx-3.5 flex gap-1.5 overflow-x-auto overscroll-x-contain bg-paper px-3.5 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {tabs.map((x) => (
                <a
                  key={x}
                  href={`#thing-${x}`}
                  className={cn(
                    'inline-flex min-h-9 shrink-0 items-center whitespace-nowrap rounded-full border border-line bg-surface px-3 text-[13px] font-medium text-ink-2 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-info',
                    x === current && 'border-ink text-ink',
                  )}
                >
                  {titles[x]}
                </a>
              ))}
            </nav>
            {tabs.map((x) => (
              <div key={x} id={`thing-${x}`} className="scroll-mt-28">
                {/* A vehicle's Overview is cards (h3) with no section heading of its own. */}
                {asVehicle && x === 'overview' ? <h2 className="sr-only">{titles[x]}</h2> : null}
                {panel(x)}
              </div>
            ))}
          </>
        )}

        {can('things.edit') ? (
          <>
            <MoveSheet isOpen={sheet === 'move'} onClose={closeSheet} />
            {thing.quantity > 1 ? (
              <SplitSheet isOpen={sheet === 'split'} onClose={closeSheet} />
            ) : null}
            <LifecycleSheet isOpen={sheet === 'lifecycle'} onClose={closeSheet} />
            <RetypeSheet isOpen={sheet === 'retype'} onClose={closeSheet} />
            <TrashContentsSheet isOpen={sheet === 'trash'} onClose={closeSheet} />
            <LendSheet isOpen={sheet === 'lend'} onClose={closeSheet} />
            <ReturnSheet loan={openLoan} isOpen={sheet === 'return'} onClose={closeSheet} />
          </>
        ) : null}
        {can('labels.use') ? <LabelSheet isOpen={sheet === 'label'} onClose={closeSheet} /> : null}
        {can('registries-types.manage') ? (
          <SaveAsTemplateSheet
            isOpen={sheet === 'template'}
            onClose={closeSheet}
            thingId={thing.id}
            thingName={thing.name ?? ''}
            accountId={location.ownerAccountId}
            locationId={thing.locationId}
          />
        ) : null}
        {asVehicle ? (
          <VehicleReportSheet open={reportOpen} onClose={() => setReportOpen(false)} />
        ) : null}
      </Page>
    </VehicleNavProvider>
  );
}
