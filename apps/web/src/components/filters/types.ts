/**
 * The filter strip's definitions (D205). A list offers filters by listing definitions, most of
 * them from the registry (./registry.tsx); FilterStrip renders any definition by its `kind`, so
 * a new kind plugs in there and a list gains a filter by adding one entry.
 *
 * State lives in the URL (lib/url-state.ts): `f.<key>` holds the values and `not` names the
 * filters that are "is none of".
 */
import type { QueryKey } from '@tanstack/react-query';
import type { ReactNode } from 'react';

export type FilterKind = 'multi' | 'single' | 'date-range' | 'number-range' | 'boolean';

export type FilterOption = {
  value: string;
  label: string;
  /** A second line (a place's path, a location's name). Wraps; never cut off. */
  description?: string;
  icon?: ReactNode;
  count?: number;
};

/** Where a field's values come from. */
export type FilterValues =
  /** Known up front (states, kinds, your locations). */
  | { from: 'static'; options: FilterOption[] }
  /** Loaded whole when first needed (types, places, the people who acted here), then matched
   * here as you type. */
  | { from: 'load'; queryKey: QueryKey; load: () => Promise<FilterOption[]> }
  /** Searched on the server as you type (people, brands, tags: registries that can be long);
   * `resolve` names the values already chosen, for their chip. */
  | {
      from: 'server';
      queryKey: QueryKey;
      search: (q: string) => Promise<FilterOption[]>;
      resolve: (values: string[]) => Promise<FilterOption[]>;
    };

export type FilterDef = {
  /** The URL key (`f.<key>`), and the key a saved view stores. */
  key: string;
  label: string;
  icon?: ReactNode;
  kind: FilterKind;
  /** multi and single: the values. */
  values?: FilterValues;
  /** multi: offers "is any of / is none of" (default true). */
  negatable?: boolean;
  /** Hide values whose `count` is 0, unless chosen (D191, the attention-panel rule). */
  hideZero?: boolean;
  /** number-range: the URL keys of the lowest and highest value, and of their currency. */
  range?: { min: string; max: string; currency?: string };
  /** boolean: the value `f.<key>` holds when on (default '1'). */
  on?: string;
  /** Other filters emptied when this one changes (a place belongs to one location). */
  clears?: string[];
  /** The phrase for "find a value" in its popover ("Find a person"). */
  findLabel?: string;
  /**
   * date-range: `false` offers only a custom range, for a list of what's ahead (Expiring), where
   * the presets ("Last 7 days", …) look back and mean nothing.
   */
  presets?: false;
};

/** The URL filter keys a definition owns. */
export const keysOf = (def: FilterDef): string[] =>
  def.kind === 'number-range' && def.range
    ? [def.range.min, def.range.max, ...(def.range.currency ? [def.range.currency] : [])]
    : [def.key];
