import type { RenderedAuditEvent } from '../audit/render.js';

// One line per history or activity row (plan T21; T27 decision): a structured `summaryKey` with
// `summaryParams` that the web localises, and `summary`, the same sentence in English, as the
// fallback. It is built from the *rendered* event, after renderAudit() has redacted it, so it
// can never say more than the row it sits on: money and secrets never reach the params (the
// only diff values read are the name, the lifecycle and a stock use's service ids, all plain),
// and a move from a location the viewer can't see has no diff to read at all (D183).
//
// Params are data, never English: names as stored, and codes (`lifecycle: 'given_away'`) the web
// localises. Keys are `<entity>.<verb>` in the audit's own vocabulary, with three refinements the action
// alone doesn't say: `thing.move.in` / `thing.move.out` (a move across the edge of what the
// viewer can see), `<entity>.restore` for an undone trash, and `undo` for any other undo.
// Anything without a sentence of its own gets `event` with `{action}`.

export type SummaryParams = Record<string, string>;
export type Summary = { summaryKey: string; summaryParams: SummaryParams; summary: string };

/** What the summary needs beyond the rendered event. */
export type SummaryContext = {
  /** The current name of what the event is about (the thing, the place, the registry row), or
   * null when the viewer can't see it any more. */
  name: string | null;
  /** The event is a move out to a location the viewer can't see (crossingOf() = 'out'). */
  movedOut?: boolean;
  /** A `thing.stock_use` (D236): the current name of the thing or place the service was for. */
  service?: string | null;
};

type Sentence = (p: SummaryParams) => string;

/** English for every key with a sentence of its own. `{name}` is always set (a fallback noun
 * when the name is unknown). */
const ENGLISH: Record<string, Sentence> = {
  'thing.create': (p) => `Added ${p.name}`,
  'thing.update': (p) => `Edited ${p.name}`,
  'thing.retype': (p) => `Changed the type of ${p.name}`,
  'thing.lifecycle': (p) =>
    p.lifecycle ? `Marked ${p.name} as ${words(p.lifecycle)}` : `Changed the status of ${p.name}`,
  'thing.move': (p) => `Moved ${p.name}`,
  'thing.move.in': () => 'Moved in from another location',
  'thing.move.out': (p) => `Moved ${p.name} to another location`,
  'thing.trash': (p) => `Trashed ${p.name}`,
  'thing.restore': (p) => `Restored ${p.name}`,
  'thing.delete': (p) => `Deleted ${p.name} for good`,
  'thing.seen': (p) => `Saw ${p.name}`,
  'thing.not_here': (p) => `Marked ${p.name} as not here`,
  'thing.split': (p) => `Split ${p.name}`,
  'thing.duplicate': (p) => `Duplicated ${p.name}`,
  'thing.link': (p) => `Linked ${p.name}`,
  'thing.unlink': (p) => `Unlinked ${p.name}`,
  'thing.convert_to_place': (p) => `Turned ${p.name} into a place`,
  'thing.codes': (p) => `Changed the codes of ${p.name}`,
  'place.create': (p) => `Added ${p.name}`,
  'place.update': (p) => `Edited ${p.name}`,
  'place.move': (p) => `Moved ${p.name}`,
  'place.trash': (p) => `Trashed ${p.name}`,
  'place.restore': (p) => `Restored ${p.name}`,
  'place.delete': (p) => `Deleted ${p.name} for good`,
  'place.merge': (p) => `Merged ${p.name} into another place`,
  'place.convert_to_container': (p) => `Turned ${p.name} into a container`,
  'place.label': (p) => `Labelled ${p.name}`,
  'place.codes': (p) => `Changed the codes of ${p.name}`,
  // D236: a service line took the consumable off the shelf, or gave it back.
  'thing.stock_use': (p) => `Used ${p.name} in a service of ${p.service}`,
  'thing.stock_return': (p) => `Put ${p.name} back from a service of ${p.service}`,
  'attachment.create': (p) => `Attached a file to ${p.name}`,
  'attachment.update': (p) => `Changed a file on ${p.name}`,
  'attachment.delete': (p) => `Removed a file from ${p.name}`,
  undo: (p) => `Undid a change to ${p.name}`,
  event: (p) => fallback(p.action ?? ''),
};

