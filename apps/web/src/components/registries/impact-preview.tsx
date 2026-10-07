/**
 * The impact preview (D92, D123; screens §5 Type editor): before a type change or a merge is
 * saved, what it touches. Things per location you can see; locations you can't see as a count
 * only; the descendant types that inherit the change; and the fields whose values will be
 * archived (kept, never deleted). `POST /types/:id/preview` is read-only.
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { inventoryApi } from '@/api/inventory/queries';
import type { UpdateTypeBody } from '@/api/inventory/types';
import { ErrorState, List, LoadingRows, Notice, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { useTypeName } from '@/components/things/names';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';

export function ImpactPreview({
  typeId,
  body,
  title,
  lead,
  confirmLabel,
  onConfirm,
  onClose,
  error,
  typeNameById,
}: {
  typeId: string;
  /** A descendant's name when the preview sends none (a built-in, named by its key). */
  typeNameById?: (id: string) => string | undefined;
  /** The change as it will be sent; null while closed. */
  body: UpdateTypeBody | null;
  title: string;
  lead?: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
  /** What saving answered, shown in the sheet (a cycle, a stale version). */
  error?: ReactNode;
}) {
  return (
    <Sheet isOpen={body !== null} onOpenChange={(o) => !o && onClose()} title={title} wide>
      {({ close }) =>
        body ? (
          <PreviewBody
            typeId={typeId}
            body={body}
            lead={lead}
            confirmLabel={confirmLabel}
            onConfirm={onConfirm}
            onCancel={close}
            error={error}
            typeNameById={typeNameById}
          />
        ) : null
      }
    </Sheet>
  );
}

function PreviewBody({
  typeId,
  body,
  lead,
  confirmLabel,
  onConfirm,
  onCancel,
  error,
  typeNameById,
}: {
  typeId: string;
  typeNameById?: ((id: string) => string | undefined) | undefined;
  body: UpdateTypeBody;
  lead?: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<unknown>;
  onCancel: () => void;
  error?: ReactNode;
}) {
  const { t } = useLingui();
  const typeName = useTypeName();
  const errorText = useErrorText();
  const impact = useQuery({
    queryKey: ['types', 'preview', typeId, body],
    queryFn: () => inventoryApi.previewType(typeId, body),
    staleTime: 0,
  });
  const save = useMutation({ mutationFn: onConfirm });

  if (impact.isPending) return <LoadingRows rows={2} label={t`Working out what this changes`} />;
  if (impact.error)
    return <ErrorState error={impact.error} onRetry={() => void impact.refetch()} />;
  const d = impact.data;
  const places = d.perLocation.filter((l) => l.things > 0);

  return (
    <div className="grid gap-4">
      {lead ? <p className="m-0 text-ink-2">{lead}</p> : null}
      <section className="grid gap-1.5" aria-label={t`Things affected`}>
        <h3 className="eyebrow m-0">
          <Trans>Things affected</Trans>
        </h3>
        {places.length ? (
          <List>
            {places.map((l) => (
              <li key={l.locationId ?? 'account'} className="flex items-center gap-3 px-3.5 py-2.5">
                <span className="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">
                  {l.name ? <bdi>{l.name}</bdi> : <Trans>Account-wide</Trans>}
                </span>
                <span className="text-small text-ink-2 tabular-nums">
                  <Plural value={l.things} one="# thing" other="# things" />
                </span>
              </li>
            ))}
          </List>
        ) : (
          <p className="m-0 text-small text-ink-2">
            <Trans>No things use it in the locations you can see.</Trans>
          </p>
        )}
        {d.hiddenLocations > 0 ? (
          <p className="m-0 text-small text-ink-2">
            <Plural
              value={d.hiddenLocations}
              one="Also affects # location you can't see."
              other="Also affects # locations you can't see."
            />
          </p>
        ) : null}
      </section>
      {d.descendants.length ? (
        <section className="grid gap-1.5">
          <h3 className="eyebrow m-0">
            <Trans>Types below it, which inherit the change</Trans>
          </h3>
          <p className="m-0 [overflow-wrap:anywhere]">
            {d.descendants.map((x, i) => (
              <span key={x.id}>
                {i > 0 ? ', ' : null}
                <bdi>
                  {x.name ??
                    typeNameById?.(x.id) ??
                    typeName({ name: null, builtinKey: x.builtinKey })}
                </bdi>
              </span>
            ))}
          </p>
        </section>
      ) : null}
      {d.fieldsToArchive.length ? (
        <Notice tone="warn" title={<Trans>Fields to archive</Trans>}>
          <Trans>
            These fields leave the type. Their values are archived on each thing, not deleted, and
            come back if the field does:
          </Trans>{' '}
          <span className="font-mono">{d.fieldsToArchive.join(', ')}</span>
        </Notice>
      ) : null}
      {error ?? (save.error ? <Notice tone="danger">{errorText(save.error)}</Notice> : null)}
      <DialogFooter>
        <Button variant="secondary" onPress={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button isPending={save.isPending} onPress={() => save.mutate()}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </div>
  );
}
