/**
 * Links between things (D76): accessory of, spare part for, used up by, bundled with, replaces,
 * related. The list is part of the thing's view (it isn't paginated), so it is a plain list.
 * Links stay inside one location (a cross-location move drops them, Q13), so the picker offers
 * things from this location.
 */
import { LINK_KINDS } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useThings } from '@/api/inventory/queries';
import { thingApi } from '@/api/inventory/thing-api';
import type { LinkKind } from '@/api/inventory/types';
import { LinkIcon, XIcon } from '@/components/icons';
import { EmptyState, List, Row, Section, useErrorText } from '@/components/page';
import { usePlaceName } from '@/components/places/labels';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { DialogFooter } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { addressOf } from '@/lib/address';
import { useThingCtx } from './context';
import { useLinkKindLabels } from './labels';
import { Sheet } from './sheet';

export function LinksSection() {
  const { thing, can, refresh } = useThingCtx();
  const { t } = useLingui();
  const kinds = useLinkKindLabels();
  const errorText = useErrorText();
  const [adding, setAdding] = useState(false);
  const remove = async (linkId: string) => {
    try {
      await thingApi.removeLink(linkId);
      toast({ title: t`Link removed`, tone: 'ok' });
      await refresh();
    } catch (e) {
      toast({ title: t`Couldn't remove the link`, description: errorText(e), tone: 'danger' });
    }
  };
  return (
    <Section
      title={<Trans>Links</Trans>}
      action={
        can('things.edit') ? (
          <Button variant="secondary" size="small" onPress={() => setAdding(true)}>
            <LinkIcon className="size-4" />
            <Trans>Link a thing</Trans>
          </Button>
        ) : undefined
      }
    >
      {thing.links.length === 0 ? (
        <EmptyState icon={<LinkIcon />} title={<Trans>No links yet</Trans>}>
          <Trans>
            Link a charger to its phone, a spare part to its machine, or a set that belongs
            together.
          </Trans>
        </EmptyState>
      ) : (
        <List aria-label={t`Links`}>
          {thing.links.map((l) => (
            <li key={l.id}>
              <Row
                leading={<TypeIcon icon={l.thing.type?.icon} className="text-ink-2" />}
                title={
                  <Link to="/t/$id" params={{ id: addressOf(l.thing) }} className="hover:underline">
                    <bdi>{l.thing.name ?? t`Untitled`}</bdi>
                  </Link>
                }
                subtitle={kinds[l.kind][l.direction]}
                trailing={
                  can('things.edit') ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t`Remove the link to ${l.thing.name ?? ''}`}
                      onPress={() => void remove(l.id)}
                    >
                      <XIcon />
                    </Button>
                  ) : undefined
                }
              />
            </li>
          ))}
        </List>
      )}
      <AddLinkSheet isOpen={adding} onClose={() => setAdding(false)} />
    </Section>
  );
}

function AddLinkSheet({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { thing, refresh } = useThingCtx();
  const { t } = useLingui();
  const kinds = useLinkKindLabels();
  const placeName = usePlaceName();
  const errorText = useErrorText();
  const things = useThings({ locationId: thing.locationId, limit: 200 });
  const [kind, setKind] = useState<LinkKind>('accessory_of');
  const [other, setOther] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = (things.data?.pages.flatMap((p) => p.items) ?? [])
    .filter((x) => x.id !== thing.id && x.name)
    .map((x) => ({
      id: x.id,
      label: x.name ?? '',
      description: x.path.map((s) => placeName(s)).join(' › '),
    }));
  const save = async () => {
    if (!other) return;
    setBusy(true);
    try {
      await thingApi.addLink(thing.id, { toThingId: other, kind });
      toast({ title: t`Linked`, tone: 'ok' });
      await refresh();
      setOther(null);
      onClose();
    } catch (e) {
      toast({ title: t`Couldn't link them`, description: errorText(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t`Link ${thing.name ?? ''} to another thing`}
    >
      <div className="grid gap-3.5">
        <Combobox
          label={t`This thing is…`}
          items={LINK_KINDS.map((k) => ({ id: k, label: kinds[k].from }))}
          selectedKey={kind}
          onSelectionChange={(k) => {
            if (k) setKind(String(k) as LinkKind);
          }}
        />
        <Combobox
          label={t`…this one`}
          items={options}
          selectedKey={other}
          onSelectionChange={(k) => setOther(k ? String(k) : null)}
          placeholder={t`Search things here`}
        />
        <DialogFooter>
          <Button variant="secondary" onPress={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button isDisabled={!other} isPending={busy} onPress={() => void save()}>
            <Trans>Link</Trans>
          </Button>
        </DialogFooter>
      </div>
    </Sheet>
  );
}
