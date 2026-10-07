/**
 * A type's or place kind's fields (screens §5 Type editor, frame 06 · 5): inherited fields first,
 * headed by the type they come from; then the type's own; then each field group's (D192), headed
 * "Device group · shared by …"; then archived fields (D92), which can be restored.
 *
 * Each row: label, kind (with unit and "repeatable"), required, and a note. A secret field shows a
 * lock; who may reveal it, and its policy, are the account owner's to set (D177), so the Policy
 * button shows for the owner only. Rows are a list, not a table, so they wrap on a phone.
 *
 * Step 7 (T24): the account owner also converts a type's own field: Make secret or Make plain on
 * a text field, Change kind where `CONVERSIONS` allows one (./convert-field-sheet.tsx). On a
 * phone they fold into More with the row's other actions out of the way; offline they're
 * disabled.
 */
import { CONVERSIONS, canConvertSecret } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import type { ResolvedField } from '@/api/inventory/types';
import { LockIcon } from '@/components/icons';
import { type OverflowAction, OverflowActions } from '@/components/inbox/overflow-actions';
import { useFieldLabel } from '@/components/things/names';
import { Button } from '@/components/ui/button';
import { sep } from '@/lib/format';
import { useOnline } from '@/lib/online';
import type { ConvertMode } from './convert-field-sheet';
import { useFieldKindLabels } from './labels';

export type FieldListProps = {
  fields: readonly ResolvedField[];
  /** The type or place kind being edited: its own fields are `source.typeId === ownerId`. */
  ownerId: string;
  ownerName: string;
  /** A source type's or group's display name. */
  sourceName: (typeId: string) => string;
  /** "shared by TV / display, Phone and Tablet", for a group heading. */
  groupSharedBy?: (groupId: string) => string[];
  canEdit: boolean;
  isOwner: boolean;
  onEdit?: (field: ResolvedField) => void;
  onArchive?: (field: ResolvedField) => void;
  onRestore?: (field: ResolvedField) => void;
  onPolicy?: (field: ResolvedField) => void;
  /** The account owner's conversions (T24); offered only with `isOwner`. */
  onConvert?: (field: ResolvedField, mode: ConvertMode) => void;
  pendingId?: string | null;
  /** What "no fields" means here (a type's things, a place kind's places). */
  emptyText?: ReactNode;
};

type Group = { key: string; heading: ReactNode; fields: ResolvedField[]; editable: boolean };

export function FieldList({
  fields,
  ownerId,
  ownerName,
  sourceName,
  groupSharedBy,
  canEdit,
  isOwner,
  onEdit,
  onArchive,
  onRestore,
  onPolicy,
  onConvert,
  pendingId,
  emptyText,
}: FieldListProps) {
  const { t } = useLingui();
  const online = useOnline();
  const { formatList } = useListFormat();
  const fieldName = useFieldLabel();
  const live = fields.filter((f) => !f.archivedAt);
  const archived = fields.filter((f) => f.archivedAt && f.source.typeId === ownerId);

  const groups: Group[] = [];
  const push = (key: string, heading: ReactNode, f: ResolvedField, editable: boolean) => {
    const g = groups.find((x) => x.key === key);
    if (g) g.fields.push(f);
    else groups.push({ key, heading, fields: [f], editable });
  };
  const inherited = live.filter((f) => f.source.via === 'inherited');
  const own = live.filter((f) => f.source.via === 'own' && f.source.typeId === ownerId);
  const grouped = live.filter((f) => f.source.via === 'group');
  for (const f of inherited) {
    const from = sourceName(f.source.typeId);
    push(`in:${f.source.typeId}`, <Trans>From {from} · inherited</Trans>, f, false);
  }
  for (const f of own) push('own', <bdi>{ownerName}</bdi>, f, true);
  for (const f of grouped) {
    const group = sourceName(f.source.typeId);
    const users = groupSharedBy?.(f.source.typeId) ?? [];
    const shared = formatList(users);
    push(
      `group:${f.source.typeId}`,
      users.length ? (
        <Trans>
          {group} group · shared by {shared}
        </Trans>
      ) : (
        <Trans>{group} group</Trans>
      ),
      f,
      false,
    );
  }

  if (groups.length === 0 && archived.length === 0)
    return (
      <p className="m-0 rounded-[10px] border border-dashed border-line px-4 py-5 text-center text-small text-ink-2">
        {emptyText ?? (
          <Trans>No fields yet. Things of this type have the usual name, photo and place.</Trans>
        )}
      </p>
    );

  return (
    <div className="grid gap-3">
      {groups.map((g) => (
        <FieldGroup
          key={g.key}
          heading={g.heading}
          fields={g.fields}
          note={(f) =>
            f.source.via === 'inherited' ? t`Edit on ${sourceName(f.source.typeId)}` : null
          }
          actions={(f) =>
            g.editable && canEdit ? (
              <>
                {onEdit ? (
                  <Button
                    size="small"
                    variant="ghost"
                    aria-label={t`Edit ${fieldName(f)}`}
                    onPress={() => onEdit(f)}
                  >
                    <Trans>Edit</Trans>
                  </Button>
                ) : null}
                {onArchive ? (
                  <Button
                    size="small"
                    variant="ghost"
                    isPending={pendingId === f.id}
                    aria-label={t`Archive ${fieldName(f)}`}
                    onPress={() => onArchive(f)}
                  >
                    <Trans>Archive</Trans>
                  </Button>
                ) : null}
                {isOwner && onConvert ? (
                  <OverflowActions
                    title={fieldName(f)}
                    isDisabled={!online}
                    actions={conversions(f).map(
                      (mode): OverflowAction => ({
                        id: mode,
                        label:
                          mode === 'secret'
                            ? t`Make secret`
                            : mode === 'plain'
                              ? t`Make plain`
                              : t`Change kind`,
                        onAction: () => onConvert(f, mode),
                      }),
                    )}
                  />
                ) : null}
              </>
            ) : null
          }
          isOwner={isOwner}
          onPolicy={onPolicy}
        />
      ))}
      {archived.length > 0 ? (
        <FieldGroup
          heading={<Trans>Archived fields · values are kept</Trans>}
          fields={archived}
          muted
          note={() => null}
          actions={(f) =>
            canEdit && onRestore ? (
              <Button
                size="small"
                variant="ghost"
                isPending={pendingId === f.id}
                aria-label={t`Restore ${fieldName(f)}`}
                onPress={() => onRestore(f)}
              >
                <Trans>Restore</Trans>
              </Button>
            ) : null
          }
          isOwner={isOwner}
        />
      ) : null}
    </div>
  );
}