const PAST: Record<string, string> = {
  create: 'added',
  update: 'changed',
  delete: 'deleted',
  merge: 'merged',
  customise: 'customised',
  archive: 'archived',
  restore: 'restored',
  trash: 'trashed',
  revoke: 'revoked',
  join: 'joined',
  leave: 'left',
  expire: 'expired',
  upload: 'uploaded',
  reveal: 'revealed',
};

/** "Brand added", "Member joined": the English for an action with no sentence of its own. */
function fallback(action: string): string {
  const dot = action.indexOf('.');
  const entity = words(dot < 0 ? action : action.slice(0, dot));
  const verb = dot < 0 ? '' : action.slice(dot + 1);
  const said = PAST[verb] ?? (verb ? `${words(verb)}` : 'changed');
  const subject = entity ? entity[0]?.toUpperCase() + entity.slice(1) : 'Something';
  return `${subject} ${said}`;
}

/** The noun for something whose name the viewer can't see (or that has none). */
const NOUNS: Record<string, string> = {
  thing: 'a thing',
  place: 'a place',
  attachment: 'a thing',
  type: 'a type',
  type_field: 'a field',
  place_kind: 'a place kind',
  brand: 'a brand',
  vendor: 'a vendor',
  person: 'a person',
  tag: 'a tag',
  location: 'the location',
};

const words = (value: string) => value.replaceAll('_', ' ');

type Plain = { before: unknown; after: unknown; class: 'plain' };

function plainOf(event: RenderedAuditEvent, field: string): Plain | null {
  const change = event.diff?.[field];
  return change && change.class === 'plain' && 'before' in change ? (change as Plain) : null;
}

/** The key of an event: its action, refined as the header says. */
function keyOf(event: RenderedAuditEvent, ctx: SummaryContext): string {
  const { action } = event;
  if (event.movedInFromElsewhere) return 'thing.move.in';
  if (action === 'thing.move' && ctx.movedOut) return 'thing.move.out';
  const [entity] = action.split('.');
  // An undone trash writes the trash action again, with deleted_at going back to null.
  if (action.endsWith('.trash') && event.undo_of) {
    const deleted = plainOf(event, 'deleted_at');
    if (deleted && deleted.after === null) return `${entity}.restore`;
  }
  if (event.undo_of) return 'undo';
  // D236: the stock went back up (the line shrank or went, the service was deleted or undone).
  if (action === 'thing.stock_use') {
    const q = plainOf(event, 'quantity');
    if (q && Number(q.after) > Number(q.before)) return 'thing.stock_return';
  }
  return ENGLISH[action] ? action : 'event';
}

export function summarise(event: RenderedAuditEvent, ctx: SummaryContext): Summary {
  const key = keyOf(event, ctx);
  const params: SummaryParams = {};
  if (key === 'event') {
    params.action = event.action;
  } else if (key !== 'thing.move.in') {
    const entity = event.entity.type;
    const fromDiff = plainOf(event, 'name');
    const diffName = [fromDiff?.after, fromDiff?.before].find(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );
    params.name = ctx.name ?? diffName ?? NOUNS[entity] ?? 'something';
    if (key === 'thing.stock_use' || key === 'thing.stock_return') {
      // The service's subject: its name (a noun when the reader can't see it), and its id for the
      // link, read from the rendered diff (plain ids, never money).
      const thing = plainOf(event, 'service_thing_id')?.after;
      const place = plainOf(event, 'service_place_id')?.after;
      params.service = ctx.service ?? (typeof place === 'string' ? 'a place' : 'a thing');
      if (typeof thing === 'string') params.serviceThingId = thing;
      else if (typeof place === 'string') params.servicePlaceId = place;
    }
    if (key === 'thing.lifecycle') {
      // The stored code (`given_away`), never English: the web says it in the reader's language.
      // Left out when the row shows no lifecycle change.
      const lifecycle = plainOf(event, 'lifecycle')?.after;
      if (typeof lifecycle === 'string') params.lifecycle = lifecycle;
    }
  }
  const sentence = ENGLISH[key] ?? ENGLISH.event;
  return { summaryKey: key, summaryParams: params, summary: (sentence as Sentence)(params) };
}
