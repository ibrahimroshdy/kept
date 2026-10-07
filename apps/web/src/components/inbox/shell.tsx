/**
 * What every inbox item shares: the frame (photo, title, pills, who and when), the keys it
 * answers (the list sends `a`, `e`, `m`, `t`, `y`, `n`, `l`, `g`, `d` to the current item), and
 * why its buttons may be off (offline: "Needs a connection", screens §3).
 */
import type { InboxAction } from '@kept/shared';
import { Trans } from '@lingui/react/macro';
import { createContext, type ReactNode, useContext, useEffect, useRef } from 'react';
import type { InboxItem, InboxPhoto } from '@/api/capture/types';
import type { MoveTarget } from '@/api/inventory/types';
import { useMe } from '@/api/queries';
import { BoxIcon } from '@/components/icons';
import { useFormat } from '@/lib/format';
import { cn } from '@/lib/utils';

/** What the current item does for a key; missing keys do nothing. */
export type ItemKeys = Partial<Record<InboxAction, () => void>>;

type Registry = { set: (id: string, keys: ItemKeys | null) => void };
const KeysContext = createContext<Registry | null>(null);
export const KeysProvider = KeysContext.Provider;

/** Registers this item's key handlers while it's mounted; the latest closures always win. */
export function useItemKeys(id: string, keys: ItemKeys) {
  const registry = useContext(KeysContext);
  const latest = useRef(keys);
  latest.current = keys;
  useEffect(() => {
    if (!registry) return;
    const proxy: ItemKeys = {};
    for (const action of Object.keys(latest.current) as InboxAction[])
      proxy[action] = () => latest.current[action]?.();
    registry.set(id, proxy);
    return () => registry.set(id, null);
    // The keys an item answers don't change while it's mounted; the handlers do (via `latest`).
  }, [registry, id]);
}

/** Where the batch was captured, as a move target: its drafts start there. */
export function batchTarget(item: InboxItem): MoveTarget | null {
  const last = item.batch?.placePath.at(-1);
  if (!last) return null;
  return last.kind === 'container' ? { containerId: last.id } : { placeId: last.id };
}

/** Why an item's actions are off right now, or undefined when they're on. */
export type Blocked = string | undefined;

/** A photo, or its placeholder while the thumbnail doesn't exist (a HEIC, still uploading). */
export function Thumb({
  photo,
  className,
  label,
}: {
  photo: InboxPhoto | undefined;
  className?: string;
  label?: string;
}) {
  return (
    <span
      className={cn(
        'grid size-14 shrink-0 place-items-center overflow-hidden rounded-[10px] border border-line bg-sunken text-ink-3 [&_svg]:size-6',
        className,
      )}
    >
      {photo?.thumbUrl ? (
        <img src={photo.thumbUrl} alt={label ?? ''} className="size-full object-cover" />
      ) : (
        <BoxIcon />
      )}
    </span>
  );
}

/** "Alfred · 2 hours ago" for someone else's item; nothing for your own. */
export function WhoWhen({ item }: { item: InboxItem }) {
  const me = useMe();
  const fmt = useFormat();
  const mine = item.createdBy.displayName === me.data?.user.displayName;
  const when = fmt.relative(item.createdAt);
  if (mine) return null;
  return (
    <span className="text-small text-ink-3">
      <Trans>
        <bdi>{item.createdBy.displayName}</bdi> · {when}
      </Trans>
    </span>
  );
}

export function ItemShell({
  item,
  label,
  title,
  titleExtra,
  photo,
  meta,
  current,
  children,
  actions,
}: {
  item: InboxItem;
  /** The item's accessible name ("Bosch impact driver, 18 V"). */
  label: string;
  title: ReactNode;
  /** Beside the title: the short ID. */
  titleExtra?: ReactNode;
  photo?: InboxPhoto | undefined;
  /** Pills and the place, under the title. */
  meta?: ReactNode;
  current: boolean;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <article
      aria-label={label}
      aria-current={current ? 'true' : undefined}
      data-inbox-item={item.id}
      tabIndex={-1}
      className={cn(
        '@container grid min-w-0 gap-3 px-3.5 py-3.5 outline-none max-md:[&_[data-slot=button]]:min-h-11 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info',
        current && 'bg-sunken/60',
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <Thumb photo={photo} />
        <div className="grid min-w-0 flex-1 gap-1">
          <h2 className="m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-semibold text-[15px] leading-snug text-ink">
            <span className="min-w-0 [overflow-wrap:anywhere]">{title}</span>
            {titleExtra}
          </h2>
          {meta ? (
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-small text-ink-2">
              {meta}
            </div>
          ) : null}
          <WhoWhen item={item} />
        </div>
      </div>
      {children}
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </article>
  );
}

/** The reason under a row of disabled buttons (never only a greyed-out button, screens §3). */
export function BlockedReason({ reason }: { reason: Blocked }) {
  if (!reason) return null;
  return <p className="m-0 w-full text-small text-ink-3">{reason}</p>;
}
