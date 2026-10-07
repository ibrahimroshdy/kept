/**
 * The icon picker (D98): any Lucide icon, plus the built-in library's (Tabler's engine and
 * hanger, and Kept's safe). Loaded lazily from the type editor (`React.lazy`), so the full Lucide
 * name list and `lucide-react/dynamic` never reach the entry chunk (D80). Tabler 3.48.0 has no
 * usable dynamic entry (components/type-icon.tsx), so only its built-in icons are offered.
 *
 * A search box, then a grid listbox: arrow keys move in two dimensions (mirrored in RTL), Enter
 * or Space picks. At most 60 icons show at once; typing narrows them.
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { iconNames } from 'lucide-react/dynamic';
import { useId, useMemo, useState } from 'react';
import { ListBox, ListBoxItem } from 'react-aria-components';
import { SearchIcon } from '@/components/icons';
import { STATIC_ICONS, TypeIcon } from '@/components/type-icon';
import { cn } from '@/lib/utils';

const LIMIT = 60;

/** The built-in icons first (what the library uses), then every Lucide icon by name. */
const ALL: readonly string[] = (() => {
  const statics = Object.keys(STATIC_ICONS);
  const seen = new Set(statics);
  return [...statics, ...iconNames.map((n) => `lucide:${n}`).filter((r) => !seen.has(r))];
})();

/** "lucide:washing-machine" → "washing machine". */
export const iconWords = (ref: string) => ref.replace(/^[a-z]+:/, '').replace(/-/g, ' ');

export default function IconPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (icon: string) => void;
}) {
  const { t } = useLingui();
  const [q, setQ] = useState('');
  const searchId = useId();
  const matches = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const found = words.length
      ? ALL.filter((ref) => {
          const w = iconWords(ref);
          return words.every((x) => w.includes(x));
        })
      : ALL.slice(0, Object.keys(STATIC_ICONS).length);
    // The current icon stays in view, so the grid always shows what is chosen.
    return found.includes(value) || !value ? found : [value, ...found];
  }, [q, value]);
  const shown = matches.slice(0, LIMIT);
  const more = matches.length - shown.length;

  return (
    <div className="grid gap-3">
      <div className="relative">
        <label htmlFor={searchId} className="sr-only">
          <Trans>Search icons</Trans>
        </label>
        <SearchIcon className="pointer-events-none absolute start-3 top-1/2 size-[18px] -translate-y-1/2 text-ink-3" />
        <input
          id={searchId}
          type="search"
          dir="auto"
          value={q}
          autoComplete="off"
          placeholder={t`Search icons: sofa, drill, box…`}
          onChange={(e) => setQ(e.target.value)}
          className="min-h-11 w-full rounded-lg border border-line bg-surface ps-10 pe-3 text-[15px] text-ink outline-none placeholder:text-ink-3 focus-visible:border-info focus-visible:outline-2 focus-visible:outline-info [&::-webkit-search-cancel-button]:hidden"
        />
      </div>
      <ListBox
        aria-label={t`Icons`}
        layout="grid"
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={value ? [value] : []}
        onSelectionChange={(keys) => {
          if (keys === 'all') return;
          const [next] = [...keys];
          if (next !== undefined) onChange(String(next));
        }}
        items={shown.map((id) => ({ id }))}
        renderEmptyState={() => (
          <p className="m-0 px-2 py-6 text-center text-small text-ink-2">
            <Trans>No icon matches. Try another word, like "box" or "tool".</Trans>
          </p>
        )}
        className="grid grid-cols-[repeat(auto-fill,minmax(44px,1fr))] gap-1.5 outline-none"
      >
        {(item) => (
          <ListBoxItem
            id={item.id}
            textValue={iconWords(item.id)}
            aria-label={iconWords(item.id)}
            className={({ isSelected, isFocusVisible }) =>
              cn(
                'grid aspect-square min-h-11 cursor-pointer place-items-center rounded-lg border border-line bg-surface text-ink-2 outline-none hover:text-ink',
                isSelected && 'border-2 border-ink text-ink',
                isFocusVisible && 'outline-2 outline-offset-1 outline-info',
              )
            }
          >
            <TypeIcon icon={item.id} className="size-[18px]" />
          </ListBoxItem>
        )}
      </ListBox>
      {more > 0 ? (
        <p className="m-0 text-small text-ink-3">
          <Plural
            value={more}
            one="# more icon matches. Type more to narrow."
            other="# more icons match. Type more to narrow."
          />
        </p>
      ) : null}
    </div>
  );
}
