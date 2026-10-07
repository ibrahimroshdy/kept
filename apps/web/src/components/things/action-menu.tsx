/**
 * The thing's actions (screens §5): Move · Lend or Mark returned (step 4) · Pick up (the carrying tray, D175) · Box check
 * (containers, D40) · Label · Split · Duplicate · Save as template (D76) · Mark seen · Not here · Change lifecycle ·
 * Re-type · Convert to place (containers) · Trash, plus Copy link. On a phone
 * they open as a bottom sheet; from `md` up, as a menu. Both are a React Aria Menu: arrow keys
 * move, Enter chooses, Escape closes.
 *
 * What's shown follows screens §3 and §8: an action the role can't do is hidden (a viewer gets
 * Copy link only, as a button, never this menu); one that doesn't apply is hidden (Split at
 * quantity 1); one whose module is off (Label) says "Off in this location".
 *
 * Sheets are a query parameter (`?sheet=move`), so an open sheet can be linked and Back closes it.
 */
import { newId } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Menu, MenuItem, MenuTrigger, Popover, Separator } from 'react-aria-components';
import { isApiError } from '@/api/client';
import { inventoryApi } from '@/api/inventory/queries';
import { thingApi } from '@/api/inventory/thing-api';
import type { ConversionLoss, ConvertToPlaceConflict } from '@/api/inventory/types';
import {
  CheckCircleIcon,
  CopyIcon,
  EndedIcon,
  HandoffIcon,
  LinkIcon,
  MenuIcon,
  PencilIcon,
  QrIcon,
  QuestionIcon,
  TrashIcon,
} from '@/components/icons';
import { useErrorText } from '@/components/page';
import { useScanStore } from '@/components/scan/use-scan-store';
import { TrayIcon } from '@/components/tray/tray-icon';
import { pickUp } from '@/components/tray/use-tray';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { addressOf } from '@/lib/address';
import { cn } from '@/lib/utils';
import { useThingCtx } from './context';
import { Sheet } from './sheet';
import { useTrashThing } from './trash';

export type SheetName =
  | 'move'
  | 'split'
  | 'lifecycle'
  | 'retype'
  | 'label'
  | 'trash'
  | 'template'
  | 'lend'
  | 'return';

export type Item = {
  id: string;
  label: string;
  icon: ReactNode;
  note?: string;
  danger?: boolean;
  separatorBefore?: boolean;
};

export function useCopyLink() {
  const { thing } = useThingCtx();
  const { t } = useLingui();
  return async () => {
    try {
      // The short-ID address when there is one (D208).
      await navigator.clipboard.writeText(`${window.location.origin}/t/${addressOf(thing)}`);
      toast({ title: t`Link copied`, tone: 'ok' });
    } catch {
      toast({
        title: t`Couldn't copy`,
        description: t`Copy the address from the address bar.`,
        tone: 'danger',
      });
    }
  };
}

