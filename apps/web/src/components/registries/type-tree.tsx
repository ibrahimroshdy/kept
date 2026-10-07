/**
 * The type tree (screens §5 Type editor, frame 06 · 5): an account's types, parents before
 * children, indented by depth; the field groups (D192) after them. A built-in the account has
 * customised shows as its copy (Q13b). The search box narrows the tree to matching types and
 * their ancestors, and lives in the URL (`q`, the list standard). Each row is a link, so the
 * selected type is linkable and Back returns to it.
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { Link, type LinkProps } from '@tanstack/react-router';
import { useId, useMemo } from 'react';
import type { TypeNode } from '@/api/inventory/types';
import { SearchIcon } from '@/components/icons';
import { useTypeName } from '@/components/things/names';
import { TypeIcon } from '@/components/type-icon';
import { useFormat } from '@/lib/format';
import { useListState } from '@/lib/url-state';
import { cn } from '@/lib/utils';
import { treeOrder } from './api';

export function TypeTree({
  types,
  selectedId,
  linkFor,
  footer,
}: {
  types: readonly TypeNode[];
  selectedId: string | undefined;
  linkFor: (id: string) => LinkProps;
  footer?: React.ReactNode;
}) {
  const { t } = useLingui();
  const typeName = useTypeName();
  const [list, setList] = useListState();
  const searchId = useId();
  const nameOf = (x: TypeNode) => typeName(x);

  const { rows, groups } = useMemo(() => {
    const plain = types.filter((x) => !x.isFieldGroup);
    const ordered = treeOrder(plain, typeName);
    const q = list.q.trim().toLocaleLowerCase();
    if (!q) return { rows: ordered, groups: types.filter((x) => x.isFieldGroup) };
    const byId = new Map(plain.map((x) => [x.id, x]));
    const keep = new Set<string>();
    for (const x of plain)
      if (typeName(x).toLocaleLowerCase().includes(q)) {
        let cur: TypeNode | undefined = x;
        while (cur && !keep.has(cur.id)) {
          keep.add(cur.id);
          cur = cur.parentId ? byId.get(cur.parentId) : undefined;
        }
      }
    return {
      rows: ordered.filter((r) => keep.has(r.type.id)),
      groups: types.filter((x) => x.isFieldGroup && typeName(x).toLocaleLowerCase().includes(q)),
    };
  }, [types, list.q, typeName]);

  const fmt = useFormat();
  const row = (x: TypeNode, depth: number) => (
    <li key={x.id}>
      <Link
        {...linkFor(x.id)}
        aria-current={x.id === selectedId ? 'page' : undefined}
        className={cn(
          'flex min-h-11 items-center gap-2 rounded-md py-1.5 md:min-h-9 pe-2 text-[14px] leading-snug text-ink-2 outline-none hover:bg-sunken hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info',
          x.id === selectedId && 'bg-sunken font-semibold text-ink',
          depth === 0 ? 'ps-2' : depth === 1 ? 'ps-7' : depth === 2 ? 'ps-12' : 'ps-16',
        )}
      >
        <TypeIcon icon={x.icon} className="size-4" />
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <bdi>{nameOf(x)}</bdi>
        </span>
        {x.inUse > 0 ? (
          <span className="text-[12px] text-ink-3 tabular-nums">
            <span className="sr-only">
              <Plural value={x.inUse} one="# thing" other="# things" />
            </span>
            <span aria-hidden="true">{fmt.num(x.inUse)}</span>
          </span>
        ) : null}
      </Link>
    </li>
  );

  return (
    <div className="grid content-start gap-2 rounded-[10px] border border-line bg-surface p-2">
      <div className="relative">
        <label htmlFor={searchId} className="sr-only">
          <Trans>Search types</Trans>
        </label>
        <SearchIcon className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
        <input
          id={searchId}
          type="search"
          dir="auto"
          defaultValue={list.q}
          placeholder={t`Search types`}
          onChange={(e) => setList({ q: e.target.value }, { replace: true })}
          className="min-h-11 w-full rounded-lg border border-line bg-surface ps-8 pe-2 text-[15px] text-ink outline-none placeholder:text-ink-3 focus-visible:border-info focus-visible:outline-2 focus-visible:outline-info [&::-webkit-search-cancel-button]:hidden"
        />
      </div>
      <nav aria-label={t`Types`}>
        {rows.length ? (
          <ul className="m-0 grid list-none gap-px p-0">{rows.map((r) => row(r.type, r.depth))}</ul>
        ) : (
          <p className="m-0 px-2 py-3 text-small text-ink-2">
            <Trans>No type matches.</Trans>
          </p>
        )}
      </nav>
      {groups.length ? (
        <nav aria-label={t`Field groups`} className="grid gap-1">
          <div className="eyebrow px-2 pt-2">
            <Trans>Field groups</Trans>
          </div>
          <ul className="m-0 grid list-none gap-px p-0">{groups.map((g) => row(g, 0))}</ul>
        </nav>
      ) : null}
      {footer}
    </div>
  );
}
