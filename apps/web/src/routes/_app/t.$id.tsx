/**
 * Thing detail, create and edit (plan task 26; screens §5 Thing detail and A viewer's thing
 * detail). The screen is components/things/thing-screen.tsx. The URL carries the open tab
 * (`?tab=`), an open sheet (`?sheet=move`), and a container's contents list state (the list
 * standard's `q`, `f.*`, `group`, `sort`, plus `view=photos`, D195), so every state can be linked.
 *
 * `$id` is the short ID (`/t/2HX9RB`, typed any way: `/t/2hx-9rb`) or the UUID (D208, T17a;
 * lib/address.ts). A UUID address, or a code typed another way, is replaced in place by the short
 * ID once the thing has one; a thing created offline keeps its UUID address until it syncs.
 * Offline, or when the server can't be reached, the page is the phone's copy (T28).
 *
 * The schema is written out here rather than imported from the screen, because a route's
 * `validateSearch` is not code-split: it stays in the entry chunk (D80).
 */
import { SURFACE_FILTER_KEYS } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import * as z from 'zod/mini';
import { useThing } from '@/api/inventory/queries';
import { ErrorState, LoadingRows, Page } from '@/components/page';
import { CONTENTS_FILTERS } from '@/components/places/contents-search';
import { OfflineThingPage, useOfflinePage } from '@/components/places/offline-pages';
import type { SheetName } from '@/components/things/action-menu';
import { ThingScreen, type ThingTab } from '@/components/things/thing-screen';
import { useAddress, useCanonicalAddress } from '@/lib/address';
import { listSearch } from '@/lib/url-state';

const VEHICLE_FILTERS = [
  ...SURFACE_FILTER_KEYS.readings,
  ...SURFACE_FILTER_KEYS.fuel,
  ...SURFACE_FILTER_KEYS.services,
];

const oneOf = <T extends string>(values: readonly [T, ...T[]]) =>
  z.optional(z.catch(z.optional(z.enum(values)), undefined));

export const Route = createFileRoute('/_app/t/$id')({
  // A vehicle's lists (step 5): its readings, fills and services keep their filters here too.
  validateSearch: listSearch([...new Set([...CONTENTS_FILTERS, 'role', ...VEHICLE_FILTERS])], {
    view: oneOf(['list', 'photos']),
    tab: oneOf([
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
      // A vehicle's tabs (step 5, screens §8): Overview · Readings · Services · Fuel · Schedules
      // · Documents · Costs, then its Details and the thing's other sections.
      'readings',
      'services',
      'fuel',
      'documents',
      'costs',
      'details',
    ]),
    sheet: oneOf([
      'move',
      'split',
      'lifecycle',
      'retype',
      'label',
      'trash',
      'template',
      'lend',
      'return',
    ]),
  }),
  component: ThingPage,
});

function ThingPage() {
  const { id: param } = Route.useParams();
  const { t } = useLingui();
  const address = useAddress('thing', param);
  if (address.status === 'error')
    return (
      <Page title={t`Thing`} back="/">
        <ErrorState error={address.error} onRetry={address.retry} />
      </Page>
    );
  if (address.status === 'pending')
    return (
      <Page title={t`Thing`} back="/">
        <LoadingRows rows={4} label={t`Loading the thing`} />
      </Page>
    );
  return <Thing key={address.id} id={address.id} param={param} />;
}

function Thing({ id, param }: { id: string; param: string }) {
  const search = Route.useSearch() as { tab?: ThingTab; sheet?: SheetName };
  const thing = useThing(id);
  useCanonicalAddress('thing', param, thing.data);
  // Offline, or the server out of reach: the phone's copy, "as of last sync" (T28).
  const offline = useOfflinePage(thing);
  if (offline) return <OfflineThingPage id={id} />;
  return <ThingScreen id={id} tab={search.tab} sheet={search.sheet} />;
}
