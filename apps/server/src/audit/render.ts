import { can, canonicalMoney, type Role } from '@kept/shared';
import type { auditEvents } from '../db/schema/index.js';

// renderAudit(): the one renderer every view of the audit goes through: thing history, the
// activity feed, MCP `thing_history`, the undo list (engineering spec §7.5; D110). It applies
// the redaction rules to a stored event for one viewer:
// - secret fields show only that they changed, whatever the stored diff holds;
// - money fields show their values only to a viewer `can(role, 'money.view')` allows, and only
//   while the Money module is on in the event's location (§7.6: serialisers strip gated fields
//   per row's location);
// - D183: a thing's move from (or to) a location the viewer can't see renders with no diff at
//   all, so neither the old household's ids nor its path reach the new one ("moved in from
//   another location"); see crossingOf().
// Later views add their own rules here, not in their own code. D177's contact details need none:
// they are audited as `secret` (plan Q5), so they render as "changed" like any secret.
//
// Custom fields (T27 decision): a diff entry for `custom.<key>` (or `archived_custom.<key>`)
// carries the field's `label` when the caller knows one, or its `labelKey` for a built-in field
// (the web translates it). Labels are names, never values, so every viewer may see them.

export type AuditEventRow = typeof auditEvents.$inferSelect;

export type AuditViewer = {
  /** The viewer's role in the event's location (for an account-level event, `owner`). */
  role: Role;
  /** The location's "viewers may see money" toggle (D13). */
  moneyVisibleToViewers: boolean;
  /** Whether the Money module is on in the event's location. Money is hidden while it is off,
   * whatever the role. Omitted: on (an account-level event has no location to turn it off). */
  moneyModule?: boolean;
  /** The locations the viewer can see (`kept.visible_location_ids()`), for D183. Omitted: only
   * the event's own location, so a move across locations renders without its diff (fail
   * closed). */
  visibleLocationIds?: ReadonlySet<string>;
};

/** A custom field's name as a diff entry carries it: its own label, or a built-in's key. */
export type FieldLabel = { label: string | null; labelKey: string | null };

export type RenderOptions = {
  /** The label of a custom field's diff entry, by field key (`custom.<key>` → `<key>`). */
  labelOf?: (key: string) => FieldLabel | undefined;
};

type Labelled = { label?: string; labelKey?: string };

export type RenderedChange = (
  | { before: unknown; after: unknown; class: 'plain' | 'money' }
  | { changed: true; class: 'money'; hidden: true }
  | { changed: true; class: 'secret' }
) &
  Labelled;

export type RenderedAuditEvent = {
  id: string;
  at: string;
  location_id: string | null;
  action: string;
  actor: { type: string; id: string | null };
  entity: { type: string; id: string | null };
  root_thing_id: string | null;
  diff: Record<string, RenderedChange> | null;
  undo_of: string | null;
  undoable_until: string | null;
  /** A `thing.move` arriving from a location the viewer can't see (D183), shown with no diff. */
  movedInFromElsewhere?: true;
};

type StoredLike = { class?: unknown; before?: unknown; after?: unknown };

function renderChange(change: StoredLike, showMoney: boolean): RenderedChange {
  if (change.class === 'plain') {
    return { before: change.before ?? null, after: change.after ?? null, class: 'plain' };
  }
  if (change.class === 'money') {
    return showMoney
      ? {
          // The one wire form (`"350"`, not numeric's `"350.0000"`), as every money output.
          before: canonicalMoney(change.before ?? null),
          after: canonicalMoney(change.after ?? null),
          class: 'money',
        }
      : { changed: true, class: 'money', hidden: true };
  }
  // 'secret', and anything unrecognised: fail closed.
  return { changed: true, class: 'secret' };
}

const CUSTOM_PREFIXES = ['custom.', 'archived_custom.'] as const;

/** `<key>` of a `custom.<key>` or `archived_custom.<key>` diff entry; null for any other. */
export function customKeyOf(field: string): string | null {
  for (const prefix of CUSTOM_PREFIXES) {
    if (field.startsWith(prefix) && field.length > prefix.length) return field.slice(prefix.length);
  }
  return null;
}

function withLabel(
  change: RenderedChange,
  field: string,
  labelOf: RenderOptions['labelOf'],
): RenderedChange {
  const key = labelOf ? customKeyOf(field) : null;
  if (!key || !labelOf) return change;
  const found = labelOf(key);
  if (found?.label) return { ...change, label: found.label };
  if (found?.labelKey) return { ...change, labelKey: found.labelKey };
  return change;
}

/**
 * Whether `event` is a thing's move across locations one end of which the viewer can't see
 * (D183): `in` when it arrived from such a location, `out` when it left for one; null for
 * anything else, including a cross-location move the viewer sees both ends of.
 */
export function crossingOf(
  event: Pick<AuditEventRow, 'action' | 'locationId' | 'diff'>,
  visibleLocationIds?: ReadonlySet<string>,
): 'in' | 'out' | null {
  if (event.action !== 'thing.move' || !event.diff || typeof event.diff !== 'object') return null;
  const change = (event.diff as Record<string, StoredLike>).location_id;
  if (!change || typeof change !== 'object') return null;
  const before = typeof change.before === 'string' ? change.before : null;
  const after = typeof change.after === 'string' ? change.after : null;
  if (!before || !after || before === after) return null;
  const sees = (id: string) => id === event.locationId || (visibleLocationIds?.has(id) ?? false);
  if (!sees(before)) return 'in';
  if (!sees(after)) return 'out';
  return null;
}

export function renderAudit(
  event: AuditEventRow,
  viewer: AuditViewer,
  opts: RenderOptions = {},
): RenderedAuditEvent {
  const showMoney =
    viewer.moneyModule !== false &&
    can(viewer.role, 'money.view', { moneyVisibleToViewers: viewer.moneyVisibleToViewers });
  const crossing = crossingOf(event, viewer.visibleLocationIds);
  let diff: Record<string, RenderedChange> | null = null;
  if (!crossing && event.diff && typeof event.diff === 'object') {
    diff = {};
    for (const [field, change] of Object.entries(event.diff as Record<string, StoredLike>)) {
      diff[field] = withLabel(renderChange(change ?? {}, showMoney), field, opts.labelOf);
    }
  }
  return {
    id: event.id,
    at: event.at.toISOString(),
    location_id: event.locationId,
    action: event.action,
    actor: { type: event.actorType, id: event.actorId },
    entity: { type: event.entityType, id: event.entityId },
    root_thing_id: event.rootThingId,
    diff,
    undo_of: event.undoOf,
    undoable_until: event.undoableUntil ? event.undoableUntil.toISOString() : null,
    ...(crossing === 'in' ? { movedInFromElsewhere: true as const } : {}),
  };
}