function useItems(extra: Item[] = []): Item[] {
  const { thing, can, moduleOn } = useThingCtx();
  const { t } = useLingui();
  const items: Item[] = [];
  const edit = can('things.edit');
  if (edit) items.push({ id: 'move', label: t`Move`, icon: <MoveGlyph /> });
  // Lend, or Mark returned while it's lent or borrowed (D57). Lend is hidden while it's in repair
  // or already on loan (screens §8: what doesn't apply is hidden); with Lending off it says so.
  // Mark returned stays with Lending off: a loan opened before the switch can still end, and the
  // server allows that one write (UI step-4 review L3).
  const onLoan = thing.derivedState.includes('lent') || thing.derivedState.includes('borrowed');
  if (edit && onLoan) items.push({ id: 'return', label: t`Mark returned`, icon: <HandoffIcon /> });
  else if (edit && !onLoan && !thing.derivedState.includes('in_repair'))
    items.push({
      id: 'lend',
      label: t`Lend`,
      icon: <HandoffIcon />,
      ...(moduleOn('lending') ? {} : { note: t`Off in this location` }),
    });
  // The carrying tray (D175, plan T26): pick it up now, put it down where you scan.
  if (edit) items.push({ id: 'pickup', label: t`Pick up`, icon: <TrayIcon /> });
  if (thing.isContainer && can('things.mark-seen'))
    items.push({ id: 'box-check', label: t`Box check`, icon: <CheckCircleIcon /> });
  if (can('labels.use'))
    items.push({
      id: 'label',
      label: t`Label`,
      icon: <QrIcon />,
      ...(moduleOn('labels') ? {} : { note: t`Off in this location` }),
    });
  if (edit && thing.quantity > 1)
    items.push({ id: 'split', label: t`Split`, icon: <SplitGlyph /> });
  if (edit) items.push({ id: 'duplicate', label: t`Duplicate`, icon: <CopyIcon /> });
  // Templates are the account's, made by owners and admins (T19; registries-types.manage).
  if (can('registries-types.manage'))
    items.push({ id: 'template', label: t`Save as template`, icon: <CopyIcon /> });
  if (can('things.mark-seen')) {
    items.push({ id: 'seen', label: t`Mark seen`, icon: <CheckCircleIcon /> });
    if (!thing.locationUncertain)
      items.push({ id: 'not-here', label: t`Not here`, icon: <QuestionIcon /> });
  }
  if (edit) {
    items.push({
      id: 'lifecycle',
      label: t`Change lifecycle…`,
      icon: <EndedIcon />,
      separatorBefore: true,
    });
    items.push({ id: 'retype', label: t`Re-type`, icon: <PencilIcon /> });
    // The thing's row goes away: owners and admins only (security review #23).
    if (thing.isContainer && can('things.delete-permanently'))
      items.push({ id: 'convert', label: t`Convert to a room or spot`, icon: <MoveGlyph /> });
  }
  items.push(...extra);
  items.push({ id: 'copy-link', label: t`Copy link`, icon: <LinkIcon /> });
  if (can('things.trash'))
    items.push({ id: 'trash', label: t`Move to Trash`, icon: <TrashIcon />, danger: true });
  return items;
}

const MoveGlyph = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
const SplitGlyph = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 20v-7M12 13 6 5M12 13l6-8M6 5v4M6 5h4M18 5v4M18 5h-4" />
  </svg>
);

/** Run a chosen action: open its sheet, or do it and say so. */
export function useRunAction(openSheet: (s: SheetName) => void) {
  const { thing, refresh } = useThingCtx();
  const { t } = useLingui();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const copyLink = useCopyLink();
  const trashThing = useTrashThing(openSheet);
  const scanStore = useScanStore();
  const losses: Record<ConversionLoss, string> = {
    brand: t`brand`,
    ended: t`end details`,
    links: t`links`,
    meters: t`meters`,
    purchase: t`purchase`,
    serial: t`serial number`,
    tags: t`tags`,
  };
  const fail = (e: unknown) =>
    toast({ title: t`That didn't work`, description: errorText(e), tone: 'danger' });
  return async (id: string) => {
    try {
      switch (id) {
        case 'move':
        case 'split':
        case 'lifecycle':
        case 'retype':
        case 'label':
        case 'template':
        case 'lend':
        case 'return':
          openSheet(id);
          return;
        case 'copy-link':
          await copyLink();
          return;
        case 'pickup': {
          if (!scanStore) return;
          const carried = await pickUp(scanStore, [thing.id]);
          toast({
            title: t`Picked up ${thing.name ?? ''}`,
            description: plural(carried.length, { one: 'Carrying #', other: 'Carrying #' }),
            tone: 'ok',
            action: {
              label: t`Scan destination`,
              onAction: () => void navigate({ to: '/scan', search: { tray: 1 } }),
            },
          });
          return;
        }
        case 'box-check':
          await navigate({ to: '/box-check/$id', params: { id: thing.id } });
          return;
        case 'duplicate': {
          const copy = await thingApi.duplicate(thing.id, { id: newId() });
          await refresh();
          toast({
            title: t`Duplicated`,
            description: t`A copy without the serial or purchase.`,
            tone: 'ok',
          });
          await navigate({ to: '/t/$id', params: { id: copy.id } });
          return;
        }
        case 'seen':
          await inventoryApi.seen(thing.id);
          toast({ title: t`Marked as seen`, tone: 'ok' });
          await refresh();
          return;
        case 'not-here':
          await inventoryApi.notHere(thing.id, thing.rowVersion);
          toast({
            title: t`Marked as not here`,
            description: t`It shows as "not sure where" until someone sees it.`,
          });
          await refresh();
          return;
        case 'convert': {
          const ok = await confirm({
            title: t`Turn ${thing.name ?? ''} into a room or spot?`,
            body: t`What's inside stays inside. Its link and label keep working.`,
            confirmLabel: t`Convert`,
          });
          if (!ok) return;
          let r: { placeId: string };
          try {
            r = await thingApi.convertToPlace(thing.id, thing.rowVersion);
          } catch (e) {
            const d =
              isApiError(e) && e.status === 409 ? (e.details as ConvertToPlaceConflict) : {};
            if (d.reason !== 'discards' || !d.discards?.length) throw e;
            if (d.discards.includes('meters')) {
              toast({
                title: t`It has meters`,
                description: t`A place can't keep meter readings. Remove its meters first.`,
                tone: 'danger',
              });
              return;
            }
            const lost = d.discards.map((x) => losses[x] ?? x).join(t`, `);
            const again = await confirm({
              title: t`Convert and lose these?`,
              body: t`As a room or spot it can't keep its ${lost}. They are removed; its history stays.`,
              confirmLabel: t`Convert anyway`,
              destructive: true,
            });
            if (!again) return;
            r = await thingApi.convertToPlace(thing.id, thing.rowVersion, { discard: true });
          }
          await refresh();
          await navigate({ to: '/p/$id', params: { id: r.placeId } });
          return;
        }
        case 'trash':
          await trashThing();
          return;
      }
    } catch (e) {
      fail(e);
    }
  };
}