/** What a field can become (T1's rules): text ⇄ secret, and the kinds `CONVERSIONS` lists. */
export function conversions(f: Pick<ResolvedField, 'kind' | 'secret'>): ConvertMode[] {
  if (f.secret) return ['plain'];
  return [
    ...(canConvertSecret(f.kind) ? (['secret'] as const) : []),
    ...(CONVERSIONS[f.kind].length ? (['kind'] as const) : []),
  ];
}

function useListFormat() {
  const { i18n } = useLingui();
  return {
    formatList: (items: string[]) =>
      new Intl.ListFormat(i18n.locale, { style: 'long', type: 'conjunction' }).format(items),
  };
}

function FieldGroup({
  heading,
  fields,
  note,
  actions,
  muted = false,
  isOwner,
  onPolicy,
}: {
  heading: ReactNode;
  fields: ResolvedField[];
  note: (f: ResolvedField) => string | null;
  actions: (f: ResolvedField) => ReactNode;
  muted?: boolean;
  isOwner: boolean;
  onPolicy?: ((field: ResolvedField) => void) | undefined;
}) {
  const kinds = useFieldKindLabels();
  const labelOf = useFieldLabel();
  const { t } = useLingui();
  return (
    <section className="grid gap-1">
      <h3 className="eyebrow m-0 px-1">{heading}</h3>
      <ul className="m-0 grid list-none overflow-hidden rounded-[10px] border border-line bg-surface p-0 [&>li+li]:border-t [&>li+li]:border-line">
        {fields.map((f) => {
          const n = note(f);
          const kind = [kinds[f.kind], f.unit ? f.unit : null, f.repeatable ? t`repeatable` : null]
            .filter(Boolean)
            .join(sep());
          return (
            <li
              key={f.id}
              className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5 ${muted ? 'text-ink-3' : ''}`}
            >
              <div className="grid min-w-0 flex-1 basis-48 gap-0.5">
                <div className="flex flex-wrap items-center gap-2 font-semibold text-[15px] leading-snug">
                  {f.secret ? (
                    <span className="inline-flex items-center gap-1 text-ink">
                      <LockIcon className="size-3.5" aria-hidden="true" />
                      <span className="sr-only">
                        <Trans>Secret:</Trans>
                      </span>
                    </span>
                  ) : null}
                  <bdi className="[overflow-wrap:anywhere]">{labelOf(f)}</bdi>
                  {f.required ? (
                    <span className="rounded-full border border-line px-1.5 text-[11.5px] font-medium text-ink-2">
                      <Trans>Required</Trans>
                    </span>
                  ) : null}
                </div>
                <div className="text-small text-ink-2">
                  <span className="font-mono text-[12.5px]">{f.key}</span>
                  {sep()}
                  {f.secret ? <Trans>secret text</Trans> : kind}
                  {f.options?.length ? (
                    <>
                      {sep()}
                      <bdi>{f.options.join(', ')}</bdi>
                    </>
                  ) : null}
                </div>
                {f.secret ? (
                  <div className="text-small text-ink-2">
                    <Trans>Reveal: owner and admins by default · AI: not allowed</Trans>
                  </div>
                ) : null}
                {n ? <div className="text-small text-ink-3">{n}</div> : null}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1">
                {f.secret && isOwner && onPolicy ? (
                  <Button
                    size="small"
                    variant="ghost"
                    aria-label={t`Policy ${labelOf(f)}`}
                    onPress={() => onPolicy(f)}
                  >
                    <Trans>Policy</Trans>
                  </Button>
                ) : null}
                {actions(f)}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
