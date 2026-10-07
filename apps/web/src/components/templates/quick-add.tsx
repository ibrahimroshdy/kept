/**
 * Quick add (plan T30, T19): "From a template", offered while the name is empty, on the capture
 * screen and in the create sheet. It lists the templates usable in the location (GET /templates?
 * locationId, members and above) and hands the chosen one back; the caller fills its fields and
 * sends `templateId`, so the server starts from the template's payload and what was typed wins.
 * Online only: the list comes from the server, so offline the chip isn't shown. The list is asked
 * for only when the chip is pressed, so opening capture (whose location may come from the phone's
 * position, D153) tells the server nothing.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { useTemplates } from '@/api/capture/queries';
import type { Template } from '@/api/capture/types';
import { CopyIcon } from '@/components/icons';
import { LoadingRows } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function FromTemplate({
  locationId,
  onPick,
  className,
  tone = 'light',
}: {
  locationId: string;
  onPick: (template: Template) => void;
  className?: string;
  /** The capture screen is dark. */
  tone?: 'light' | 'dark';
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  const templates = useTemplates(online && open ? locationId : '');
  const items = templates.data?.items ?? [];
  if (!online) return null;
  return (
    <>
      <Button
        variant="secondary"
        size="small"
        className={cn(
          'justify-self-start rounded-full',
          tone === 'dark' && 'border-[#34302A] bg-[#1E1C19] text-[#F2EFE9]',
          className,
        )}
        onPress={() => setOpen(true)}
      >
        <CopyIcon className="size-4" />
        <Trans>From a template</Trans>
      </Button>
      <Sheet isOpen={open} onOpenChange={setOpen} title={t`Start from a template`}>
        {({ close }) =>
          templates.isPending ? (
            <LoadingRows rows={2} />
          ) : items.length === 0 ? (
            <p className="m-0 text-ink-2">
              <Trans>
                No templates are shared with this location yet. Owners and admins make them in
                Settings → Account → Templates.
              </Trans>
            </p>
          ) : (
            <ul aria-label={t`Templates`} className="m-0 grid list-none gap-1 p-0">
              {items.map((x) => (
                <li key={x.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onPick(x);
                      close();
                    }}
                    className="flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-start text-ink outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:outline-info"
                  >
                    <TypeIcon icon={x.typeIcon} className="size-5 text-ink-2" />
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                      <bdi>{x.name}</bdi>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )
        }
      </Sheet>
    </>
  );
}

/** A template's payload as the create sheet's and capture's fields; the name falls back to the
 * template's own. */
export function prefillOf(x: Template) {
  const p = x.payload;
  const quantity = p.quantity !== undefined ? Number(p.quantity) : undefined;
  return {
    name: p.name ?? x.name,
    typeId: x.typeId,
    ...(p.brandId ? { brandId: p.brandId } : {}),
    ...(p.model ? { model: p.model } : {}),
    ...(p.colour ? { colour: p.colour } : {}),
    ...(p.notes ? { notes: p.notes } : {}),
    ...(quantity !== undefined && Number.isFinite(quantity) ? { quantity } : {}),
    ...(p.tagIds?.length ? { tagIds: p.tagIds } : {}),
    ...(p.aliases ? { aliases: p.aliases } : {}),
    ...(p.custom ? { custom: p.custom } : {}),
  };
}
