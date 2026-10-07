/**
 * The filter registry (D205): one definition per field a list can filter by, so every list
 * describes a filter the same way and gains one by adding an entry.
 *
 *   const f = useFilterRegistry();
 *   const filters = [f.actor(locationIds), f.kind(), f.location(), f.date()];
 *   <ListSurface filters={filters} surface="activity" … />
 *
 * Where values come from (FilterValues):
 * - static: states, kinds, your locations;
 * - load: types (a bounded tree per account), places (the place trees) and the people who have
 *   acted in a location (`/locations/:id/actors`), loaded whole once and matched here;
 * - server: people (belongs to), brands and tags, searched as you type through the registry
 *   routes' `q` (normalised on the server, D42), which can be long.
 *
 * Money filters (the price range) are offered only where the gate shows money; the server ignores
 * them for anyone else.
 */
import { can, effectiveModules } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { captureApi } from '@/api/capture/queries';
import { api } from '@/api/client';
import { inventoryPaths } from '@/api/inventory/paths';
import { inventoryApi, useAccounts } from '@/api/inventory/queries';
import type {
  ActorsResponse,
  DerivedState,
  PlaceNode,
  RegistryItem,
  SearchStateFilter,
  TypeNode,
} from '@/api/inventory/types';
import { useLocations, useMe } from '@/api/queries';
import {
  ActivityIcon,
  BoxIcon,
  CalendarIcon,
  HomeIcon,
  PersonIcon,
  TagIcon,
  TrashIcon,
} from '@/components/icons';
import { placeIcon, useTypeName } from '@/components/places/labels';
import { TypeIcon } from '@/components/type-icon';
import { sep, useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import type { FilterDef, FilterOption } from './types';

type RegistryKind = 'people' | 'brands' | 'tags';

/** The first of each id (the same built-in can come from two accounts' lists). */
function uniqueBy<T>(items: T[], id: (x: T) => string): T[] {
  return [...new Map(items.map((x) => [id(x), x] as const)).values()];
}

const byLabel = (a: FilterOption, b: FilterOption) => a.label.localeCompare(b.label);

/** You can see money somewhere: Money is on in a location and your role there may see it. */
export function useCanSeeMoney(): boolean {
  const locations = useLocations();
  return (locations.data ?? []).some((l) => {
    const modules = l.effectiveModules ?? [
      ...effectiveModules(l.modules, { providerResolved: l.providerResolved }),
    ];
    return (
      modules.includes('money') &&
      can(l.role, 'money.view', { moneyVisibleToViewers: l.moneyVisibleToViewers ?? false })
    );
  });
}

export function useFilterRegistry() {
  const { t } = useLingui();
  const locations = useLocations();
  const me = useMe();
  const nameOf = useLocationName();
  const typeName = useTypeName();
  const accounts = useAccounts();
  const all = locations.data ?? [];
  const accountList = accounts.data?.accounts ?? [];
  const accountIds = accountList.map((a) => a.id);
  const myId = me.data?.user.id;
  const fmt = useFormat();

  const registryName = (kind: RegistryKind, item: RegistryItem[RegistryKind]): string =>
    kind === 'people'
      ? (item as RegistryItem['people']).displayName
      : (item as { name: string }).name;
  /** Whose list an item is on, when you can see more than one account's. */
  const whose = (ownerAccountId: string | null): string | undefined => {
    if (accountList.length < 2 || !ownerAccountId) return undefined;
    const a = accountList.find((x) => x.id === ownerAccountId);
    return a && !a.isOwn ? a.ownerDisplayName : undefined;
  };
  const registryValues = (kind: RegistryKind): FilterDef['values'] => ({
    from: 'server',
    queryKey: ['filters', kind, accountIds],
    search: async (q) => {
      const pages = await Promise.all(
        accountIds.map((id) =>
          inventoryApi.registry(kind, id, { ...(q.trim() ? { q: q.trim() } : {}), limit: 50 }),
        ),
      );
      const items = uniqueBy(
        pages.flatMap((pg) => pg.items as RegistryItem[RegistryKind][]),
        (x) => x.id,
      );
      const options = items.map((x) => {
        const description = whose(x.ownerAccountId);
        return {
          value: x.id,
          label: registryName(kind, x),
          ...(description ? { description } : {}),
        };
      });
      // The server orders a search by how well it matches; without one, A to Z.
      return q.trim() ? options : options.sort(byLabel);
    },
    resolve: async (ids) => {
      const found = await Promise.all(
        ids.map((id) =>
          api
            .get<RegistryItem[RegistryKind]>(inventoryPaths.registryItem(kind, id))
            .then((x) => ({ value: x.id, label: registryName(kind, x) }))
            .catch(() => null),
        ),
      );
      return found.filter((x): x is FilterOption => x !== null);
    },
  });

  const stateLabels: Record<SearchStateFilter, string> = {
    uncertain: t`Not sure where`,
    draft: t`Draft`,
    ended: t`Ended`,
    to_review: t`Readings to review`,
    long_unseen: t`Not seen for a long time`,
    unplaced: t`Waiting for a place`,
    lent: t`Lent out`,
    borrowed: t`Borrowed`,
    in_repair: t`In repair`,
  };

  /** People who have acted in `locationIds` (all of yours when empty); you first, as "You". */
  const actorValues = (locationIds: string[]): FilterDef['values'] => {
    const ids = locationIds.length ? locationIds : all.map((l) => l.id);
    return {
      from: 'load',
      queryKey: ['filters', 'actors', ids, myId],
      load: async () => {
        const lists = await Promise.all(
          ids.map((id) =>
            api
              .get<ActorsResponse>(inventoryPaths.locationActors(id))
              .then((r) => r.items)
              .catch(() => []),
          ),
        );
        const people = uniqueBy(
          lists.flat().filter((a) => a.id !== myId && a.displayName),
          (a) => a.id,
        )
          .map((a) => ({ value: a.id, label: a.displayName }))
          .sort(byLabel);
        return [...(myId ? [{ value: myId, label: t`You` }] : []), ...people];
      },
    };
  };

  return {
    location: (): FilterDef => ({
      key: 'location',
      label: t`Location`,
      icon: <HomeIcon />,
      kind: 'multi',
      findLabel: t`Find a location`,
      values: { from: 'static', options: all.map((l) => ({ value: l.id, label: nameOf(l) })) },
    }),

    /** Places (and what's inside them) in `locationIds`, or in all of yours. */
    place: (locationIds: string[] = []): FilterDef => {
      const locs = locationIds.length ? all.filter((l) => locationIds.includes(l.id)) : all;
      return {
        key: 'place',
        label: t`Place`,
        icon: <BoxIcon />,
        kind: 'multi',
        findLabel: t`Find a place`,
        values: {
          from: 'load',
          queryKey: ['filters', 'places', locs.map((l) => l.id)],
          load: async () => {
            const trees = await Promise.all(locs.map((l) => inventoryApi.places(l.id)));
            return trees.flatMap((tree, i) => {
              const loc = locs[i];
              const where = loc ? nameOf(loc) : '';
              const byId = new Map(tree.places.map((pl) => [pl.id, pl]));
              const chainOf = (pl: PlaceNode) => {
                const chain: string[] = [];
                for (let cur: PlaceNode | undefined = pl; cur; cur = byId.get(cur.parentId ?? ''))
                  chain.unshift(cur.name);
                return chain;
              };
              return tree.places
                .filter((pl) => !pl.isUnplaced)
                .map((pl) => ({ pl, chain: chainOf(pl) }))
                .sort((a, b) => a.chain.join('\u0000').localeCompare(b.chain.join('\u0000')))
                .map(({ pl, chain }) => ({
                  value: pl.id,
                  label: pl.name,
                  description: [where, ...chain.slice(0, -1)].join(' › '),
                  icon: <TypeIcon icon={placeIcon(pl)} />,
                }));
            });
          },
        },
      };
    },

    type: (): FilterDef => ({
      key: 'type',
      label: t`Type`,
      icon: <BoxIcon />,
      kind: 'multi',
      findLabel: t`Find a type`,
      values: {
        from: 'load',
        queryKey: ['filters', 'types', accountIds],
        load: async () => {
          const lists = await Promise.all(accountIds.map((id) => inventoryApi.types(id)));
          return uniqueBy(
            lists.flatMap((r) => r.types),
            (ty) => ty.id,
          )
            .filter((ty: TypeNode) => !ty.isFieldGroup && !ty.archivedAt)
            .map((ty) => ({
              value: ty.id,
              label: typeName(ty) ?? '',
              icon: <TypeIcon icon={ty.icon} />,
            }))
            .filter((o) => o.label)
            .sort(byLabel);
        },
      },
    }),

    tag: (): FilterDef => ({
      key: 'tag',
      label: t`Tag`,
      icon: <TagIcon />,
      kind: 'multi',
      findLabel: t`Find a tag`,
      values: registryValues('tags'),
    }),

    brand: (): FilterDef => ({
      key: 'brand',
      label: t`Brand`,
      icon: <BoxIcon />,
      kind: 'multi',
      findLabel: t`Find a brand`,
      values: registryValues('brands'),
    }),

    belongsTo: (): FilterDef => ({
      key: 'belongsTo',
      label: t`Belongs to`,
      icon: <PersonIcon />,
      kind: 'multi',
      findLabel: t`Find a person`,
      values: registryValues('people'),
    }),

    state: (states: readonly (DerivedState | SearchStateFilter)[]): FilterDef => ({
      key: 'state',
      label: t`State`,
      icon: <ActivityIcon />,
      kind: 'multi',
      values: {
        from: 'static',
        options: states.map((s) => ({ value: s, label: stateLabels[s] })),
      },
    }),

    /** Who did it (Activity's Person), from the people who acted in `locationIds`. */
    actor: (locationIds: string[] = []): FilterDef => ({
      key: 'actor',
      label: t`Person`,
      icon: <PersonIcon />,
      kind: 'multi',
      findLabel: t`Find a person`,
      values: actorValues(locationIds),
    }),

    /** Who trashed it (Trash's Deleted by). */
    deletedBy: (locationIds: string[] = []): FilterDef => ({
      key: 'by',
      label: t`Deleted by`,
      icon: <TrashIcon />,
      kind: 'multi',
      findLabel: t`Find a person`,
      values: actorValues(locationIds),
    }),

    /** What an entry is about: `thing` and `place`, and on Activity the account's registries. */
    kind: (withRegistries = false): FilterDef => ({
      key: 'kind',
      label: t`Kind`,
      icon: <BoxIcon />,
      kind: 'multi',
      values: {
        from: 'static',
        options: [
          { value: 'thing', label: t`Things` },
          { value: 'place', label: t`Places` },
          ...(withRegistries
            ? [
                { value: 'type', label: t`Types` },
                { value: 'tag', label: t`Tags` },
                { value: 'person', label: t`People` },
                { value: 'brand', label: t`Brands` },
                { value: 'vendor', label: t`Vendors` },
              ]
            : []),
        ],
      },
    }),

    date: (key = 'when', label = t`Date`): FilterDef => ({
      key,
      label,
      icon: <CalendarIcon />,
      kind: 'date-range',
    }),

    /** The unit price paid, in one currency (T27): `f.priceMin`, `f.priceMax`, `f.currency`. */
    price: (): FilterDef => ({
      key: 'price',
      label: t`Price`,
      kind: 'number-range',
      range: { min: 'priceMin', max: 'priceMax', currency: 'currency' },
    }),

    /**
     * "Imported by" (step-7 T16, T22): the things one import run brought in (`f.importRun`, sent
     * as `importRunId`). Offered to a location's owners and admins, who can see its imports; the
     * runs are that location's, newest first, named by their source and day.
     */
    importRun: (locationId: string): FilterDef => {
      const sources: Record<string, string> = {
        csv: t`CSV`,
        homebox_zip: t`Homebox export`,
        homebox_api: t`Homebox`,
        kept_zip: t`Kept export`,
        lubelogger_csv: t`LubeLogger CSV`,
      };
      return {
        key: 'importRun',
        label: t`Imported by`,
        icon: <ActivityIcon />,
        kind: 'single',
        negatable: false,
        values: {
          from: 'load',
          queryKey: ['filters', 'import-runs', locationId],
          load: async () => {
            const page = await captureApi.imports(locationId);
            return page.items
              .filter((r) => r.status === 'done' || r.status === 'running')
              .map((r) => ({
                value: r.id,
                label: `${sources[r.source] ?? r.source}${sep()}${fmt.day(r.createdAt)}`,
              }));
          },
        },
      };
    },

    /** A location's Unplaced area (`f.where=unplaced`), with how many things wait there. */
    unplaced: (count?: number): FilterDef => ({
      key: 'where',
      label: t`Unplaced`,
      icon: <BoxIcon />,
      kind: 'boolean',
      on: 'unplaced',
      values: {
        from: 'static',
        options: [
          { value: 'unplaced', label: t`Unplaced`, ...(count !== undefined ? { count } : {}) },
        ],
      },
      hideZero: true,
    }),
  };
}

export type FilterRegistry = ReturnType<typeof useFilterRegistry>;