const itemClass =
  'flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-[15px] text-ink outline-none data-focused:bg-sunken [&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-ink-2';

function Items({
  items,
  onAction,
  autoFocus,
}: {
  items: Item[];
  onAction: (id: string) => void;
  autoFocus?: boolean;
}) {
  const { t } = useLingui();
  return (
    <Menu
      aria-label={t`Actions`}
      onAction={(k) => onAction(String(k))}
      {...(autoFocus ? { autoFocus: 'first' as const } : {})}
      className="grid gap-px p-1 outline-none"
    >
      {items.flatMap((item) => [
        ...(item.separatorBefore
          ? [<Separator key={`sep-${item.id}`} className="my-1 h-px bg-line" />]
          : []),
        <MenuItem
          key={item.id}
          id={item.id}
          textValue={item.label}
          className={cn(itemClass, item.danger && 'text-danger [&_svg]:text-danger')}
        >
          {item.icon}
          <span className="grid min-w-0 flex-1">
            <span>{item.label}</span>
            {item.note ? <span className="text-small text-ink-3">{item.note}</span> : null}
          </span>
        </MenuItem>,
      ])}
    </Menu>
  );
}

/** The phone's "Actions" button and bottom sheet, or the desktop's "More" menu. */
export function ActionMenu({
  wide,
  isOpen,
  onOpenChange,
  onAction,
  extra,
}: {
  wide: boolean;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onAction: (id: string) => void;
  /** Actions a kind of thing adds before Copy link (a vehicle's History report, step 5). */
  extra?: Item[];
}) {
  const { t } = useLingui();
  const { thing } = useThingCtx();
  const items = useItems(extra);
  if (wide)
    return (
      <MenuTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
        <Button variant="secondary" aria-label={t`More actions`}>
          <MenuIcon className="size-5" />
          <Trans>Actions</Trans>
        </Button>
        <Popover
          placement="bottom end"
          offset={6}
          className="z-50 min-w-64 rounded-[10px] border border-line bg-surface shadow-[0_10px_30px_rgba(0,0,0,.14)] outline-none"
        >
          <Items items={items} onAction={onAction} />
        </Popover>
      </MenuTrigger>
    );
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t`Actions`}
        onPress={() => onOpenChange(true)}
      >
        <MenuIcon />
      </Button>
      <Sheet isOpen={isOpen} onOpenChange={onOpenChange} title={thing.name ?? t`Untitled`}>
        {({ close }) => (
          <Items
            items={items}
            autoFocus
            onAction={(id) => {
              close();
              onAction(id);
            }}
          />
        )}
      </Sheet>
    </>
  );
}
