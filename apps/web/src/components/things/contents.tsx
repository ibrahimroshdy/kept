/**
 * A container's Contents tab. The list itself is task 25's `ContentsList` (places/contents-list),
 * the same one the Location and Place pages use, so a box lists, filters, selects and moves its
 * contents exactly like a room. Adding here opens the full create sheet with the box as the place.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { PlusIcon } from '@/components/icons';
import { EmptyState, Section } from '@/components/page';
import { ContentsList } from '@/components/places/contents-list';
import { Button } from '@/components/ui/button';
import { useThingCtx } from './context';
import { CreateThingSheet } from './create-sheet';

export function ContentsSection() {
  const { thing, can } = useThingCtx();
  const { t } = useLingui();
  const [adding, setAdding] = useState(false);
  const canEdit = can('things.edit');
  const name = thing.name ?? t`Untitled`;
  return (
    <Section
      title={<Trans>Contents</Trans>}
      action={
        canEdit ? (
          <Button size="small" onPress={() => setAdding(true)}>
            <PlusIcon className="size-4" />
            <Trans>Add a thing</Trans>
          </Button>
        ) : undefined
      }
    >
      <ContentsList
        parent={{ kind: 'container', id: thing.id, locationId: thing.locationId, name }}
        canEdit={canEdit}
        empty={
          <EmptyState title={<Trans>{name} is empty</Trans>}>
            {canEdit ? (
              <Trans>Add what's inside, so you can find it without opening it.</Trans>
            ) : null}
          </EmptyState>
        }
      />
      {canEdit ? (
        <CreateThingSheet
          isOpen={adding}
          onClose={() => setAdding(false)}
          locationId={thing.locationId}
          target={{ containerId: thing.id }}
          openAfter={false}
        />
      ) : null}
    </Section>
  );
}
